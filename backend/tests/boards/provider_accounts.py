"""Disposable password identities for Boards purge step-up tests, on the fake provider.

These tests check lifecycle step-up and deletion, not Supabase Auth; the real provider
step-up keeps ``tests/lifecycle_integration/test_provider_stepup_acceptance.py``.
"""

from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from tests.fake_provider_support import FakeProvider, install_fake_provider

_FAKE_PROVIDER_INFO_KEY = "tests.boards.fake_provider"


def create_password_account(db: Session, *, email: str, password: str) -> UUID:
    """Register one identity; the first call routes the provider client to a fake."""

    installed: tuple[pytest.MonkeyPatch, FakeProvider] | None = db.info.get(_FAKE_PROVIDER_INFO_KEY)
    if installed is None:
        patcher = pytest.MonkeyPatch()
        installed = (patcher, install_fake_provider(patcher))
        db.info[_FAKE_PROVIDER_INFO_KEY] = installed
    return installed[1].add(email, password)


def cleanup_password_accounts(db: Session) -> None:
    """Restore the real provider client after this test's database session."""

    installed = db.info.pop(_FAKE_PROVIDER_INFO_KEY, None)
    if installed is not None:
        installed[0].undo()
