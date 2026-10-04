from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.sandbox.relationships.access import require_link_change, require_readable_link
from app.systems.sandbox.relationships.schemas import (
    RelationshipAssignment,
    RelationshipCreate,
    RelationshipListRequest,
    RelationshipListResponse,
    RelationshipResponse,
)
from app.systems.sandbox.relationships.service import (
    RelationshipError,
    relationship_response,
)
from app.systems.sandbox.relationships.service import (
    assign_relationship as assign_relationship_service,
)
from app.systems.sandbox.relationships.service import (
    create_relationship as create_relationship_service,
)
from app.systems.sandbox.relationships.service import (
    get_relationship as get_relationship_service,
)
from app.systems.sandbox.relationships.service import (
    list_relationships as list_relationships_service,
)
from app.systems.sandbox.relationships.service import (
    unlink_relationship as unlink_relationship_service,
)

router = APIRouter(prefix="/relationships", tags=["relationships"])
# A link is visible only when the user can read both records' modules.
RelationshipReadUser = Annotated[User, Depends(get_current_user)]
RelationshipWriteUser = Annotated[User, Depends(get_current_user)]


def _raise_service_error(error: RelationshipError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.detail)


@router.get("", response_model=RelationshipListResponse)
def list_relationships(
    user: RelationshipReadUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[RelationshipListRequest, Query()],
) -> RelationshipListResponse:
    try:
        items, pagination = list_relationships_service(db, params, reader=user)
    except RelationshipError as error:
        raise _raise_service_error(error) from error
    return RelationshipListResponse(items=items, pagination=pagination)


@router.get("/{relationship_id}", response_model=RelationshipResponse)
def get_relationship(
    relationship_id: UUID,
    user: RelationshipReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> RelationshipResponse:
    try:
        edge = get_relationship_service(db, relationship_id)
    except RelationshipError as error:
        raise _raise_service_error(error) from error
    require_readable_link(db, user, edge)
    return relationship_response(edge)


@router.post("", response_model=RelationshipResponse, status_code=status.HTTP_201_CREATED)
def create_relationship(
    payload: RelationshipCreate,
    user: RelationshipWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> RelationshipResponse:
    _checked_rows = require_link_change(
        db, user, payload.source_record_id, payload.target_record_id
    )
    try:
        return create_relationship_service(
            db,
            payload.field_id,
            payload.source_record_id,
            payload.target_record_id,
        )
    except RelationshipError as error:
        raise _raise_service_error(error) from error


@router.delete("/{relationship_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_relationship(
    relationship_id: UUID,
    user: RelationshipWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    try:
        edge = get_relationship_service(db, relationship_id)
    except RelationshipError as error:
        raise _raise_service_error(error) from error
    require_readable_link(db, user, edge)
    require_link_change(db, user, edge.source_record_id, edge.target_record_id)
    try:
        unlink_relationship_service(db, relationship_id)
    except RelationshipError as error:
        raise _raise_service_error(error) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/fields/{field_id}/sources/{source_record_id}",
    response_model=RelationshipResponse | None,
)
def assign_relationship(
    field_id: UUID,
    source_record_id: UUID,
    payload: RelationshipAssignment,
    user: RelationshipWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> RelationshipResponse | None:
    _checked_rows = require_link_change(
        db, user, source_record_id, payload.target_record_id, field_id=field_id
    )
    try:
        return assign_relationship_service(
            db,
            field_id,
            source_record_id,
            payload.target_record_id,
        )
    except RelationshipError as error:
        raise _raise_service_error(error) from error
