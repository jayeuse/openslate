"""PostgreSQL concurrency guarantees for publication idempotency."""

import os
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from threading import Barrier
from typing import Any
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import Engine, create_engine, delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.sandbox.publications.router as publication_router
from app.common.dependencies.auth import CurrentIdentity
from app.core.base_model import utc_now
from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.models import SandboxDocument as SandboxDocumentRow
from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.executor import (
    PublicationError,
    apply_publication,
    replay_or_conflict,
    request_fingerprint,
)
from app.systems.sandbox.publications.models import SandboxBinding, SandboxPublication
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.schemas import PublicationRequest
from app.systems.sandbox.publications.tokens import issue_preview_token
from tests.postgres_runtime import assert_runner_database_url
from tests.sandbox_designs.fixtures import sample_document

pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class Attempt:
    key: str
    note: str | None


@dataclass(frozen=True)
class Prepared:
    actor_id: UUID
    revision: int
    document_hash: str
    impact_digest: str
    live_state_digest: str
    token_digest: str


@dataclass(frozen=True)
class Baseline:
    document_id: UUID
    revision: int
    document: dict[str, Any]
    content_hash: str
    byte_count: int
    performed_by: UUID | None
    updated_at: datetime


def test_concurrent_key_and_token_races_resolve_deterministically() -> None:
    database_url = os.environ["MIGRATION_DATABASE_URL"]
    assert_runner_database_url(database_url, allowed_roles=frozenset({"openslate_owner"}))
    engine = create_engine(database_url, pool_size=4, max_overflow=0)
    actor_id: UUID | None = None
    baseline: Baseline | None = None
    try:
        actor_id, baseline = _configure_publishable_draft(engine)

        same = _prepare(engine, actor_id, "same-key-token")
        same_results = _race(
            engine,
            same,
            Attempt("same-key", None),
            Attempt("same-key", None),
        )
        assert [status for status, _ in same_results] == ["ok", "ok"]
        assert len({value for _, value in same_results}) == 1

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
        assert "publication_unavailable" not in {
            value for _, value in (*token_results, *key_results)
        }
    finally:
        if actor_id is not None and baseline is not None:
            _cleanup_committed_fixture(engine, actor_id, baseline)
        engine.dispose()


def test_publication_denies_session_revoked_after_password_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = os.environ["MIGRATION_DATABASE_URL"]
    assert_runner_database_url(database_url, allowed_roles=frozenset({"openslate_owner"}))
    engine = create_engine(database_url, pool_size=2, max_overflow=0)
    actor_id: UUID | None = None
    session_id: UUID | None = None
    baseline: Baseline | None = None
    try:
        actor_id, baseline = _configure_publishable_draft(engine)
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
        with AuditSession(bind=engine) as db:
            _set_audit_context(db, actor_id)
            actor = db.get(User, actor_id)
            assert actor is not None
            prepared = _prepare(engine, actor_id, "revoked-after-password")
            preview_token, _claims = issue_preview_token(
                actor_id=actor_id,
                session_id=session_id,
                document_revision=prepared.revision,
                document_hash=prepared.document_hash,
                impact_digest=prepared.impact_digest,
                live_state_digest=prepared.live_state_digest,
            )

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
                    f"revoked-after-password-{uuid7()}",
                )
            assert denied.value.status_code == 403
            db.rollback()
        with Session(engine) as check:
            assert (
                check.scalar(
                    select(SandboxPublication).where(SandboxPublication.actor_id == actor_id)
                )
                is None
            )
    finally:
        if session_id is not None:
            with Session(engine) as cleanup:
                session = cleanup.get(IdentitySession, session_id)
                if session is not None:
                    cleanup.delete(session)
                    cleanup.commit()
        if actor_id is not None and baseline is not None:
            _cleanup_committed_fixture(engine, actor_id, baseline)
        engine.dispose()


