from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_fresh_exact_admin, require_roles
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.service_identities.schemas import (
    ServiceIdentityCreate,
    ServiceIdentityListRequest,
    ServiceIdentityResponse,
    ServiceIdentitySortField,
    ServiceIdentityUpdate,
)
from app.systems.access.service_identities.service import (
    create_service_identity,
    delete_service_identity,
    etag,
    get_service_identity,
    restore_service_identity,
    update_service_identity,
)
from app.systems.access.users.models import User, UserRole

router = APIRouter(prefix="/access/service-identities", tags=["service-identities"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


class ServiceIdentityListResponse(StandardListResponse[ServiceIdentityResponse]):
    pass


SERVICE_IDENTITY_LIST_SPEC = ListQuerySpec(
    sort_fields={
        ServiceIdentitySortField.NAME: cast(ColumnElement[Any], ServiceIdentity.name),
        ServiceIdentitySortField.EXPIRES_AT: cast(ColumnElement[Any], ServiceIdentity.expires_at),
        ServiceIdentitySortField.UPDATED_AT: cast(ColumnElement[Any], ServiceIdentity.updated_at),
    },
    default_sort=ServiceIdentitySortField.NAME,
    tie_breaker=cast(ColumnElement[Any], ServiceIdentity.id),
    search_fields=(
        cast(ColumnElement[str], ServiceIdentity.name),
        cast(ColumnElement[str], ServiceIdentity.purpose),
    ),
    deleted_field=cast(ColumnElement[bool], ServiceIdentity.is_deleted),
)
ETAG_HEADERS: dict[str, dict[str, Any]] = {"ETag": {"schema": {"type": "string"}}}
CONDITIONAL_RESPONSES: dict[int | str, dict[str, Any]] = {
    412: {"description": "If-Match does not match the locked resource version"},
    428: {"description": "If-Match header is required"},
}


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


def _exact_admin(db: Session, admin: User) -> None:
    require_fresh_exact_admin(db, admin.id)


@router.get("", response_model=ServiceIdentityListResponse)
def list_service_identities(
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    params: Annotated[ServiceIdentityListRequest, Query()],
) -> ServiceIdentityListResponse:
    _exact_admin(db, admin)
    _private(response)
    statement = select(ServiceIdentity)
    if params.status is not None:
        statement = statement.where(ServiceIdentity.status == params.status)
    if params.owner_id is not None:
        statement = statement.where(ServiceIdentity.owner_id == params.owner_id)
    if params.role_id is not None:
        statement = statement.where(ServiceIdentity.role_id == params.role_id)
    try:
        result = execute_standard_list(db, statement, params, SERVICE_IDENTITY_LIST_SPEC)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database unavailable"
        ) from error
    return ServiceIdentityListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination}, from_attributes=True
    )


@router.get(
    "/{service_identity_id}",
    response_model=ServiceIdentityResponse,
    responses={200: {"headers": ETAG_HEADERS}},
)
def get_one_service_identity(
    service_identity_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> ServiceIdentity:
    _exact_admin(db, admin)
    row = get_service_identity(db, service_identity_id)
    _private(response)
    response.headers["ETag"] = etag(row)
    return row


@router.post(
    "",
    response_model=ServiceIdentityResponse,
    status_code=status.HTTP_201_CREATED,
    responses={201: {"headers": {**ETAG_HEADERS, "Location": {"schema": {"type": "string"}}}}},
)
def create_one_service_identity(
    payload: ServiceIdentityCreate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> ServiceIdentity:
    _exact_admin(db, admin)
    row = create_service_identity(db, payload)
    _private(response)
    response.headers["ETag"] = etag(row)
    response.headers["Location"] = f"/api/access/service-identities/{row.id}"
    return row


@router.patch(
    "/{service_identity_id}",
    response_model=ServiceIdentityResponse,
    responses={200: {"headers": ETAG_HEADERS}, **CONDITIONAL_RESPONSES},
)
def update_one_service_identity(
    service_identity_id: UUID,
    payload: ServiceIdentityUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    if_match: Annotated[str | None, Header()] = None,
) -> ServiceIdentity:
    _exact_admin(db, admin)
    row = update_service_identity(db, service_identity_id, payload, if_match)
    _private(response)
    response.headers["ETag"] = etag(row)
    return row


@router.delete(
    "/{service_identity_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=CONDITIONAL_RESPONSES,
)
def delete_one_service_identity(
    service_identity_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    if_match: Annotated[str | None, Header()] = None,
) -> Response:
    _exact_admin(db, admin)
    delete_service_identity(db, service_identity_id, if_match)
    return Response(
        status_code=status.HTTP_204_NO_CONTENT, headers={"Cache-Control": "private, no-store"}
    )


@router.post(
    "/{service_identity_id}/restore",
    response_model=ServiceIdentityResponse,
    responses={200: {"headers": ETAG_HEADERS}, **CONDITIONAL_RESPONSES},
)
def restore_one_service_identity(
    service_identity_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    if_match: Annotated[str | None, Header()] = None,
) -> ServiceIdentity:
    _exact_admin(db, admin)
    row = restore_service_identity(db, service_identity_id, if_match)
    _private(response)
    response.headers["ETag"] = etag(row)
    return row
