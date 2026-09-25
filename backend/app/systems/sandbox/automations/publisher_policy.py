"""Workspace-policy snapshots used by published automation execution."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.systems.access.policy.authorization import (
    WorkspaceRoleChanged,
    authorize_workspace_capabilities,
)
from app.systems.access.users.permissions import Capability


@dataclass(frozen=True, slots=True)
class CandidatePublisher:
    publisher_id: UUID
    expected_role_id: UUID | None


class _AuthorizationSnapshotSession:
    """Keep successful policy snapshot locks when one publisher is denied.

    The shared policy helper rolls back a request session on a 403. A worker
    evaluates several definitions in one transaction, so a local 403 must not
    discard earlier shared policy locks. Unavailable authorization still rolls
    back the actual worker session.
    """

    def __init__(self, db: Session) -> None:
        self._db = db

    def rollback(self) -> None:
        return None

    def __getattr__(self, name: str) -> Any:
        return getattr(self._db, name)


def authorize_candidate_publishers(
    db: Session, publishers: dict[UUID, CandidatePublisher]
) -> dict[UUID, bool]:
    """Authorize candidates before any publisher or resource write lock.

    The first authorization acquires the policy-version shared lock, which
    stays held through execution. A denied publisher is suspended after the
    execution locks are taken. An unavailable policy fails closed and uses the
    worker's existing rollback and retry path.
    """

    snapshot_db = cast(Session, _AuthorizationSnapshotSession(db))
    authorized: dict[UUID, bool] = {}
    for definition_id in sorted(publishers):
        publisher = publishers[definition_id]
        if publisher.expected_role_id is None:
            authorized[definition_id] = False
            continue
        try:
            authorize_workspace_capabilities(
                snapshot_db,
                actor_id=publisher.publisher_id,
                expected_role_id=publisher.expected_role_id,
                capabilities=(Capability.RECORDS_WRITE,),
            )
        except WorkspaceRoleChanged as error:
            db.rollback()
            raise RuntimeError("Publisher role changed during authorization") from error
        except HTTPException as error:
            if error.status_code == status.HTTP_403_FORBIDDEN:
                authorized[definition_id] = False
                continue
            db.rollback()
            raise
        authorized[definition_id] = True
    return authorized