def test_publication_retry_rechecks_session_after_integrity_rollback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = os.environ["MIGRATION_DATABASE_URL"]
    assert_runner_database_url(database_url, allowed_roles=frozenset({"openslate_owner"}))
    engine = create_engine(database_url, pool_size=2, max_overflow=0)
    actor_id: UUID | None = None
    session_id: UUID | None = None
    baseline: Baseline | None = None
    try:
        actor_id, baseline = _configure_publishable_draft(engine)
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
        prepared = _prepare(engine, actor_id, "rollback-before-replay")
        preview_token, _claims = issue_preview_token(
            actor_id=actor_id,
            session_id=session_id,
            document_revision=prepared.revision,
            document_hash=prepared.document_hash,
            impact_digest=prepared.impact_digest,
            live_state_digest=prepared.live_state_digest,
        )
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
                    f"rollback-before-replay-{uuid7()}",
                )
            assert denied.value.status_code == 403
            db.rollback()
        with Session(engine) as check:
            assert (
                check.scalar(
                    select(SandboxPublication).where(SandboxPublication.actor_id == actor_id)
                )
                is None
            )
    finally:
        if session_id is not None:
            with Session(engine) as cleanup:
                session = cleanup.get(IdentitySession, session_id)
                if session is not None:
                    cleanup.delete(session)
                    cleanup.commit()
        if actor_id is not None and baseline is not None:
            _cleanup_committed_fixture(engine, actor_id, baseline)
        engine.dispose()


def _configure_publishable_draft(engine: Engine) -> tuple[UUID, Baseline]:
    with AuditSession(bind=engine) as db:
        role = db.scalar(select(Role).where(Role.role == "admin"))
        assert role is not None
        actor = User(
            email="publication-concurrency@example.test",
            username="publication-concurrency",
            status=UserStatus.ACTIVE.value,
            role_id=role.id,
        )
        db.add(actor)
        db.flush()
        _set_audit_context(db, actor.id)
        row = db.scalar(select(SandboxDocumentRow))
        assert row is not None
        baseline = Baseline(
            document_id=row.id,
            revision=row.revision,
            document=deepcopy(row.document),
            content_hash=row.content_hash,
            byte_count=row.byte_count,
            performed_by=row.performed_by,
            updated_at=row.updated_at,
        )
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


def _cleanup_committed_fixture(engine: Engine, actor_id: UUID, baseline: Baseline) -> None:
    """Remove only rows committed by this concurrent test and restore its singleton edit."""

    with engine.begin() as connection:
        connection.execute(
            delete(SandboxPublication).where(SandboxPublication.actor_id == actor_id)
        )
        connection.execute(delete(SandboxBinding).where(SandboxBinding.performed_by == actor_id))
        connection.execute(delete(SandboxVersion).where(SandboxVersion.performed_by == actor_id))
        connection.execute(delete(Field).where(Field.performed_by == actor_id))
        connection.execute(delete(Module).where(Module.performed_by == actor_id))
        connection.execute(delete(Department).where(Department.performed_by == actor_id))
        connection.execute(
            update(SandboxDocumentRow)
            .where(SandboxDocumentRow.id == baseline.document_id)
            .values(
                revision=baseline.revision,
                document=baseline.document,
                content_hash=baseline.content_hash,
                byte_count=baseline.byte_count,
                performed_by=baseline.performed_by,
                updated_at=baseline.updated_at,
            )
        )
        connection.execute(
            delete(AuditLog).where(
                or_(AuditLog.performed_by == actor_id, AuditLog.entity_id == actor_id)
            )
        )
        connection.execute(delete(User).where(User.id == actor_id))


def _prepare(engine: Engine, actor_id: UUID, token_label: str) -> Prepared:
    with AuditSession(bind=engine) as db:
        response = read_document(db)
        plan = publication_plan(db, response.document)
        assert not plan.blockers
        return Prepared(
            actor_id=actor_id,
            revision=response.revision,
            document_hash=response.content_hash,
            impact_digest=plan.impact_digest,
            live_state_digest=plan.live_state_digest,
            token_digest=sha256(token_label.encode()).hexdigest(),
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
            document_hash=prepared.document_hash,
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
                result = apply_publication(
                    db,
                    actor_id=prepared.actor_id,
                    expected_revision=prepared.revision,
                    impact_digest=prepared.impact_digest,
                    expected_live_state_digest=prepared.live_state_digest,
                    preview_token_digest=prepared.token_digest,
                    idempotency_key=attempt.key,
                    fingerprint=fingerprint,
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
