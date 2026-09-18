"""Shared validation for user and role PATCH commands."""

from fastapi import HTTPException, status
from pydantic import BaseModel


def require_non_null_patch(payload: BaseModel) -> None:
    if not payload.model_fields_set or any(
        getattr(payload, field) is None for field in payload.model_fields_set
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )
