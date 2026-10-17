"""PostgreSQL concurrency guarantees for publication idempotency."""

import os
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from threading import Barrier
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import Engine, create_engine, delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.sandbox.publications.router as publication_router
from app.common.dependencies.auth import CurrentIdentity
from app.core.base_model import utc_now
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.checks import _lock_authority
from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.models import Membership, User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.executor import (
    PublicationError,
    replay_or_conflict,
    request_fingerprint,
)
from app.systems.sandbox.publications.models import SandboxPublication
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.schemas import PublicationRequest
from app.systems.sandbox.publications.tokens import issue_preview_token
from tests.conftest import create_member, create_organization
from tests.organization_scope_support import bind_test_organization, in_context
from tests.postgres_runtime import assert_runner_database_url
from tests.race_support import WAIT, backend_pid, wait_until_blocked_by
from tests.rbac.support import organization
from tests.sandbox_designs.fixtures import sample_document
from tests.sandbox_publications.support import bound_module, publish_saved
from tests.sandbox_record_triggers.support import (
    DocumentBaseline,
    cleanup_committed_trigger,
    document_baseline,
)

pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class Attempt:
    key: str
    note: str | None


@dataclass(frozen=True)
class Prepared:
    actor_id: UUID
    revision: int
    content_hash: str
    impact_digest: str
    live_state_digest: str
    token_digest: str


@dataclass(frozen=True)
class Publisher:
    engine: Engine
    actor_id: UUID
    session_id: UUID | None


@pytest.fixture
def committed_publisher() -> Iterator[Callable[..., Publisher]]:
    """Commit an administrator and a publishable draft on the test's own engine.

    Each race needs a fixed number of connections, so each test chooses its pool size.
    Teardown removes only the rows the test committed and restores the shared document.
    """

    with ExitStack() as stack:

        def start(*, pool_size: int, live_session: bool = False) -> Publisher:
            return stack.enter_context(_committed_publisher(pool_size, live_session))

        yield start


def test_concurrent_key_and_token_races_resolve_deterministically(
    committed_publisher: Callable[..., Publisher],
) -> None:
    publisher = committed_publisher(pool_size=4)
    engine, actor_id = publisher.engine, publisher.actor_id

    same = _prepare(engine, actor_id, "same-key-token")
    same_results = _race(
        engine,
        same,
        Attempt("same-key", None),
        Attempt("same-key", None),
    )
    assert [status for status, _ in same_results] == ["ok", "ok"]
    assert len({value for _, value in same_results}) == 1

    with Session(engine) as check:
        notices = list(
            check.scalars(
                select(InAppNotification).where(
                    InAppNotification.recipient_id == actor_id,
                    InAppNotification.kind == "sandbox-published",
                )
            )
        )
        assert len(notices) == 1
        publication = check.get(SandboxPublication, UUID(same_results[0][1]))
        assert notices[0].subject_id == publication.version_id
    token_race = _prepare(engine, actor_id, "one-token-two-keys")
    token_results = _race(
        engine,
        token_race,
        Attempt("token-key-a", None),
        Attempt("token-key-b", None),
    )
    assert sorted(status for status, _ in token_results) == ["error", "ok"]
    assert "preview_mismatch" in {value for _, value in token_results}

    key_race = _prepare(engine, actor_id, "one-key-two-fingerprints")
    key_results = _race(
        engine,
        key_race,
        Attempt("fingerprint-key", "First"),
        Attempt("fingerprint-key", "Second"),
    )
    assert sorted(status for status, _ in key_results) == ["error", "ok"]
    assert "idempotency_mismatch" in {value for _, value in key_results}
    assert "publication_unavailable" not in {value for _, value in (*token_results, *key_results)}


def test_publication_denies_session_revoked_after_password_commit(
    monkeypatch: pytest.MonkeyPatch,
    committed_publisher: Callable[..., Publisher],
) -> None:
    publisher = committed_publisher(pool_size=2, live_session=True)
    engine, actor_id, session_id = publisher.engine, publisher.actor_id, publisher.session_id
    with AuditSession(bind=engine) as db:
        _set_audit_context(db, actor_id)
        actor = db.get(User, actor_id)
        assert actor is not None
        prepared = _prepare(engine, actor_id, "revoked-after-password")
        preview_token = _preview_token(prepared, session_id)

        class PasswordGrant:
            def __init__(self, request_db: Session) -> None:
                self._db = request_db

            def verify_password(self, _email: str, _password: str) -> UUID:
                # Supabase password verification commits the request transaction.
                self._db.commit()
                with Session(engine) as concurrent:
                    current = concurrent.get(IdentitySession, session_id)
                    assert current is not None
                    current.revoked_at = utc_now()
                    concurrent.commit()
                return actor_id

        monkeypatch.setattr(publication_router, "ProviderPasswordGrantClient", PasswordGrant)
        _post_publication_denied(
            db, actor, session_id, prepared, preview_token, "revoked-after-password"
        )
    _assert_nothing_published(engine, actor_id)


