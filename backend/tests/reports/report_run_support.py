"""Private immutable Report runs on runner-owned, committed PostgreSQL data."""

import os
from collections.abc import Generator
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, bindparam, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.systems.access.identity.provider_sessions import admit_provider_session
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.models import Report
from app.systems.openview.reports.router import router
from app.systems.openview.reports.schemas import ReportRecipe
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query_router import router as record_query_router
from tests.conftest import _guard_integration_database, create_member, guarded_create_engine
from tests.fake_provider_support import install_fake_provider, real_session_pool
from tests.rbac.support import add_user, make_group_access, organization

pytestmark = pytest.mark.integration


@dataclass
class _RunFixture:
    client: TestClient
    owner_engine: Engine
    runtime_engine: Engine
    owner_id: UUID
    outsider_id: UUID
    guest_id: UUID
    owner_token: str
    outsider_token: str
    guest_token: str
    report_id: UUID
    module_id: UUID
    note_field_id: UUID
    first_record_id: UUID

    def headers(self, token: str | None = None, *, key: UUID | None = None) -> dict[str, str]:
        values = {"Authorization": f"Bearer {token or self.owner_token}"}
        if key is not None:
            values["Idempotency-Key"] = str(key)
        return values


@pytest.fixture
def report_run_fixture(request: pytest.FixtureRequest) -> Generator[_RunFixture, None, None]:
    owner_url = os.environ["MIGRATION_DATABASE_URL"]
    runtime_url = os.environ["TEST_DATABASE_URL"]
    _guard_integration_database(owner_url)
    _guard_integration_database(runtime_url)
    owner_engine = guarded_create_engine(owner_url)
    runtime_engine = guarded_create_engine(runtime_url)
    owner_id, outsider_id, guest_id = uuid7(), uuid7(), uuid7()
    actor_ids = (owner_id, outsider_id, guest_id)
    group_id, owner_access_id = uuid7(), uuid7()
    department_id, module_id, report_id = uuid7(), uuid7(), uuid7()
    category_id, note_id, amount_id = uuid7(), uuid7(), uuid7()
    record_ids = (uuid7(), uuid7(), uuid7(), uuid7())
    all_ids = [
        *actor_ids,
        group_id,
        owner_access_id,
        department_id,
        module_id,
        report_id,
        category_id,
        note_id,
        amount_id,
        *record_ids,
    ]
    client: TestClient | None = None
    resources = ExitStack()
    provider = get_supabase_auth_client()
    identities = []
    org_id = None
    try:
        # Report runs are the subject, not Supabase Auth: the three actors sign in against
        # the fake provider, and OpenSlate's real admission issues their sessions.
        fake = install_fake_provider(
            resources.enter_context(pytest.MonkeyPatch.context()), real_session_pool(request.config)
        )
        for actor_id in actor_ids:
            email = f"report-run-{actor_id.hex}@example.test"
            password = token_urlsafe(32)
            identities.append((fake.add(email, password), email, password))
        with AuditSession(owner_engine) as setup:
            setup.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_id=uuid7(),
                request_method="POST",
                request_path="/api/reports/run-fixture",
            )
            # The owner and the outsider are members who manage the module through one
            # group; the third actor is a guest in that group, so it only reads.
            guest_expiry = datetime.now(UTC) + timedelta(days=30)
            org = organization(setup)
            org_id = org.id
            users = [
                create_member(setup, org,
                    id=actor_id,
                    email=f"report-run-{actor_id.hex}@example.test",
                    username=f"report_run_{actor_id.hex[:16]}",
                    status=UserStatus.ACTIVE.value,
                    role=role,
                    supabase_user_id=identity[0],
                    sponsor_user_id=owner_id if role == "guest" else None,
                    expires_at=guest_expiry if role == "guest" else None,
                )[0]
                for actor_id, role, identity in zip(
                    actor_ids, ("member", "member", "guest"), identities, strict=True
                )
            ]
            setup.add(users[0])
            setup.flush()
            setup.add_all(users[1:])
            setup.flush()
            setup.add(Department(org_id=org_id, id=department_id,
                                 department_name=f"Report run {uuid7().hex}"))
            setup.flush()
            setup.add(
                Module(
                    org_id=org_id,
                    id=module_id,
                    department_id=department_id,
                    module_name=f"Report run {uuid7().hex}",
                )
            )
            setup.flush()
            setup.add(Group(org_id=org_id, id=group_id, name=f"Report run {group_id.hex}"))
            setup.flush()
            setup.add_all(
                GroupMember(org_id=org_id, group_id=group_id, user_id=actor_id)
                for actor_id in actor_ids
            )
            setup.add(
                GroupAccess(
                    org_id=org_id,
                    id=owner_access_id,
                    group_id=group_id,
                    department_id=department_id,
                    module_id=module_id,
                    level=AccessLevel.MANAGE.value,
                )
            )
            setup.flush()
            fields = [
                Field(
                    org_id=org_id,
                    id=field_id,
                    module_id=module_id,
                    name=name,
                    type=field_type,
                    required=False,
                    position=position,
                    config={},
                )
                for position, (field_id, name, field_type) in enumerate(
                    (
                        (category_id, "Category", FieldType.TEXT),
                        (note_id, "Note", FieldType.TEXT),
                        (amount_id, "Amount", FieldType.DECIMAL),
                    )
                )
            ]
            setup.add_all(fields)
            setup.flush()

            def reference(field: Field) -> dict[str, str]:
                return {
                    "field_id": str(field.id),
                    "expected_type": str(field.type),
                }

            recipe = ReportRecipe.model_validate(
                {
                    "fields": [reference(field) for field in fields],
                    "filters": [{**reference(fields[2]), "operator": "gt", "value": "1"}],
                    "sorts": [{**reference(fields[2]), "direction": "desc"}],
                    "group_by": reference(fields[0]),
                    "include_row_count": True,
                }
            )
            setup.add(
                Report(
                    org_id=org_id,
                    id=report_id,
                    module_id=module_id,
                    name="Operations snapshot",
                    recipe=recipe.model_dump(mode="json"),
                )
            )
            source_values = (
                ("Alpha", "=SUM(1,1)", "1.25"),
                ("Alpha", "ordinary", "9007199254740993"),
                ("Beta", "completed", "2.5"),
                ("Beta", "excluded", "0"),
            )
            setup.add_all(
                Record(
                    org_id=org_id,
                    id=record_id,
                    module_id=module_id,
                    data={
                        str(category_id): category,
                        str(note_id): note,
                        str(amount_id): amount,
                    },
                )
                for record_id, (category, note, amount) in zip(
                    record_ids, source_values, strict=True
                )
            )
            setup.commit()

        access_tokens = []
        for _provider_id, email, password in identities:
            tokens = provider.password_grant(email, password)
            with AuditSession(runtime_engine) as admission:
                issued = admit_provider_session(admission, tokens, provider)
                admission.commit()
                all_ids.append(issued.session_id)
                access_tokens.append(issued.access_token)

        application = FastAPI()
        application.include_router(router, prefix="/api")
        application.include_router(record_query_router, prefix="/api")

        def database(request: Request) -> Generator[Session, None, None]:
            with AuditSession(runtime_engine) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_id=uuid7(),
                    request_method=request.method,
                    request_path=request.url.path,
                )
                yield db

        application.dependency_overrides[get_db] = database
        client = TestClient(application)
        with client:
            yield _RunFixture(
                client=client,
                owner_engine=owner_engine,
                runtime_engine=runtime_engine,
                owner_id=owner_id,
                outsider_id=outsider_id,
                guest_id=guest_id,
                owner_token=access_tokens[0],
                outsider_token=access_tokens[1],
                guest_token=access_tokens[2],
                report_id=report_id,
                module_id=module_id,
                note_field_id=note_id,
                first_record_id=record_ids[0],
            )
    finally:
        resources.close()
        if client is not None:
            client.close()
        with owner_engine.begin() as cleanup:
            for table in (
                "lifecycle_confirmation_challenges",
                "lifecycle_rate_limit_failures",
                "lifecycle_rate_limit_buckets",
            ):
                cleanup.execute(
                    text(f"DELETE FROM public.{table} WHERE actor_id IN :ids").bindparams(
                        bindparam("ids", expanding=True)
                    ),
                    {"ids": list(actor_ids)},
                )
            cleanup.execute(
                text(
                    "DELETE FROM public.audit_logs "
                    "WHERE performed_by IN :actors OR entity_id IN :all_ids OR org_id = :org_id"
                ).bindparams(
                    bindparam("actors", expanding=True),
                    bindparam("all_ids", expanding=True),
                ),
                {"actors": list(actor_ids), "all_ids": all_ids, "org_id": org_id},
            )
            cleanup.execute(
                text(
                    "DELETE FROM public.report_run_eligible_users WHERE run_id IN "
                    "(SELECT id FROM public.report_runs WHERE report_id = :report_id)"
                ),
                {"report_id": report_id},
            )
            cleanup.execute(
                text(
                    "DELETE FROM public.report_run_rows WHERE run_id IN "
                    "(SELECT id FROM public.report_runs WHERE report_id = :report_id)"
                ),
                {"report_id": report_id},
            )
            for table, condition, values in (
                ("report_runs", "report_id = :id", {"id": report_id}),
                ("reports", "id = :id", {"id": report_id}),
                ("records", "module_id = :id", {"id": module_id}),
                ("fields", "module_id = :id", {"id": module_id}),
                ("group_access", "group_id = :id", {"id": group_id}),
                ("group_members", "group_id = :id", {"id": group_id}),
                ("groups", "id = :id", {"id": group_id}),
                ("modules", "id = :id", {"id": module_id}),
                ("departments", "id = :id", {"id": department_id}),
            ):
                cleanup.execute(text(f"DELETE FROM public.{table} WHERE {condition}"), values)
            cleanup.execute(
                text("DELETE FROM public.identity_sessions WHERE user_id IN :ids").bindparams(
                    bindparam("ids", expanding=True)
                ),
                {"ids": list(actor_ids)},
            )
            cleanup.execute(
                text("DELETE FROM public.memberships WHERE user_id IN :ids").bindparams(
                    bindparam("ids", expanding=True)
                ),
                {"ids": list(actor_ids)},
            )
            cleanup.execute(
                text("DELETE FROM public.users WHERE id IN :ids AND id <> :owner").bindparams(
                    bindparam("ids", expanding=True)
                ),
                {"ids": list(actor_ids), "owner": owner_id},
            )
            cleanup.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": owner_id})
            cleanup.execute(
                text("DELETE FROM public.organizations WHERE id = :id"), {"id": org_id}
            )
        owner_engine.dispose()
        runtime_engine.dispose()


