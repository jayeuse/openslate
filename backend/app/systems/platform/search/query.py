"""Scoped PostgreSQL full-text search over displayed content only."""

from typing import Any, cast

from sqlalchemy import Select, String, and_, case, column, func, literal, or_, select, text, true
from sqlalchemy import cast as sql_cast
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.sql.selectable import Subquery

from app.common.listing import ListQuerySpec, PaginationMetadata, build_standard_list_statements
from app.core.base_model import utc_now
from app.systems.access.identity.eligibility import identity_eligible_clause
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import module_reader_statement
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.boards.access import managed_board_clause, visible_board_clause
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.post_listing import display_join
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_service import published_expiry
from app.systems.platform.search.schemas import (
    SearchItem,
    SearchKind,
    SearchRequest,
    SearchResponse,
    SearchSort,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.display import UNAVAILABLE_OPTION
from app.systems.sandbox.records.models import Record

# Fixed read-only SQL over the scoped record_values alias, never client SQL.
# Number::toString chooses the shortest decimal in the binary64 rounding interval,
# then the nearest/even candidate. PostgreSQL float text excludes exact midpoints,
# so decode float8send bytes instead. Materialized stages evaluate once per row.
_NUMERIC_TITLE_SQL = """
WITH number_input AS MATERIALIZED (
    SELECT record_values.raw::numeric AS original
    WHERE record_values.kind IN ('number', 'int') AND record_values.value_type = 'number'
), number_magnitude AS MATERIALIZED (
    SELECT original < 0 AS negative,
        CASE
            WHEN abs(original) >= power(2::numeric, 1024) - power(2::numeric, 970) THEN NULL
            WHEN abs(original) <= (power(5::numeric, 1075)::text || 'e-1075')::numeric THEN 0
            ELSE abs(original)
        END AS magnitude
    FROM number_input
), number_bytes AS MATERIALIZED (
    SELECT float8send(magnitude::float8) AS bytes FROM number_magnitude WHERE magnitude > 0
), number_bits AS MATERIALIZED (
    SELECT get_byte(bytes, 0) * 16 + (get_byte(bytes, 1) >> 4) AS stored_exponent,
        (get_byte(bytes, 1) & 15)::bigint * 281474976710656
        + get_byte(bytes, 2)::bigint * 1099511627776
        + get_byte(bytes, 3)::bigint * 4294967296
        + get_byte(bytes, 4)::bigint * 16777216
        + get_byte(bytes, 5)::bigint * 65536
        + get_byte(bytes, 6)::bigint * 256 + get_byte(bytes, 7) AS fraction
    FROM number_bytes
), number_binary AS MATERIALIZED (
    SELECT (fraction + CASE WHEN stored_exponent = 0 THEN 0 ELSE 4503599627370496 END)::numeric
        AS m,
        CASE WHEN stored_exponent = 0 THEN -1074 ELSE stored_exponent - 1075 END AS e,
        CASE WHEN fraction <> 0 OR stored_exponent <= 1 THEN 1 ELSE 0 END AS lower_shift
    FROM number_bits
), number_exact AS MATERIALIZED (
    SELECT m % 2 = 0 AS inclusive,
        CASE WHEN e >= 0 THEN m * power(2::numeric, e)
            ELSE ((m * power(5::numeric, -e))::text || 'e' || e::text)::numeric END AS exact_value,
        CASE WHEN e >= 2 THEN (4*m - 1 - lower_shift) * power(2::numeric, e-2)
            ELSE (((4*m - 1 - lower_shift) * power(5::numeric, 2-e))::text
                || 'e' || (e-2)::text)::numeric END AS lower_value,
        CASE WHEN e >= 2 THEN (4*m + 2) * power(2::numeric, e-2)
            ELSE (((4*m + 2) * power(5::numeric, 2-e))::text
                || 'e' || (e-2)::text)::numeric END AS upper_value
    FROM number_binary
), number_order AS MATERIALIZED (
    SELECT *, CASE WHEN exact_value >= 1 THEN length(split_part(exact_value::text, '.', 1))-1
        ELSE length(ltrim(split_part(exact_value::text, '.', 2), '0'))
            - length(split_part(exact_value::text, '.', 2))-1 END AS q
    FROM number_exact
), number_scale AS MATERIALIZED (
    SELECT *, k-1-q AS scale,
        (exact_value::text || 'e' || (k-1-q)::text)::numeric AS scaled
    FROM number_order CROSS JOIN generate_series(1, 17) AS k
), number_choices AS MATERIALIZED (
    SELECT *, rtrim(n::text, '0') AS digits, length(n::text)-scale-1 AS exponent,
        (n::text || 'e' || (-scale)::text)::numeric AS candidate
    FROM number_scale CROSS JOIN LATERAL (VALUES (floor(scaled)), (ceil(scaled))) AS choices(n)
    WHERE n > 0
), number_best AS MATERIALIZED (
    SELECT digits, exponent FROM number_choices
    WHERE (candidate > lower_value OR (inclusive AND candidate = lower_value))
        AND (candidate < upper_value OR (inclusive AND candidate = upper_value))
    ORDER BY length(digits), abs(candidate-exact_value), right(digits, 1)::int % 2, candidate
    LIMIT 1
)
SELECT CASE
    WHEN magnitude IS NULL THEN NULL
    WHEN magnitude = 0 THEN '0'
    ELSE CASE WHEN negative THEN '-' ELSE '' END ||
        CASE WHEN exponent BETWEEN -6 AND 20 THEN
            CASE WHEN exponent < 0 THEN '0.' || repeat('0', -exponent-1) || digits
                WHEN exponent+1 >= length(digits)
                    THEN digits || repeat('0', exponent+1-length(digits))
                ELSE left(digits, exponent+1) || '.' || substr(digits, exponent+2) END
            ELSE left(digits, 1)
                || CASE WHEN length(digits) > 1 THEN '.' || substr(digits, 2) ELSE '' END
                || 'e' || CASE WHEN exponent >= 0 THEN '+' ELSE '' END || exponent::text
        END
    END AS title
FROM number_magnitude LEFT JOIN number_best ON true
"""


def _live_modules(db: Session, actor: User) -> Select[tuple[Any]]:
    return (
        select(Module.id)
        .join(Department, Department.id == Module.department_id)
        .where(
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
            Department.is_deleted.is_(False),
            Department.deleted_at.is_(None),
            module_filter(db, actor, AccessLevel.READ, Module.id),
        )
    )


def _record_title(source: Subquery, numeric_title: ColumnElement[str]) -> ColumnElement[str]:
    value = source.c.raw
    options = source.c.title_config["options"]
    option_rows = (
        func.jsonb_array_elements(
            case(
                (func.jsonb_typeof(options) == "array", options),
                else_=sql_cast(literal("[]"), JSONB),
            )
        )
        .table_valued(column("value", JSONB), with_ordinality="ordinality")
        .render_derived()
    )
    selected_label = (
        select(option_rows.c.value["label"].astext)
        .where(
            func.jsonb_typeof(option_rows.c.value["id"]) == "string",
            func.jsonb_typeof(option_rows.c.value["label"]) == "string",
            option_rows.c.value["id"].astext == value,
        )
        .order_by(option_rows.c.ordinality.desc())
        .limit(1)
        .correlate(source)
        .scalar_subquery()
    )
    label = case(
        (source.c.kind == FieldType.SELECT.value, selected_label),
        (
            and_(source.c.kind.in_(("number", "int")), source.c.value_type == "number"),
            numeric_title,
        ),
        else_=value,
    )
    fallback = literal("Record ") + func.left(sql_cast(source.c.id, String), 8)
    return cast(
        ColumnElement[str],
        case(
            (
                or_(
                    label.is_(None),
                    label == UNAVAILABLE_OPTION,
                    func.regexp_replace(label, r"^\s+|\s+$", "", "g") == "",
                ),
                fallback,
            ),
            else_=label,
        ),
    )


def _records(db: Session, actor: User) -> Subquery:
    permitted_types = (
        FieldType.TEXT,
        FieldType.LONG_TEXT,
        FieldType.EMAIL,
        FieldType.URL,
        FieldType.INTEGER,
        FieldType.NUMBER,
        FieldType.DECIMAL,
        FieldType.SELECT,
    )
    raw = Record.data[sql_cast(Field.id, String)]
    source = (
        select(
            Record.id.label("id"),
            raw.astext.label("raw"),
            func.jsonb_typeof(raw).label("value_type"),
            Field.type.label("kind"),
            Field.config.label("title_config"),
            Module.module_name.label("context_label"),
            Module.id.label("module_id"),
            literal(None).label("board_id"),
            literal(True).label("can_open"),
        )
        .join(Module, Module.id == Record.module_id)
        .outerjoin(
            Field,
            and_(
                Field.id == Module.title_field_id,
                Field.module_id == Module.id,
                Field.is_deleted.is_(False),
                Field.type.in_(permitted_types),
            ),
        )
        .where(
            Record.is_deleted.is_(False),
            Record.deleted_at.is_(None),
            Module.id.in_(_live_modules(db, actor)),
        )
        .subquery("record_values")
    )
    numeric_title = text(_NUMERIC_TITLE_SQL).columns(title=String).lateral("numeric_title")
    titles = (
        select(
            source.c.id,
            _record_title(source, numeric_title.c.title).label("title"),
            source.c.context_label,
            source.c.module_id,
            source.c.board_id,
            source.c.can_open,
        )
        .select_from(source.outerjoin(numeric_title, true()))
        .cte("record_titles")
        .prefix_with("MATERIALIZED")
    )
    return select(titles, titles.c.title.label("search_text")).subquery()


def _people(db: Session, actor: User) -> Subquery:
    administrator = sole_active_membership(db, actor.id).role == UserRole.ADMIN.value
    title = func.coalesce(func.nullif(User.display_name, ""), User.username)
    statement = select(
        User.id.label("id"),
        title.label("title"),
        User.username.label("context_label"),
        literal(None).label("module_id"),
        literal(None).label("board_id"),
        literal(administrator).label("can_open"),
        func.concat_ws(" ", User.display_name, User.username).label("search_text"),
    ).join(Membership, Membership.user_id == User.id).where(
        User.status == UserStatus.ACTIVE.value,
        Membership.status == UserStatus.ACTIVE.value,
        established_user_clause(),
        identity_eligible_clause(),
    )
    if not administrator:
        statement = statement.where(User.id.in_(module_reader_statement(_live_modules(db, actor))))
    return statement.subquery()


def _visible_board(db: Session, actor: User) -> ColumnElement[bool]:
    return and_(
        Board.is_deleted.is_(False),
        Board.deleted_at.is_(None),
        Board.status == BoardStatus.ACTIVE.value,
        visible_board_clause(db, actor),
    )


def _posts(db: Session, actor: User) -> Subquery:
    return (
        select(
            BoardPost.id.label("id"),
            BoardPostRevision.title.label("title"),
            Board.name.label("context_label"),
            literal(None).label("module_id"),
            Board.id.label("board_id"),
            literal(True).label("can_open"),
            func.concat_ws(" ", BoardPostRevision.title, BoardPostRevision.body).label(
                "search_text"
            ),
        )
        .join(Board, Board.id == BoardPost.board_id)
        .join(BoardPostRevision, display_join())
        .where(
            _visible_board(db, actor),
            BoardPost.is_deleted.is_(False),
            BoardPost.deleted_at.is_(None),
            BoardPost.status != "archived",
            or_(published_expiry(actor, False, utc_now()), managed_board_clause(db, actor)),
        )
        .subquery()
    )


def _events(db: Session, actor: User) -> Subquery:
    return (
        select(
            BoardEvent.id.label("id"),
            BoardEvent.title.label("title"),
            Board.name.label("context_label"),
            literal(None).label("module_id"),
            Board.id.label("board_id"),
            literal(True).label("can_open"),
            func.concat_ws(" ", BoardEvent.title, BoardEvent.details, BoardEvent.location).label(
                "search_text"
            ),
        )
        .join(Board, Board.id == BoardEvent.board_id)
        .where(
            _visible_board(db, actor),
            BoardEvent.is_deleted.is_(False),
            BoardEvent.deleted_at.is_(None),
            BoardEvent.archived.is_(False),
        )
        .subquery()
    )


def search_content(db: Session, actor: User, params: SearchRequest) -> SearchResponse:
    match params.kind:
        case SearchKind.RECORD:
            candidates = _records(db, actor)
        case SearchKind.PERSON:
            candidates = _people(db, actor)
        case SearchKind.POST:
            candidates = _posts(db, actor)
        case SearchKind.EVENT:
            candidates = _events(db, actor)
    vector = func.to_tsvector("simple", candidates.c.search_text)
    query = func.plainto_tsquery("simple", params.search)
    statement = select(
        candidates.c.id,
        candidates.c.title,
        candidates.c.context_label,
        candidates.c.module_id,
        candidates.c.board_id,
        candidates.c.can_open,
    ).where(vector.op("@@")(query))
    spec = ListQuerySpec(
        sort_fields={SearchSort.RELEVANCE: func.ts_rank(vector, query)},
        default_sort=SearchSort.RELEVANCE,
        tie_breaker=candidates.c.id,
    )
    # FTS is already applied. Only clear the builder's generic ILIKE input;
    # preserve its deleted validation, allowed ordering, tie-breaker and paging.
    page_statement, count_statement = build_standard_list_statements(
        cast(Select[tuple[Any]], statement),
        params.model_copy(update={"search": None}),
        spec,
    )
    total = int(db.scalar(count_statement) or 0)
    items = [
        SearchItem.model_validate({**dict(row), "kind": params.kind})
        for row in db.execute(page_statement).mappings()
    ]
    return SearchResponse(
        items=items,
        pagination=PaginationMetadata(
            limit=params.limit,
            offset=params.offset,
            count=len(items),
            total=total,
            has_more=params.offset + len(items) < total,
        ),
    )