def test_publication_retry_rechecks_session_after_integrity_rollback(
    monkeypatch: pytest.MonkeyPatch,
    committed_publisher: Callable[..., Publisher],
) -> None:
    publisher = committed_publisher(pool_size=2, live_session=True)
    engine, actor_id, session_id = publisher.engine, publisher.actor_id, publisher.session_id
    prepared = _prepare(engine, actor_id, "rollback-before-replay")
    preview_token = _preview_token(prepared, session_id)
    with AuditSession(bind=engine) as db:
        _set_audit_context(db, actor_id)
        actor = db.get(User, actor_id)
        assert actor is not None

        class PasswordGrant:
            def __init__(self, request_db: Session) -> None:
                self._db = request_db

            def verify_password(self, _email: str, _password: str) -> UUID:
                self._db.commit()
                actual_commit = self._db.commit
                actual_rollback = self._db.rollback

                def failed_commit() -> None:
                    raise IntegrityError("test commit conflict", {}, RuntimeError("conflict"))

                def revoke_after_rollback() -> None:
                    self._db.commit = actual_commit
                    self._db.rollback = actual_rollback
                    actual_rollback()
                    with Session(engine) as concurrent:
                        current = concurrent.get(IdentitySession, session_id)
                        assert current is not None
                        current.revoked_at = utc_now()
                        concurrent.commit()

                self._db.commit = failed_commit
                self._db.rollback = revoke_after_rollback
                return actor_id

        monkeypatch.setattr(publication_router, "ProviderPasswordGrantClient", PasswordGrant)
        _post_publication_denied(
            db, actor, session_id, prepared, preview_token, "rollback-before-replay"
        )
    _assert_nothing_published(engine, actor_id)


def test_publication_waits_for_a_member_access_check_without_deadlock(
    committed_publisher: Callable[..., Publisher],
) -> None:
    publisher = committed_publisher(pool_size=4)
    engine, actor_id = publisher.engine, publisher.actor_id
    _publish_once(engine, _prepare(engine, actor_id, "structure-before-access-check"))
    member_id, group_id, module_id = _commit_module_grant(engine, actor_id)
    try:
        prepared = _prepare(engine, actor_id, "publish-beside-access-check")
        with Session(engine) as member, ThreadPoolExecutor(max_workers=1) as pool:
            # A member write starts with this lock (require_fresh_module_access), then
            # locks the department or module it changes.
            _lock_authority(member, member_id)
            member_pid = int(member.scalar(text("SELECT pg_backend_pid()")))
            published = pool.submit(in_context(_publish_once), engine, prepared)
            wait_until_blocked_by(engine, member_pid)
            locked = member.scalar(
                select(Module.id).where(Module.id == module_id).with_for_update(read=True)
            )
            member.commit()
            assert locked == module_id
            assert published.result(timeout=WAIT) is not None
    finally:
        _remove_module_grant(engine, member_id, group_id)


