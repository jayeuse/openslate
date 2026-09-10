"""Primitive validation and authorization regressions independent of external services."""

from io import BytesIO
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from fastapi import HTTPException
from PIL import Image, PngImagePlugin
from pydantic import ValidationError

from app.systems.files.access import authorize
from app.systems.files.providers import ProviderUnavailable, get_scanner, transfer_slot
from app.systems.files.schemas import FileCreate
from app.systems.files.validation import validate_content
from app.systems.users.models import Role, User


def user(permissions=None, role="operator"):
    return User(
        id=uuid4(),
        status="active",
        is_deleted=False,
        role=Role(role=role, permissions=permissions or {}, is_deleted=False),
        invitation_accepted_at=__import__("datetime").datetime.now(__import__("datetime").UTC),
    )


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


def test_missing_scanner_never_accepts_content():
    with pytest.raises(ProviderUnavailable):
        get_scanner().scan(png(), digest="digest", operation_id=uuid4())


def test_third_buffer_operation_is_rejected_and_capacity_recovers():
    with transfer_slot(), transfer_slot():
        with pytest.raises(HTTPException) as caught:
            with transfer_slot():
                pytest.fail("Third transfer admitted")
        assert caught.value.status_code == 503
    with transfer_slot():
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
    with pytest.raises(ValidationError):
        FileCreate.model_validate(payload)


@pytest.mark.parametrize("purpose", ["library_document", "workspace_logo"])
def test_all_capabilities_do_not_grant_admin_documents(purpose):
    from app.systems.users.permissions import ALL_CAPABILITIES

    actor = user({key: True for key in ALL_CAPABILITIES})
    with pytest.raises(HTTPException) as caught:
        authorize(actor, purpose)
    assert caught.value.status_code == 403


def test_write_only_role_can_upload_but_not_download():
    actor = user({"records.write": True})
    authorize(actor, "record_attachment", write=True)
    with pytest.raises(HTTPException) as caught:
        authorize(actor, "record_attachment")
    assert caught.value.status_code == 403


def test_disabled_admin_is_denied():
    actor = user(role="admin")
    actor.status = "disabled"
    with pytest.raises(HTTPException):
        authorize(actor, "library_document")


def test_unknown_file_purpose_fails_closed_even_for_admin():
    with pytest.raises(HTTPException):
        authorize(user(role="admin"), "unknown")
