"""Authenticated API routes for the shared Sandbox design workspace."""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.common.dependencies import require_admin
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.sandbox.designs.bindings import read_bindings
from app.systems.sandbox.designs.schemas import (
    DocumentReplaceRequest,
    DocumentResponse,
    ImportRequest,
    SandboxBindingsResponse,
    VersionCreateRequest,
    VersionDetailResponse,
    VersionListResponse,
    VersionMetadataUpdateRequest,
    VersionMutationRequest,
)
from app.systems.sandbox.designs.service import (
    SandboxDesignError,
    create_version,
    delete_version,
    export_bundle,
    import_bundle,
    list_versions,
    portable_bundle_bytes,
    read_document,
    read_version,
    replace_document,
    restore_version,
    update_version_metadata,
)

router = APIRouter(prefix="/sandbox", tags=["sandbox-designs"])

# The Sandbox changes the schema, so only an administrator uses it.
ReadActor = Annotated[User, Depends(require_admin)]
WriteActor = Annotated[User, Depends(require_admin)]
Database = Annotated[Session, Depends(get_db)]


@router.get("/document", response_model=DocumentResponse, operation_id="get_sandbox_document")
def get_document(_actor: ReadActor, db: Database) -> DocumentResponse:
    return _run(db, lambda: read_document(db))


@router.get(
    "/bindings", response_model=SandboxBindingsResponse, operation_id="get_sandbox_bindings"
)
def get_bindings(_actor: ReadActor, db: Database, response: Response) -> SandboxBindingsResponse:
    response.headers["Cache-Control"] = "no-store"
    return _run(db, lambda: read_bindings(db))


@router.put("/document", response_model=DocumentResponse, operation_id="replace_sandbox_document")
def put_document(
    payload: DocumentReplaceRequest, actor: WriteActor, db: Database
) -> DocumentResponse:
    return _run(
        db,
        lambda: replace_document(
            db,
            actor_id=actor.id,
            expected_revision=payload.expected_revision,
            document=payload.document,
        ),
    )


@router.get("/versions", response_model=VersionListResponse, operation_id="list_sandbox_versions")
def get_versions(
    _actor: ReadActor,
    db: Database,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> VersionListResponse:
    return _run(db, lambda: list_versions(db, limit=limit, offset=offset))


@router.post(
    "/versions",
    response_model=VersionDetailResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="create_sandbox_version",
)
def post_version(
    payload: VersionCreateRequest, actor: WriteActor, db: Database
) -> VersionDetailResponse:
    return _run(
        db,
        lambda: create_version(
            db,
            actor_id=actor.id,
            expected_revision=payload.expected_revision,
            kind=payload.kind,
            label=payload.label,
            note=payload.note,
        ),
    )


@router.get(
    "/versions/{version_id}",
    response_model=VersionDetailResponse,
    operation_id="get_sandbox_version",
)
def get_version(version_id: UUID, _actor: ReadActor, db: Database) -> VersionDetailResponse:
    return _run(db, lambda: read_version(db, version_id))


@router.patch(
    "/versions/{version_id}",
    response_model=VersionDetailResponse,
    operation_id="update_sandbox_version_metadata",
)
def patch_version(
    version_id: UUID,
    payload: VersionMetadataUpdateRequest,
    actor: WriteActor,
    db: Database,
) -> VersionDetailResponse:
    return _run(
        db,
        lambda: update_version_metadata(
            db,
            actor_id=actor.id,
            version_id=version_id,
            expected_revision=payload.expected_revision,
            label=payload.label,
            note=payload.note,
            update_note="note" in payload.model_fields_set,
        ),
    )


@router.delete("/versions/{version_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_version(
    version_id: UUID,
    payload: VersionMutationRequest,
    actor: WriteActor,
    db: Database,
) -> Response:
    _run(
        db,
        lambda: delete_version(
            db,
            actor_id=actor.id,
            version_id=version_id,
            expected_revision=payload.expected_revision,
        ),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/versions/{version_id}/restorations",
    response_model=DocumentResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="restore_sandbox_version",
)
def post_restoration(
    version_id: UUID,
    payload: VersionMutationRequest,
    actor: WriteActor,
    db: Database,
) -> DocumentResponse:
    return _run(
        db,
        lambda: restore_version(
            db,
            actor_id=actor.id,
            version_id=version_id,
            expected_revision=payload.expected_revision,
        ),
    )


@router.post(
    "/versions/{version_id}/rollbacks",
    response_model=DocumentResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="rollback_sandbox_release",
)
def post_rollback(
    version_id: UUID,
    payload: VersionMutationRequest,
    actor: WriteActor,
    db: Database,
) -> DocumentResponse:
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail={"code": "rollback_removed", "message": "Restore changes only the draft"},
    )


@router.post("/imports", response_model=DocumentResponse, operation_id="import_sandbox_document")
def post_import(payload: ImportRequest, actor: WriteActor, db: Database) -> DocumentResponse:
    return _run(
        db,
        lambda: import_bundle(
            db,
            actor_id=actor.id,
            expected_revision=payload.expected_revision,
            bundle=payload.bundle,
        ),
    )


@router.get("/export", operation_id="export_sandbox_document")
def get_export(
    _actor: ReadActor,
    db: Database,
    include_versions: Annotated[bool, Query(alias="includeVersions")] = False,
) -> Response:
    bundle = _run(db, lambda: export_bundle(db, include_versions=include_versions))
    return Response(
        content=portable_bundle_bytes(bundle),
        media_type="application/json",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'attachment; filename="openslate-sandbox.json"',
            "X-Content-Type-Options": "nosniff",
        },
    )


def _run[Result](db: Session, operation: Callable[[], Result]) -> Result:
    try:
        return operation()
    except SandboxDesignError as error:
        db.rollback()
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": error.message},
        ) from error