@pytest.mark.parametrize("same_organization", [True, False], ids=["same-org", "other-org"])
def test_publication_profile_lock_is_organization_scoped(
    committed_publisher: Callable[..., Publisher], same_organization: bool
) -> None:
    publisher = committed_publisher(pool_size=4)
    engine, actor_id = publisher.engine, publisher.actor_id
    prepared = _prepare(engine, actor_id, "profile-lock")
    org_id = peer_id = None
    try:
        with Session(engine) as setup:
            org_id = setup.scalar(select(Membership.org_id).where(Membership.user_id == actor_id))
            assert org_id is not None
            audits_before = setup.scalar(
                select(func.count()).select_from(AuditLog).where(AuditLog.org_id == org_id)
            )
            # This organization has no structure that could introduce another shared lock.
            peer_id = create_organization(setup).id
            setup.commit()
        bind_test_organization(org_id)
        worker_pids: list[int] = []

        def publish() -> UUID:
            with AuditSession(bind=engine) as db:
                # in_context preserves a context; it does not select this organization.
                scope_session(db, org_id)
                worker_pids.append(backend_pid(db))
                _set_audit_context(db, actor_id)
                return publish_saved(
                    db, actor_id, prepared, prepared,
                    token_digest=prepared.token_digest,
                    idempotency_key=f"profile-{uuid7()}",
                ).id

        committed_while_held = blocked_by_holder = False
        refusal = None
        with Session(engine) as holder, ThreadPoolExecutor(max_workers=1) as pool:
            held_org_id = org_id if same_organization else peer_id
            scope_session(holder, held_org_id)
            profile = holder.scalar(
                select(WorkspaceProfile).where(WorkspaceProfile.id == held_org_id).with_for_update()
            )
            assert profile is not None
            profile.timezone = "Asia/Manila"
            profile.revision += 1
            holder.flush()
            holder_pid = int(holder.scalar(text("SELECT pg_backend_pid()")))
            published = pool.submit(in_context(publish))
            try:
                if same_organization:
                    blocked_by_holder = wait_until_blocked_by(engine, holder_pid) == worker_pids[0]
                else:
                    try:
                        publication_id = published.result(timeout=WAIT)
                    except TimeoutError:
                        blocked_by_holder = (
                            wait_until_blocked_by(engine, holder_pid) == worker_pids[0]
                        )
                    else:
                        with Session(engine) as check:
                            scope_session(check, org_id)
                            committed_while_held = check.scalar(
                                select(SandboxPublication.org_id)
                                .where(SandboxPublication.id == publication_id)
                            ) == org_id
            finally:
                # Release and join even on the old global-lock query's expected timeout.
                holder.commit()
                try:
                    published.result(timeout=WAIT)
                except PublicationError as error:
                    refusal = error
        if same_organization:
            assert blocked_by_holder
            assert isinstance(refusal, PublicationError)
            assert (refusal.code, refusal.status_code) == ("live_state_changed", 409)
            with Session(engine) as check:
                scope_session(check, org_id)
                current = read_document(check)
                assert (current.revision, current.content_hash) == (
                    prepared.revision, prepared.content_hash
                )
                assert check.scalar(select(SandboxPublication.id)) is None
                assert check.scalar(select(Module.id)) is None
                assert check.scalar(
                    select(func.count()).select_from(AuditLog).where(AuditLog.org_id == org_id)
                ) == audits_before
        else:
            assert committed_while_held, (
                "Publication did not commit before the unrelated organization's profile was "
                f"released; PostgreSQL confirmed blocked_by_holder={blocked_by_holder}"
            )
            assert refusal is None
    finally:
        if org_id is not None:
            bind_test_organization(org_id)
        if peer_id is not None:
            with engine.begin() as cleanup:
                cleanup.execute(delete(WorkspaceProfile).where(WorkspaceProfile.id == peer_id))


def _publish_once(engine: Engine, prepared: Prepared) -> UUID:
    with AuditSession(bind=engine) as db:
        _set_audit_context(db, prepared.actor_id)
        return publish_saved(
            db,
            prepared.actor_id,
            prepared,
            prepared,
            token_digest=prepared.token_digest,
            idempotency_key=f"publish-{uuid7()}",
        ).id


def _commit_module_grant(engine: Engine, actor_id: UUID) -> tuple[UUID, UUID, UUID]:
    with AuditSession(bind=engine) as db:
        _set_audit_context(db, actor_id)
        module = bound_module(db, "sample-requests")
        member, _membership = create_member(db, db.get(WorkspaceProfile, module.org_id),
            email=f"access-check-{uuid7()}@example.test",
            username=f"access-check-{uuid7().hex[-12:]}",
            status=UserStatus.ACTIVE.value,
            role="member",
        )
        group = Group(org_id=module.org_id, name=f"Access check {uuid7()}")
        db.add_all([member, group])
        db.flush()
        db.add_all(
            [
                GroupMember(org_id=group.org_id, group_id=group.id, user_id=member.id),
                GroupAccess(
                    org_id=group.org_id,
                    group_id=group.id,
                    department_id=module.department_id,
                    module_id=module.id,
                    level="write",
                ),
            ]
        )
        db.commit()
        return member.id, group.id, module.id


def _remove_module_grant(engine: Engine, member_id: UUID, group_id: UUID) -> None:
    with engine.begin() as connection:
        connection.execute(delete(GroupAccess).where(GroupAccess.group_id == group_id))
        connection.execute(delete(GroupMember).where(GroupMember.group_id == group_id))
        connection.execute(delete(Group).where(Group.id == group_id))
        connection.execute(delete(Membership).where(Membership.user_id == member_id))
        connection.execute(delete(User).where(User.id == member_id))


@contextmanager
def _committed_publisher(pool_size: int, live_session: bool) -> Iterator[Publisher]:
    database_url = os.environ["MIGRATION_DATABASE_URL"]
    assert_runner_database_url(database_url, allowed_roles=frozenset({"openslate_owner"}))
    engine = create_engine(database_url, pool_size=pool_size, max_overflow=0)
    actor_id: UUID | None = None
    session_id: UUID | None = None
    baseline: DocumentBaseline | None = None
    try:
        actor_id, baseline = _configure_publishable_draft(engine)
        if live_session:
            with Session(engine) as setup:
                session = IdentitySession(
                    user_id=actor_id,
                    refresh_token_digest=sha256(f"refresh-{uuid7()}".encode()).hexdigest(),
                    csrf_token_digest=sha256(f"csrf-{uuid7()}".encode()).hexdigest(),
                    expires_at=datetime.now(UTC) + timedelta(hours=1),
                )
                setup.add(session)
                setup.commit()
                session_id = session.id
        yield Publisher(engine, actor_id, session_id)
    finally:
        if session_id is not None:
            with Session(engine) as cleanup:
                session = cleanup.get(IdentitySession, session_id)
                if session is not None:
                    cleanup.delete(session)
                    cleanup.commit()
        if actor_id is not None and baseline is not None:
            cleanup_committed_trigger(engine, actor_id=actor_id, baseline=baseline)
        engine.dispose()


