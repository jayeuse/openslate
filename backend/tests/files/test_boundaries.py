"""Primitive validation and authorization regressions independent of external services."""

from io import BytesIO
from unittest.mock import Mock
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from fastapi import HTTPException
from PIL import Image, PngImagePlugin
from pydantic import ValidationError

from app.systems.access.users.models import UserRole
from app.systems.platform.files import providers
from app.systems.platform.files.access import authorize
from app.systems.platform.files.providers import transfer_admission
from app.systems.platform.files.schemas import FileCreate
from app.systems.platform.files.validation import validate_content
from tests.users.user_support import local_user


def user(role="member"):
    actor, membership = local_user(UserRole(role))
    db = Mock()
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]
    return actor, db


def png():
    output = BytesIO()
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("private", "must be stripped")
    Image.new("RGB", (2, 2)).save(output, format="PNG", pnginfo=metadata)
    return output.getvalue()


def office(extra_name, extra_payload):
    output = BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("_rels/.rels", "<Relationships/>")
        archive.writestr("word/document.xml", "<document/>")
        archive.writestr(extra_name, extra_payload)
    return output.getvalue()


def test_logo_strips_metadata_and_preserves_decoded_pixels():
    result = validate_content("logo.png", png(), logo=True)
    with Image.open(BytesIO(result.content)) as image:
        assert "private" not in image.info
        assert image.size == (2, 2)
    assert result.media_type == "image/png"


@pytest.mark.parametrize(
    "name,payload",
    [
        ("word/vbaProject.bin", b"macro"),
        ("../evil.xml", b"<evil/>"),
        ("word/bomb.txt", b"0" * 200_000),
        ("word/entities.xml", b'<!DOCTYPE x [<!ENTITY a "boom">]><x>&a;</x>'),
        (
            "word/_rels/document.xml.rels",
            b'<Relationships><Relationship TargetMode="External" Type="template" Target="https://evil.example"/></Relationships>',
        ),
    ],
)
def test_office_rejects_dangerous_containers_as_controlled_error(name, payload):
    with pytest.raises(HTTPException) as caught:
        validate_content("document.docx", office(name, payload))
    assert caught.value.status_code == 422


def test_a_buffer_past_the_memory_budget_is_rejected_and_capacity_recovers(monkeypatch):
    monkeypatch.setattr(providers, "_pool", providers.FileCapacity(10 * 1024 * 1024, 4))
    with transfer_admission(6 * 1024 * 1024), transfer_admission(4 * 1024 * 1024):
        with pytest.raises(HTTPException) as caught:
            with transfer_admission(1):
                pytest.fail("A buffer past the budget was admitted")
        assert caught.value.status_code == 503
    with transfer_admission(10 * 1024 * 1024):
        pass


@pytest.mark.parametrize(
    "payload",
    [
        {"purpose": "record_attachment", "filename": "a.pdf", "expected_size": 10},
        {
            "purpose": "library_document",
            "record_id": str(uuid4()),
            "filename": "a.pdf",
            "expected_size": 10,
        },
        {"purpose": "workspace_logo", "filename": "a.png", "expected_size": 2097153},
        {"purpose": "library_document", "filename": "../a.pdf", "expected_size": 10},
        {
            "purpose": "library_document",
            "filename": "a.pdf",
            "expected_size": 10,
            "object_key": "evil",
        },
    ],
)
def test_reservation_rejects_parent_forgery_limits_and_provider_keys(payload):
    if payload["purpose"] == "library_document":
        payload = {"department_id": str(uuid4()), **payload}
    with pytest.raises(ValidationError):
        FileCreate.model_validate(payload)


@pytest.mark.parametrize("purpose", ["workspace_logo"])
def test_members_do_not_get_admin_documents(purpose):
    actor, db = user()
    with pytest.raises(HTTPException) as caught:
        authorize(db, actor, purpose)
    assert caught.value.status_code == 403


def test_disabled_admin_is_denied():
    actor, db = user(role="admin")
    actor.status = "disabled"
    with pytest.raises(HTTPException):
        authorize(db, actor, "library_document")


def test_unknown_file_purpose_fails_closed_even_for_admin():
    actor, db = user(role="admin")
    with pytest.raises(HTTPException):
        authorize(db, actor, "unknown")
