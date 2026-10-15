"""Stack-free contracts of the backup export routes: body limit selector and create schema.

The HTTP owners stay on the stack: the 413 through real signed cookies and the follow-up
UUID parsing (``test_backup_export_admission_integration.py``), the 413 of the create
route (``test_backup_exports_integration.py``) and one private 422 body for the create
route (the same file).
"""

import pytest
from pydantic import ValidationError

from app.core.middleware.file_transfers import backup_export_body_limit
from app.systems.manage.backups.schemas import BackupExportCreate

EXPORT_ID = "01990000-0000-7000-8000-0000000000e1"
ADMISSION = "/api/backups/exports/{}/download-admission"


@pytest.mark.parametrize(
    ("method", "path", "limit"),
    [
        pytest.param("POST", "/api/backups/exports", 1024, id="create"),
        pytest.param("POST", ADMISSION.format(EXPORT_ID), 1024, id="admission-canonical"),
        pytest.param(
            "POST", ADMISSION.format(EXPORT_ID.replace("-", "")), 1024, id="admission-compact"
        ),
        pytest.param("POST", ADMISSION.format("{" + EXPORT_ID + "}"), 1024, id="admission-braced"),
        pytest.param("POST", ADMISSION.format("not-a-uuid"), 1024, id="admission-invalid"),
        pytest.param("GET", "/api/backups/exports", None, id="create-path-not-post"),
        pytest.param("PUT", ADMISSION.format(EXPORT_ID), None, id="admission-path-not-post"),
        pytest.param("POST", ADMISSION.format(""), None, id="empty-segment"),
        pytest.param("POST", ADMISSION.format("a/b"), None, id="segment-with-slash"),
        pytest.param("POST", ADMISSION.format(EXPORT_ID) + "/x", None, id="admission-suffix"),
        pytest.param("POST", "/api/backups/exports/", None, id="create-trailing-slash"),
        pytest.param("POST", "/x/api/backups/exports", None, id="create-prefix"),
        pytest.param("POST", f"/api/backups/exports/{EXPORT_ID}/content", None, id="content-route"),
        pytest.param("POST", "/api/backups", None, id="backup-create"),
    ],
)
def test_only_secret_bearing_export_posts_get_the_small_body_limit(
    method: str, path: str, limit: int | None
) -> None:
    assert backup_export_body_limit(path, method) == limit


@pytest.mark.parametrize(
    ("passphrase", "error"),
    [
        pytest.param("x" * 15, "too_short", id="15"),
        pytest.param("x" * 129, "too_long", id="129"),
        pytest.param(" leading valid passphrase", "value_error", id="leading-space"),
        pytest.param("valid passphrase\n", "value_error", id="trailing-newline"),
        pytest.param(" " + "x" * 20, "value_error", id="edge-no-break-space"),
        pytest.param("🌿" * 129, "value_error", id="516-bytes"),
        pytest.param(True, "value_error", id="boolean"),
        pytest.param(None, "value_error", id="null"),
        pytest.param({"nested": "Example export passphrase"}, "value_error", id="object"),
    ],
)
def test_export_passphrase_must_be_bounded_printable_text(passphrase: object, error: str) -> None:
    with pytest.raises(ValidationError) as raised:
        BackupExportCreate.model_validate({"backup_run_id": EXPORT_ID, "passphrase": passphrase})
    assert [(item["loc"], item["type"]) for item in raised.value.errors()] == [
        (("passphrase",), error)
    ]


@pytest.mark.parametrize(
    "passphrase",
    [
        pytest.param("x" * 16, id="16"),
        pytest.param("x" * 128, id="128"),
        pytest.param("🌿" * 128, id="512-bytes"),
        pytest.param("Example export 🌿 passphrase", id="inner-space"),
    ],
)
def test_export_passphrase_accepts_bounded_printable_text(passphrase: str) -> None:
    created = BackupExportCreate.model_validate(
        {"backup_run_id": EXPORT_ID, "passphrase": passphrase}
    )
    assert created.passphrase.get_secret_value() == passphrase
    assert str(created.backup_run_id) == EXPORT_ID


def test_export_create_refuses_unknown_keys() -> None:
    with pytest.raises(ValidationError) as raised:
        BackupExportCreate.model_validate(
            {"backup_run_id": EXPORT_ID, "passphrase": "x" * 16, "secret": "value"}
        )
    assert [(item["loc"], item["type"]) for item in raised.value.errors()] == [
        (("secret",), "extra_forbidden")
    ]
