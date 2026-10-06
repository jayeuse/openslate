from datetime import UTC, datetime
from types import ModuleType
from typing import cast

import pytest
from fastapi import FastAPI, HTTPException, status
from fastapi.testclient import TestClient
from pydantic import ValidationError
from uuid6 import uuid7

from app.core.config import get_settings
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.files.models import File


def _router_module() -> ModuleType:
    from app.systems.manage.workspace import router

    return router


def _schemas_module() -> ModuleType:
    from app.systems.manage.workspace import schemas

    return schemas


def _profile(revision: int = 3) -> WorkspaceProfile:
    return WorkspaceProfile(
        id=uuid7(),
        display_name="OpenSlate",
        legal_name=None,
        description=None,
        contact_email="operations@example.com",
        contact_phone=None,
        postal_address=None,
        logo_file_id=None,
        timezone="UTC",
        locale="en-US",
        mark="RS",
        currency="PHP",
        week_start="monday",
        business_hours="09:00–18:00",
        theme="slate",
        invitation_expiry_days=7,
        guest_duration_days=30,
        revision=revision,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )


class _Session:
    def __init__(self, profile: object | None, results: list[object | None] | None = None) -> None:
        self.profile = profile
        self.results = iter(results or [profile])
        self.commit_count = 0
        self.rollback_count = 0

    def scalar(self, _statement: object) -> object | None:
        return next(self.results, self.profile)

    def commit(self) -> None:
        self.commit_count += 1

    def rollback(self) -> None:
        self.rollback_count += 1


def _client(
    monkeypatch: pytest.MonkeyPatch,
    database: _Session,
    actor: object = type("Actor", (), {"id": uuid7()})(),
) -> TestClient:
    from app.common.dependencies import get_current_user
    from app.core.database import get_db
    from app.main import create_app

    workspace_router = _router_module()
    application = create_app()
    application.dependency_overrides[get_db] = lambda: database
    application.dependency_overrides[get_current_user] = lambda: actor
    monkeypatch.setattr(
        workspace_router,
        "require_fresh_exact_admin",
        lambda _db, _actor_id: actor,
    )
    return TestClient(application)


def _logo(*, state: str = "ready", purpose: str = "workspace_logo", deleted: bool = False) -> File:
    return File(
        id=uuid7(),
        purpose=purpose,
        creator_id=uuid7(),
        filename="workspace.png",
        media_type="image/png",
        expected_size=1024,
        actual_size=1024,
        digest="a" * 64,
        object_key="logo-object",
        state=state,
        is_deleted=deleted,
    )


def test_workspace_update_schema_rejects_extra_and_invalid_regional_values() -> None:
    schemas = _schemas_module()

    with pytest.raises(ValidationError):
        schemas.WorkspaceUpdate(revision=3, unknown="value")
    with pytest.raises(ValidationError):
        schemas.WorkspaceUpdate(revision=3, timezone="Not/A_Timezone")
    with pytest.raises(ValidationError):
        schemas.WorkspaceUpdate(revision=3, locale="not_a_locale")
    with pytest.raises(ValidationError):
        schemas.WorkspaceUpdate(revision=3, display_name=" ")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("timezone", None),
        ("timezone", ""),
        ("timezone", "  "),
        ("locale", None),
        ("locale", ""),
        ("locale", "  "),
        ("locale", "root"),
        ("locale", "en_US"),
        ("locale", "en-US.UTF-8"),
        ("locale", "en-US@calendar=gregory"),
        ("locale", "en-US-u-ca-gregory"),
    ],
)
def test_workspace_update_schema_rejects_supplied_blank_or_unsupported_region_values(
    field: str,
    value: object,
) -> None:
    schemas = _schemas_module()

    with pytest.raises(ValidationError):
        schemas.WorkspaceUpdate(revision=3, **{field: value})


@pytest.mark.parametrize(
    ("raw_locale", "canonical_locale"),
    [
        ("EN-us", "en-US"),
        ("zh-Hant-TW", "zh-Hant-TW"),
        ("de-CH-1901", "de-CH"),
    ],
)
def test_workspace_update_schema_canonicalizes_supported_hyphenated_locales(
    raw_locale: str,
    canonical_locale: str,
) -> None:
    schemas = _schemas_module()

    payload = schemas.WorkspaceUpdate(revision=3, locale=raw_locale)

    assert payload.locale == canonical_locale


def test_workspace_update_schema_keeps_omitted_region_fields_out_of_the_update() -> None:
    schemas = _schemas_module()

    payload = schemas.WorkspaceUpdate(revision=3, display_name="Renamed")

    assert "timezone" not in payload.model_fields_set
    assert "locale" not in payload.model_fields_set


