"""Safe operator messages and identifiers for sample-data failure records."""

from __future__ import annotations

from uuid import UUID

_JOURNAL_VALUE_MESSAGES = frozenset(
    {
        "Sample journal mappings accept identifier values only",
        "Sample journal server mappings require a UUID",
    }
)


def safe_operator_message(error: BaseException) -> str | None:
    """Expose messages only from local operator errors and known journal guards."""
    from operations.sample.phases.actions import SamplePhaseActionError
    from operations.sample.population.content import SampleContentError
    from operations.sample.population.run import SamplePopulationError

    if type(error) in {SampleContentError, SamplePopulationError, SamplePhaseActionError}:
        return str(error)
    if type(error) is ValueError and len(error.args) == 1:
        value = error.args[0]
        if type(value) is str and value in _JOURNAL_VALUE_MESSAGES:
            return value
    return None


def safe_request_metadata(error: BaseException) -> dict[str, str]:
    """Retain canonical client request IDs without trusting arbitrary attributes."""
    from operations.sample.client import SampleClientError
    from operations.sample.phases.actions import SamplePhaseActionError

    if not isinstance(error, (SampleClientError, SamplePhaseActionError)):
        return {}
    metadata: dict[str, str] = {}
    for name in ("attempt_id", "request_id"):
        value = getattr(error, name, None)
        if type(value) is not str:
            continue
        try:
            normalized = str(UUID(value))
        except ValueError:
            continue
        if value == normalized:
            metadata[name] = normalized
    status_code = getattr(error, "status_code", None)
    if type(status_code) is int and 100 <= status_code <= 599:
        metadata["status_code"] = str(status_code)
    return metadata
