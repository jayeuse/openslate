from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.common.dependencies import require_roles
from app.core.database import get_db
from app.systems.relationships.schemas import (
    RelationshipAssignment,
    RelationshipCreate,
    RelationshipListRequest,
    RelationshipListResponse,
    RelationshipResponse,
)
from app.systems.relationships.service import (
    RelationshipError,
    relationship_response,
)
from app.systems.relationships.service import (
    assign_relationship as assign_relationship_service,
)
from app.systems.relationships.service import (
    create_relationship as create_relationship_service,
)
from app.systems.relationships.service import (
    get_relationship as get_relationship_service,
)
from app.systems.relationships.service import (
    list_relationships as list_relationships_service,
)
from app.systems.relationships.service import (
    unlink_relationship as unlink_relationship_service,
)
from app.systems.users.models import User, UserRole

router = APIRouter(prefix="/relationships", tags=["relationships"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


def _raise_service_error(error: RelationshipError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.detail)


@router.get("", response_model=RelationshipListResponse)
def list_relationships(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[RelationshipListRequest, Query()],
) -> RelationshipListResponse:
    try:
        items, pagination = list_relationships_service(db, params)
    except RelationshipError as error:
        raise _raise_service_error(error) from error
    return RelationshipListResponse(items=items, pagination=pagination)


@router.get("/{relationship_id}", response_model=RelationshipResponse)
def get_relationship(
    relationship_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> RelationshipResponse:
    try:
        return relationship_response(get_relationship_service(db, relationship_id))
    except RelationshipError as error:
        raise _raise_service_error(error) from error


@router.post("", response_model=RelationshipResponse, status_code=status.HTTP_201_CREATED)
def create_relationship(
    payload: RelationshipCreate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> RelationshipResponse:
    try:
        return relationship_response(
            create_relationship_service(
                db,
                payload.field_id,
                payload.source_record_id,
                payload.target_record_id,
            )
        )
    except RelationshipError as error:
        raise _raise_service_error(error) from error


@router.delete("/{relationship_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_relationship(
    relationship_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
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
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> RelationshipResponse | None:
    try:
        edge = assign_relationship_service(
            db,
            field_id,
            source_record_id,
            payload.target_record_id,
        )
        return relationship_response(edge) if edge is not None else None
    except RelationshipError as error:
        raise _raise_service_error(error) from error
