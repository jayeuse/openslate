"""Record purge confirms the canonical displayed title, including long titles."""

from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session

from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle import router as lifecycle
from app.systems.sandbox.records.models import Record
from tests.boards.support import client
from tests.boards.test_permanent_delete import _actor
from tests.reports.test_report_routes import _module

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("long_title", [False, True])
def test_record_purge_confirms_displayed_title_without_shortening(
    integration_owner_db: Session,
    monkeypatch,
    long_title: bool,
) -> None:
    db = integration_owner_db
    actor = _actor(db, admin=True)
    module, field = _module(db)
    field.type = FieldType.LONG_TEXT
    module.title_field_id = field.id
    title = "Record title " + ("x" * 200 if long_title else "short")
    record = Record(
        module_id=module.id,
        data={str(field.id): title},
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add(record)
    db.commit()
    monkeypatch.setattr(
        lifecycle, "get_settings", lambda: type("Settings", (), {"lifecycle_purge_enabled": True})()
    )
    monkeypatch.setattr(
        "app.systems.sandbox.lifecycle.password.ProviderPasswordGrantClient.verify_password",
        lambda *args: actor.id,
    )
    path = f"/api/records/{record.id}/purge"
    with client(db, actor, lifecycle.router) as api:
        preview = api.post(f"{path}/preview")
        assert preview.status_code == 200, preview.text
        assert preview.json()["confirmation_name"] == title
        result = api.post(
            path,
            json={
                "token": preview.json()["token"],
                "confirmation_name": title,
                "password": "synthetic-step-up",
            },
        )
        assert result.status_code == 200, result.text
    assert db.get(Record, record.id) is None


@pytest.mark.parametrize("change", ["selected_field", "select_label"])
def test_record_purge_title_definition_drift_does_not_delete(
    integration_owner_db: Session, monkeypatch, change: str
) -> None:
    db = integration_owner_db
    actor = _actor(db, admin=True)
    module, field = _module(db)
    field.type = FieldType.SELECT
    field.config = {"options": [{"id": "ready", "label": "Ready"}]}
    module.title_field_id = field.id
    second = Field(
        module_id=module.id, name="Other title", type=FieldType.TEXT, position=1, config={}
    )
    db.add(second)
    db.flush()
    record = Record(
        module_id=module.id,
        data={str(field.id): "ready", str(second.id): "Ready"},
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add(record)
    db.commit()
    monkeypatch.setattr(
        lifecycle, "get_settings", lambda: type("Settings", (), {"lifecycle_purge_enabled": True})()
    )
    path = f"/api/records/{record.id}/purge"
    with client(db, actor, lifecycle.router) as api:
        preview = api.post(f"{path}/preview")
        assert preview.status_code == 200, preview.text

        def change_title(*args):
            if change == "selected_field":
                module.title_field_id = second.id
            else:
                field.config = {"options": [{"id": "ready", "label": "Changed"}]}
            db.commit()
            return actor.id

        monkeypatch.setattr(
            "app.systems.sandbox.lifecycle.password.ProviderPasswordGrantClient.verify_password",
            change_title,
        )
        result = api.post(
            path,
            json={
                "token": preview.json()["token"],
                "confirmation_name": preview.json()["confirmation_name"],
                "password": "synthetic-step-up",
            },
        )
        assert result.status_code == 409, result.text
    assert db.get(Record, record.id) is not None