def _configure_publishable_draft(engine: Engine) -> tuple[UUID, DocumentBaseline]:
    with AuditSession(bind=engine) as db:
        role = "admin"
        assert role is not None
        actor, _membership = create_member(db, organization(db),
            email="publication-concurrency@example.test",
            username="publication-concurrency",
            status=UserStatus.ACTIVE.value,
            role=role,
        )
        db.add(actor)
        db.flush()
        _set_audit_context(db, actor.id)
        baseline = document_baseline(db)
        initial = read_document(db)
        document = sample_document().model_copy(deep=True)
        document.triggers = []
        document.scenarios = []
        replace_document(
            db,
            actor_id=actor.id,
            expected_revision=initial.revision,
            document=document,
        )
        return actor.id, baseline


def _prepare(engine: Engine, actor_id: UUID, token_label: str) -> Prepared:
    with AuditSession(bind=engine) as db:
        response = read_document(db)
        plan = publication_plan(db, response.document)
        assert not plan.blockers
        return Prepared(
            actor_id=actor_id,
            revision=response.revision,
            content_hash=response.content_hash,
            impact_digest=plan.impact_digest,
            live_state_digest=plan.live_state_digest,
            token_digest=sha256(token_label.encode()).hexdigest(),
        )


def _preview_token(prepared: Prepared, session_id: UUID | None) -> str:
    preview_token, _claims = issue_preview_token(
        actor_id=prepared.actor_id,
        session_id=session_id,
        document_revision=prepared.revision,
        document_hash=prepared.content_hash,
        impact_digest=prepared.impact_digest,
        live_state_digest=prepared.live_state_digest,
    )
    return preview_token


def _post_publication_denied(
    db: AuditSession,
    actor: User,
    session_id: UUID | None,
    prepared: Prepared,
    preview_token: str,
    key_prefix: str,
) -> None:
    """Post the reviewed publication through the route and require its 403 refusal."""

    payload = PublicationRequest(
        expected_revision=prepared.revision,
        preview_token=preview_token,
        impact_digest=prepared.impact_digest,
        password="verified by provider boundary",
    )
    with pytest.raises(HTTPException) as denied:
        publication_router.post_publication(
            payload,
            CurrentIdentity(actor, session_id, False, False),
            db,
            f"{key_prefix}-{uuid7()}",
        )
    assert denied.value.status_code == 403
    db.rollback()


def _assert_nothing_published(engine: Engine, actor_id: UUID) -> None:
    with Session(engine) as check:
        assert (
            check.scalar(select(SandboxPublication).where(SandboxPublication.actor_id == actor_id))
            is None
        )


def _race(
    engine: Engine,
    prepared: Prepared,
    first: Attempt,
    second: Attempt,
) -> list[tuple[str, str]]:
    barrier = Barrier(2)

    def publish(attempt: Attempt) -> tuple[str, str]:
        fingerprint = request_fingerprint(
            expected_revision=prepared.revision,
            document_hash=prepared.content_hash,
            impact_digest=prepared.impact_digest,
            preview_token_digest=prepared.token_digest,
            note=attempt.note,
        )
        with AuditSession(bind=engine) as db:
            _set_audit_context(db, prepared.actor_id)
            assert (
                replay_or_conflict(
                    db,
                    actor_id=prepared.actor_id,
                    idempotency_key=attempt.key,
                    fingerprint=fingerprint,
                    preview_token_digest=prepared.token_digest,
                )
                is None
            )
            db.rollback()
            barrier.wait(timeout=10)
            try:
                result = publish_saved(
                    db,
                    prepared.actor_id,
                    prepared,
                    prepared,
                    token_digest=prepared.token_digest,
                    idempotency_key=attempt.key,
                    note=attempt.note,
                )
            except PublicationError as error:
                return "error", error.code
            return "ok", str(result.id)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(in_context(publish), first)
        second_future = pool.submit(in_context(publish), second)
        return sorted([first_future.result(), second_future.result()])


def _set_audit_context(db: AuditSession, actor_id: UUID) -> None:
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        performed_by=actor_id,
        request_id=uuid7(),
        request_method="POST",
        request_path="/api/sandbox/publications",
    )
