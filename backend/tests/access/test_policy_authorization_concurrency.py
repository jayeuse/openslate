"""Guarded PostgreSQL authorization lock-order and concurrency coverage."""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from threading import Barrier, Event
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies.auth import require_fresh_capabilities, require_fresh_exact_admin
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy import authorization
from app.systems.access.policy.authorization import (
    authorize_workspace_capabilities,
    check_workspace_access,
)
from app.systems.access.policy.evaluator import PrincipalKind
from app.systems.access.policy.models import (
    AccessGroup,
    AccessGroupMember,
    AccessPolicyVersion,
    AccessRule,
)
from app.systems.access.service_identities import service as service_identity_service
from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.service_identities.schemas import ServiceIdentityUpdate
from app.systems.access.users.models import Role, User, UserRole
from app.systems.access.users.permissions import Capability
from tests.access.policy_authorization_support import (
    ConcurrencyRows,
    ServiceCheckRows,
    _role,
    _user,
)
from tests.conftest import guarded_create_engine

pytestmark = pytest.mark.integration


def _seed_service_check_rows() -> ServiceCheckRows:
    database_url = os.environ["TEST_DATABASE_URL"]
    engine = guarded_create_engine(database_url, pool_size=2, max_overflow=0)
    suffix = uuid4().hex
    role = _role(name=f"check-service-lock-{suffix}", permissions={})
    with Session(engine) as db:
        db.add(role)
        db.flush()
        owner = _user(role=role, name=f"check-service-owner-{suffix}")
        db.add(owner)
        db.flush()
        service = ServiceIdentity(
            name=f"check-lock-service-{suffix}",
            purpose="Verify service check lock ordering",
            owner_id=owner.id,
            role_id=role.id,
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        db.add(service)
        db.flush()
        result = ServiceCheckRows(
            database_url=database_url,
            role_id=role.id,
            owner_id=owner.id,
            service_id=service.id,
            service_etag=service_identity_service.etag(service),
        )
        db.commit()
    engine.dispose()
    return result


def _cleanup_service_check_rows(rows: ServiceCheckRows) -> None:
    engine = guarded_create_engine(rows.database_url, pool_size=1, max_overflow=0)
    with Session(engine) as db:
        for model, row_id in (
            (ServiceIdentity, rows.service_id),
            (User, rows.owner_id),
            (Role, rows.role_id),
        ):
            row = db.get(model, row_id)
            if row is not None:
                db.delete(row)
        db.commit()
    engine.dispose()


def test_service_check_lock_order_does_not_cycle_with_service_role_update(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = _seed_service_check_rows()
    service_locked = Event()
    allow_role_lock = Event()
    check_target_load = Event()
    load_principal = authorization._load_principal
    lock_role = service_identity_service.lock_valid_role

    def pause_before_service_role_lock(db: Session, role_id: UUID) -> Role:
        service_locked.set()
        assert allow_role_lock.wait(timeout=3)
        return lock_role(db, role_id)

    def observe_service_target_lock(db: Session, **kwargs):
        if kwargs["principal_kind"] is PrincipalKind.SERVICE:
            check_target_load.set()
        return load_principal(db, **kwargs)

    monkeypatch.setattr(service_identity_service, "lock_valid_role", pause_before_service_role_lock)
    monkeypatch.setattr(authorization, "_load_principal", observe_service_target_lock)

    def update_same_role() -> None:
        engine = guarded_create_engine(rows.database_url, pool_size=1, max_overflow=0)
        with Session(engine) as db:
            service_identity_service.update_service_identity(
                db,
                rows.service_id,
                ServiceIdentityUpdate(role_id=rows.role_id),
                rows.service_etag,
            )
        engine.dispose()

    def check_service() -> None:
        engine = guarded_create_engine(rows.database_url, pool_size=1, max_overflow=0)
        with Session(engine) as db:
            result, _checked_at = check_workspace_access(
                db,
                principal_kind=PrincipalKind.SERVICE,
                principal_id=rows.service_id,
                capability=Capability.RECORDS_READ,
            )
            assert result.decision.value == "deny"
            db.rollback()
        engine.dispose()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            update = executor.submit(update_same_role)
            assert service_locked.wait(timeout=3)
            check = executor.submit(check_service)
            assert check_target_load.wait(timeout=3)
            allow_role_lock.set()
            update.result(timeout=5)
            check.result(timeout=5)
    finally:
        allow_role_lock.set()
        _cleanup_service_check_rows(rows)


def _seed_concurrency_rows() -> ConcurrencyRows:
    database_url = os.environ["TEST_DATABASE_URL"]
    engine = guarded_create_engine(database_url, pool_size=4, max_overflow=0)
    suffix = uuid4().hex
    role = _role(
        name=f"concurrent-reader-{suffix}",
        permissions={Capability.RECORDS_READ.value: True},
    )
    with Session(engine) as db:
        db.add(role)
        db.flush()
        admin_role = db.scalar(
            select(Role).where(Role.role == UserRole.ADMIN.value, Role.is_deleted.is_(False))
        )
        assert admin_role is not None
        first = _user(role=role, name=f"concurrent-first-{suffix}")
        second = _user(role=role, name=f"concurrent-second-{suffix}")
        admin = _user(role=admin_role, name=f"concurrent-admin-{suffix}")
        db.add_all([first, second, admin])
        db.flush()
        group = AccessGroup(name=f"Concurrent group {suffix}", description="")
        db.add(group)
        db.flush()
        membership = AccessGroupMember(group_id=group.id, user_id=first.id)
        first_session = IdentitySession(
            user_id=first.id,
            refresh_token_digest=sha256(f"refresh-{suffix}".encode()).hexdigest(),
            csrf_token_digest=sha256(f"csrf-{suffix}".encode()).hexdigest(),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        second_session = IdentitySession(
            user_id=first.id,
            refresh_token_digest=sha256(f"refresh-second-{suffix}".encode()).hexdigest(),
            csrf_token_digest=sha256(f"csrf-second-{suffix}".encode()).hexdigest(),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        db.add_all([membership, first_session, second_session])
        db.flush()
        result = ConcurrencyRows(
            database_url=database_url,
            reader_role_id=role.id,
            first_user_id=first.id,
            second_user_id=second.id,
            admin_user_id=admin.id,
            admin_role_id=admin_role.id,
            first_session_id=first_session.id,
            second_session_id=second_session.id,
            group_id=group.id,
            membership_id=membership.id,
        )
        db.commit()
    engine.dispose()
    return result


def _cleanup_concurrency_rows(rows: ConcurrencyRows) -> None:
    engine = guarded_create_engine(rows.database_url, pool_size=2, max_overflow=0)
    with Session(engine) as db:
        for session_id in (rows.first_session_id, rows.second_session_id):
            session = db.get(IdentitySession, session_id)
            if session is not None:
                db.delete(session)
        user_ids = (rows.first_user_id, rows.second_user_id, rows.admin_user_id)
        rules = db.scalars(select(AccessRule).where(AccessRule.performed_by.in_(user_ids))).all()
        for rule in rules:
            db.delete(rule)
        membership = db.get(AccessGroupMember, rows.membership_id)
        if membership is not None:
            db.delete(membership)
        group = db.get(AccessGroup, rows.group_id)
        if group is not None:
            db.delete(group)
        for user_id in user_ids:
            user = db.get(User, user_id)
            if user is not None:
                db.delete(user)
        role = db.get(Role, rows.reader_role_id)
        if role is not None:
            db.delete(role)
        db.commit()
    engine.dispose()


def test_shared_same_role_workspace_reads_coexist() -> None:
    rows = _seed_concurrency_rows()
    barrier = Barrier(2, timeout=3)

    def authorize_reader(user_id: UUID) -> None:
        engine = guarded_create_engine(rows.database_url, pool_size=2, max_overflow=0)
        with Session(engine) as db:
            authorize_workspace_capabilities(
                db,
                actor_id=user_id,
                expected_role_id=rows.reader_role_id,
                capabilities=(Capability.RECORDS_READ,),
            )
            barrier.wait()
            db.rollback()
        engine.dispose()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            first_read = executor.submit(authorize_reader, rows.first_user_id)
            second_read = executor.submit(authorize_reader, rows.second_user_id)
            first_read.result(timeout=5)
            second_read.result(timeout=5)
    finally:
        _cleanup_concurrency_rows(rows)


def test_exact_admin_and_admin_workspace_reads_do_not_cycle() -> None:
    rows = _seed_concurrency_rows()
    barrier = Barrier(2, timeout=3)

    def exact_admin() -> None:
        engine = guarded_create_engine(rows.database_url, pool_size=2, max_overflow=0)
        with Session(engine) as db:
            require_fresh_exact_admin(db, rows.admin_user_id)
            barrier.wait()
            db.rollback()
        engine.dispose()

    def workspace_admin() -> None:
        engine = guarded_create_engine(rows.database_url, pool_size=2, max_overflow=0)
        with Session(engine) as db:
            authorize_workspace_capabilities(
                db,
                actor_id=rows.admin_user_id,
                expected_role_id=rows.admin_role_id,
                capabilities=(Capability.RECORDS_READ,),
            )
            barrier.wait()
            db.rollback()
        engine.dispose()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            exact = executor.submit(exact_admin)
            workspace = executor.submit(workspace_admin)
            exact.result(timeout=5)
            workspace.result(timeout=5)
    finally:
        _cleanup_concurrency_rows(rows)


def test_fresh_policy_reader_releases_version_before_exclusive_writer_proceeds() -> None:
    rows = _seed_concurrency_rows()
    reader_ready = Event()
    release_reader = Event()
    writer_done = Event()

    def hold_fresh_authorization() -> None:
        engine = guarded_create_engine(rows.database_url, pool_size=2, max_overflow=0)
        with Session(engine) as db:
            require_fresh_capabilities(
                db,
                actor_id=rows.first_user_id,
                session_id=rows.first_session_id,
                expected_role_id=rows.reader_role_id,
                capabilities=(Capability.RECORDS_READ,),
            )
            reader_ready.set()
            assert release_reader.wait(timeout=3)
            db.rollback()
        engine.dispose()

    def lock_policy_version() -> None:
        assert reader_ready.wait(timeout=3)
        engine = guarded_create_engine(rows.database_url, pool_size=2, max_overflow=0)
        with Session(engine) as db:
            db.scalar(
                select(AccessPolicyVersion)
                .where(AccessPolicyVersion.singleton_key == "workspace")
                .with_for_update()
            )
            db.rollback()
        engine.dispose()
        writer_done.set()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            reader = executor.submit(hold_fresh_authorization)
            writer = executor.submit(lock_policy_version)
            assert not writer_done.wait(timeout=0.2)
            release_reader.set()
            reader.result(timeout=5)
            writer.result(timeout=5)
        assert writer_done.is_set()
    finally:
        _cleanup_concurrency_rows(rows)


def test_two_fresh_sessions_for_one_user_serialize_before_password_upgrade() -> None:
    rows = _seed_concurrency_rows()
    first_ready = Event()
    release_first = Event()
    second_done = Event()

    def hold_first_fresh() -> None:
        engine = guarded_create_engine(rows.database_url, pool_size=2, max_overflow=0)
        with Session(engine) as db:
            require_fresh_capabilities(
                db,
                actor_id=rows.first_user_id,
                session_id=rows.first_session_id,
                expected_role_id=rows.reader_role_id,
                capabilities=(Capability.RECORDS_READ,),
            )
            first_ready.set()
            assert release_first.wait(timeout=3)
            db.rollback()
        engine.dispose()

    def run_second_fresh() -> None:
        assert first_ready.wait(timeout=3)
        engine = guarded_create_engine(rows.database_url, pool_size=2, max_overflow=0)
        with Session(engine) as db:
            require_fresh_capabilities(
                db,
                actor_id=rows.first_user_id,
                session_id=rows.second_session_id,
                expected_role_id=rows.reader_role_id,
                capabilities=(Capability.RECORDS_READ,),
            )
            db.rollback()
        engine.dispose()
        second_done.set()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(hold_first_fresh)
            second = executor.submit(run_second_fresh)
            assert not second_done.wait(timeout=0.2)
            release_first.set()
            first.result(timeout=5)
            second.result(timeout=5)
        assert second_done.is_set()
    finally:
        _cleanup_concurrency_rows(rows)


def test_group_writer_and_ordinary_workspace_authorization_do_not_deadlock() -> None:
    rows = _seed_concurrency_rows()
    reader_ready = Event()
    release_reader = Event()
    writer_done = Event()

    def hold_ordinary_authorization() -> None:
        engine = guarded_create_engine(rows.database_url, pool_size=2, max_overflow=0)
        with Session(engine) as db:
            authorize_workspace_capabilities(
                db,
                actor_id=rows.first_user_id,
                expected_role_id=rows.reader_role_id,
                capabilities=(Capability.RECORDS_READ,),
            )
            reader_ready.set()
            assert release_reader.wait(timeout=3)
            db.rollback()
        engine.dispose()

    def update_group() -> None:
        assert reader_ready.wait(timeout=3)
        engine = guarded_create_engine(rows.database_url, pool_size=2, max_overflow=0)
        with Session(engine) as db:
            group = db.scalar(
                select(AccessGroup).where(AccessGroup.id == rows.group_id).with_for_update()
            )
            membership = db.scalar(
                select(AccessGroupMember)
                .where(AccessGroupMember.id == rows.membership_id)
                .with_for_update()
            )
            db.scalar(select(User).where(User.id == rows.first_user_id).with_for_update())
            assert group is not None
            assert membership is not None
            group.description = "writer-held"
            db.rollback()
        engine.dispose()
        writer_done.set()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            reader = executor.submit(hold_ordinary_authorization)
            writer = executor.submit(update_group)
            assert not writer_done.wait(timeout=0.2)
            release_reader.set()
            reader.result(timeout=5)
            writer.result(timeout=5)
        assert writer_done.is_set()
    finally:
        _cleanup_concurrency_rows(rows)
