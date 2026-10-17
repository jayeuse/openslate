"""PR #52 review: security events belong to the organization they happen in."""

from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.core.database.organization_scope import scope_session
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.platform.files import delivery
from tests.conftest import create_member, create_organization

pytestmark = pytest.mark.integration


def _payload(actor_id) -> SecurityEventIngestRequest:
    return SecurityEventIngestRequest(
        event_type="file.download",
        outcome=SecurityEventOutcome.ATTEMPT,
        source="files",
        operation_id=uuid4(),
        actor_id=actor_id,
    )


def test_events_record_their_named_organization_and_account_events_stay_unscoped(
    integration_db: Session,
) -> None:
    db = integration_db
    home, other = create_organization(db), create_organization(db)
    actor, _ = create_member(db, home, "admin")
    scope_session(db, home.id)
    named = append_security_event(db, _payload(actor.id), org_id=other.id)
    assert named.org_id == other.id
    # A bound session alone does not claim an event for the organization: account and
    # installation events (platform policy, sign-in) stay account-level by design.
    account_level = append_security_event(db, _payload(actor.id))
    assert account_level.org_id is None


def test_an_organization_file_download_records_the_file_organization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: list[object] = []
    monkeypatch.setattr(
        delivery, "append_committed_security_event",
        lambda payload, *, org_id=None: recorded.append(org_id),
    )
    organization_id = uuid4()
    delivery.record_download(uuid4(), uuid4(), org_id=organization_id)
    delivery.record_download(uuid4(), uuid4())  # an account file (avatar)
    assert recorded == [organization_id, None]
