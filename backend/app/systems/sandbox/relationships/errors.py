"""Relationship domain errors mapped by the HTTP router."""


class RelationshipError(Exception):
    status_code = 409

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class RelationshipNotFound(RelationshipError):
    status_code = 404


class RelationshipInvalid(RelationshipError):
    status_code = 422


class RelationshipUnavailable(RelationshipError):
    status_code = 503


class RelationshipConflict(RelationshipError):
    status_code = 409


__all__ = [
    "RelationshipConflict",
    "RelationshipError",
    "RelationshipInvalid",
    "RelationshipNotFound",
    "RelationshipUnavailable",
]