_ACTORS_KEY = "report_test_actors"


def report_route_actor(
    db: Session, *, level: str | None = AccessLevel.MANAGE, role: str = "member"
) -> User:
    """A user who gets ``level`` on every module that :func:`report_route_module` creates later."""

    user = add_user(db, "report", role=role)
    if level is not None:
        db.info.setdefault(_ACTORS_KEY, []).append((user, level))
    return user


def report_route_client(db: Session, user: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def report_route_module(db: Session, *, active: bool = True) -> tuple[Module, Field]:
    department = Department(org_id=organization(db).id, department_name=f"Report source {uuid7()}")
    db.add(department)
    db.flush()
    module = Module(
        org_id=department.org_id,
        department_id=department.id,
        module_name=f"Report source {uuid7()}",
        is_deleted=not active,
        deleted_at=None if active else datetime.now(UTC),
    )
    db.add(module)
    db.flush()
    field = Field(
        org_id=module.org_id,
        module_id=module.id,
        name="Category",
        type=FieldType.TEXT,
        required=False,
        position=0,
        config={},
    )
    db.add(field)
    db.flush()
    for actor, level in db.info.get(_ACTORS_KEY, []):
        make_group_access(db, [actor], department, module, level=level)
    return module, field


def report_route_recipe(field: Field) -> dict[str, object]:
    reference = {"field_id": str(field.id), "expected_type": str(field.type)}
    return {
        "version": 1,
        "fields": [reference],
        "filters": [],
        "logic": "and",
        "sorts": [{**reference, "direction": "asc"}],
        "group_by": reference,
        "include_row_count": True,
    }
