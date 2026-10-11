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
from sqlalchemy import Engine, create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.sandbox.publications.router as publication_router
from app.common.dependencies.auth import CurrentIdentity
from app.core.base_model import utc_now
from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.publications.executor import (
    PublicationError,
    replay_or_conflict,
    request_fingerprint,
)
from app.systems.sandbox.publications.models import SandboxPublication
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.schemas import PublicationRequest
from app.systems.sandbox.publications.tokens import issue_preview_token
from tests.postgres_runtime import assert_runner_database_url
from tests.sandbox_designs.fixtures import sample_document
from tests.sandbox_publications.support import publish_saved
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
        actor = User(
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
        first_future = pool.submit(publish, first)
        second_future = pool.submit(publish, second)
        return sorted([first_future.result(), second_future.result()])


def _set_audit_context(db: AuditSession, actor_id: UUID) -> None:
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        performed_by=actor_id,
        request_id=uuid7(),
        request_method="POST",
        request_path="/api/sandbox/publications",
    )
