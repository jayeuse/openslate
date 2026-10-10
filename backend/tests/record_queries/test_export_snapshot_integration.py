"""Exports fail closed when their real PostgreSQL security event cannot be recorded."""

import pytest
from sqlalchemy.exc import OperationalError

from app.systems.sandbox.records import export as export_service
from tests.record_queries.export_http_support import (
    ExportWorld,
)
from tests.record_queries.export_http_support import (
    export_world as export_world,
)
from tests.record_queries.export_http_support import (
    fake_provider as fake_provider,
)
from tests.record_queries.export_http_support import (
    fake_provider_account as fake_provider_account,
)

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("format", ["csv", "xlsx"])
def test_registered_export_fails_closed_when_event_persistence_is_unavailable(
    export_world: ExportWorld, monkeypatch: pytest.MonkeyPatch, format: str
) -> None:
    def unavailable_event_writer(*_args: object, **_kwargs: object) -> object:
        raise OperationalError("security event unavailable", {}, RuntimeError("unavailable"))

    monkeypatch.setattr(export_service, "append_security_event", unavailable_event_writer)
    response = export_world.client.post(
        "/api/records/export", json=export_world.payload(format=format)
    )
    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["detail"] == "Unable to record export authorization"
    assert b"Gamma" not in response.content
    assert export_world.events() == []
