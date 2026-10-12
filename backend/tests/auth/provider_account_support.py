"""A real Supabase Auth account with an unbound local profile.

``provider_account`` creates the provider user through the admin API of the runner-owned
stack and deletes it, its local sessions, notices and profile afterwards. Real provider
journeys use it with ``pytest_plugins = ("tests.auth.provider_account_support",)``.
"""

import os
from secrets import token_urlsafe
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User, UserStatus
from app.systems.platform.scheduling.models import InAppNotification
from tests.conftest import guarded_create_engine


@pytest.fixture
def provider_account():
    settings = get_settings()
    assert_provider_instance(
        dict(os.environ), database_url=settings.database_url, expected_user="openslate_runtime"
    )
    email = f"auth-journey-{uuid4().hex}@example.test"
    password = token_urlsafe(32)
    provider_id = None
    local_id = None
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    with httpx.Client(
        base_url=settings.supabase_url.rstrip("/") + "/auth/v1/",
        headers={"apikey": settings.supabase_secret_key.get_secret_value()},
        timeout=15,
    ) as admin:
        try:
            created = admin.post(
                "admin/users", json={"email": email, "password": password, "email_confirm": True}
            )
            assert created.status_code in {200, 201}
            provider_id = UUID(created.json()["id"])
            with Session(owner) as db:
                user = User(
                    email=email,
                    username=f"journey-{uuid4().hex[:16]}",
                    status=UserStatus.ACTIVE.value,
                    role="member",
                    # Deliberately unbound first: matching email cannot grant access.
                )
                db.add(user)
                db.commit()
                local_id = user.id
            yield email, password, provider_id, local_id, owner
        finally:
            if provider_id is not None:
                deleted = admin.delete(f"admin/users/{provider_id}")
                assert deleted.status_code in {200, 204, 404}
            if local_id is not None:
                with Session(owner) as db:
                    for session in db.scalars(
                        select(IdentitySession).where(IdentitySession.user_id == local_id)
                    ):
                        db.delete(session)
                    for notice in db.scalars(
                        select(InAppNotification).where(InAppNotification.recipient_id == local_id)
                    ):
                        db.delete(notice)
                    db.flush()
                    user = db.get(User, local_id)
                    if user is not None:
                        db.delete(user)
                    db.commit()
            owner.dispose()