@pytest.mark.parametrize("purge_enabled", [False, True])
def test_get_workspace_returns_existing_singleton_without_creating_it(
    monkeypatch: pytest.MonkeyPatch,
    purge_enabled: bool,
) -> None:
    database = _Session(_profile())
    monkeypatch.setattr(get_settings(), "lifecycle_purge_enabled", purge_enabled)

    before = datetime.now(UTC).date()
    response = _client(monkeypatch, database).get("/api/workspace")
    after = datetime.now(UTC).date()

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["display_name"] == "OpenSlate"
    assert response.json()["revision"] == 3
    assert response.json()["today"] in {before.isoformat(), after.isoformat()}
    assert response.json()["purge_enabled"] is purge_enabled
    assert database.commit_count == 0


def test_get_workspace_fails_closed_when_seed_row_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = _Session(None)

    response = _client(monkeypatch, database).get("/api/workspace")

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.json()["detail"]["code"] == "workspace_unavailable"
    assert database.commit_count == 0


def test_workspace_patch_rejects_stale_revision_without_writing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = _profile(revision=4)
    database = _Session(profile)

    response = _client(monkeypatch, database).patch(
        "/api/workspace",
        json={"revision": 3, "display_name": "Renamed", "currency": "SGD"},
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json()["detail"]["code"] == "stale_revision"
    assert profile.display_name == "OpenSlate"
    assert profile.currency == "PHP"
    assert database.commit_count == 0


@pytest.mark.parametrize(
    "body",
    [
        {"revision": 3, "timezone": None},
        {"revision": 3, "timezone": " "},
        {"revision": 3, "locale": None},
        {"revision": 3, "locale": "en-US-u-ca-gregory"},
        {"revision": 3, "currency": "ZZZ"},
        {"revision": 3, "currency": "US"},
        {"revision": 3, "currency": None},
        {"revision": 3, "week_start": "tuesday"},
        {"revision": 3, "week_start": None},
        {"revision": 3, "mark": None},
        {"revision": 3, "mark": "x" * 33},
        {"revision": 3, "business_hours": None},
        {"revision": 3, "business_hours": "x" * 201},
        {"revision": 3, "theme": None},
        {"revision": 3, "theme": "sepia"},
        {"revision": 3, "theme": "Stockroom"},
        {"revision": 3, "theme": " stockroom "},
        {"revision": 3, "purge_enabled": False},
        {"revision": 3, "purge_enabled": True},
    ],
)
def test_workspace_patch_rejects_invalid_supplied_region_without_writing(
    monkeypatch: pytest.MonkeyPatch,
    body: dict[str, object],
) -> None:
    profile = _profile()
    database = _Session(profile)

    response = _client(monkeypatch, database).patch("/api/workspace", json=body)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert profile.timezone == "UTC"
    assert profile.locale == "en-US"
    assert database.commit_count == 0


def test_workspace_patch_uses_exact_admin_and_increments_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = _profile()
    database = _Session(profile)
    actor = type("Actor", (), {"id": uuid7()})()

    response = _client(monkeypatch, database, actor).patch(
        "/api/workspace",
        json={
            "revision": 3,
            "display_name": "OpenSlate Operations",
            "locale": "en-GB",
            "currency": " sgD ",
            "week_start": "sunday",
            "business_hours": " 08:00–17:00 ",
            "mark": " Compass ",
        },
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["display_name"] == "OpenSlate Operations"
    assert response.json()["locale"] == "en-GB"
    assert response.json()["currency"] == "SGD"
    assert response.json()["week_start"] == "sunday"
    assert response.json()["business_hours"] == "08:00–17:00"
    assert response.json()["mark"] == "Compass"
    assert profile.timezone == "UTC"
    assert response.json()["revision"] == 4
    assert profile.performed_by == actor.id
    assert database.commit_count == 1


def test_workspace_patch_propagates_exact_admin_denial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = _Session(_profile())
    workspace_router = _router_module()
    client = _client(monkeypatch, database)
    monkeypatch.setattr(
        workspace_router,
        "require_fresh_exact_admin",
        lambda _db, _actor_id: (_ for _ in ()).throw(
            HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        ),
    )

    response = client.patch("/api/workspace", json={"revision": 3, "display_name": "Blocked"})

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert database.commit_count == 0


def test_workspace_response_contract_has_only_public_profile_fields() -> None:
    schemas = _schemas_module()
    fields = set(schemas.WorkspaceResponse.model_fields)

    assert fields == {
        "id",
        "display_name",
        "legal_name",
        "description",
        "contact_email",
        "contact_phone",
        "postal_address",
        "logo_file_id",
        "timezone",
        "locale",
        "mark",
        "currency",
        "week_start",
        "business_hours",
        "theme",
        "invitation_expiry_days",
        "guest_duration_days",
        "revision",
        "created_at",
        "updated_at",
    }
    assert all(field not in fields for field in {"singleton_key", "performed_by", "is_deleted"})
    properties = schemas.WorkspaceResponse.model_json_schema(mode="serialization")["properties"]
    assert properties["purge_enabled"]["type"] == "boolean"
    assert properties["purge_enabled"]["readOnly"] is True


def test_workspace_response_exposes_server_day_in_workspace_timezone() -> None:
    from datetime import date
    from zoneinfo import ZoneInfo

    schemas = _schemas_module()
    profile = _profile()
    profile.timezone = "Pacific/Kiritimati"

    before = datetime.now(ZoneInfo(profile.timezone)).date()
    response = schemas.WorkspaceResponse.model_validate(profile).model_dump(mode="json")
    after = datetime.now(ZoneInfo(profile.timezone)).date()

    assert response["today"] in {before.isoformat(), after.isoformat()}
    assert date.fromisoformat(response["today"]).isoformat() == response["today"]


def test_workspace_model_redacts_contact_fields_from_audit_snapshots() -> None:
    from app.systems.manage.audit.snapshots import REDACTED, serialize_record
    from app.systems.manage.workspace.models import WorkspaceProfile

    profile = WorkspaceProfile(
        display_name="OpenSlate",
        contact_email="operations@example.com",
        contact_phone="123",
        postal_address="A private address",
    )

    snapshot = serialize_record(profile)

    assert snapshot["contact_email"] == REDACTED
    assert snapshot["contact_phone"] == REDACTED
    assert snapshot["postal_address"] == REDACTED


def test_workspace_patch_sets_only_a_ready_clean_workspace_logo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = _profile()
    logo = _logo()
    database = _Session(profile, [profile, logo])

    response = _client(monkeypatch, database).patch(
        "/api/workspace",
        json={"revision": 3, "logo_file_id": str(logo.id)},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["logo_file_id"] == str(logo.id)
    assert profile.logo_file_id == logo.id
    assert database.commit_count == 1


@pytest.mark.parametrize(
    ("state", "purpose", "deleted"),
    [
        ("uploading", "workspace_logo", False),
        ("ready", "library_document", False),
        ("ready", "workspace_logo", True),
    ],
)
def test_workspace_patch_rejects_unavailable_logo_without_replacing_current_logo(
    monkeypatch: pytest.MonkeyPatch,
    state: str,
    purpose: str,
    deleted: bool,
) -> None:
    profile = _profile()
    old_logo_id = uuid7()
    profile.logo_file_id = old_logo_id
    candidate = _logo(state=state, purpose=purpose, deleted=deleted)
    database = _Session(profile, [profile, candidate])

    response = _client(monkeypatch, database).patch(
        "/api/workspace",
        json={"revision": 3, "logo_file_id": str(candidate.id)},
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json()["detail"]["code"] == "logo_not_ready"
    assert profile.logo_file_id == old_logo_id
    assert database.commit_count == 0


def test_workspace_logo_download_uses_only_current_ready_logo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = _profile()
    logo = _logo()
    profile.logo_file_id = logo.id
    database = _Session(profile, [profile, logo, profile, logo])
    workspace_router = _router_module()
    captured: dict[str, object] = {}

    def download(
        _db: object,
        actor_id: object,
        file_id: object,
        storage: object,
        *,
        current_logo: bool,
    ) -> tuple[bytes, str, str]:
        captured.update(
            actor_id=actor_id,
            file_id=file_id,
            storage=storage,
            current_logo=current_logo,
        )
        return b"png-bytes", "image/png", "workspace.png"

    monkeypatch.setattr(workspace_router.file_service, "download", download)
    storage = object()
    client = _client(monkeypatch, database)
    cast(FastAPI, client.app).dependency_overrides[workspace_router.get_storage] = lambda: storage

    response = client.get("/api/workspace/logo")

    assert response.status_code == status.HTTP_200_OK
    assert response.content == b"png-bytes"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert captured["file_id"] == logo.id
    assert captured["storage"] is storage
    assert captured["current_logo"] is True


def test_workspace_logo_download_rejects_replacement_during_storage_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = _profile()
    logo = _logo()
    profile.logo_file_id = logo.id
    database = _Session(profile, [profile, logo, profile, logo])
    workspace_router = _router_module()

    def download(*_args: object, **_kwargs: object) -> tuple[bytes, str, str]:
        profile.logo_file_id = None
        return b"stale-logo", "image/png", "workspace.png"

    monkeypatch.setattr(workspace_router.file_service, "download", download)
    client = _client(monkeypatch, database)
    cast(FastAPI, client.app).dependency_overrides[workspace_router.get_storage] = lambda: object()

    response = client.get("/api/workspace/logo")

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_workspace_security_route_is_registered(monkeypatch: pytest.MonkeyPatch) -> None:
    database = _Session(_profile())
    response = _client(monkeypatch, database).get("/api/workspace/security")
    assert response.status_code != status.HTTP_404_NOT_FOUND
