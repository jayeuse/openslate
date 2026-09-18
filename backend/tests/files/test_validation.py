"""Uploaded bytes must match an allowed, inspectable format before storage."""

import pytest
from fastapi import HTTPException

from app.systems.platform.files.validation import validate_content


@pytest.mark.parametrize(
    "filename, content",
    [
        ("page.html", b"<html>hello</html>"),
        ("image.png", b"not a png"),
        ("report.pdf", b"%PDF-1.7\nmalformed"),
        ("../report.pdf", b"%PDF-1.7\nmalformed"),
    ],
)
def test_rejects_disallowed_or_uninspectable_content(filename, content):
    with pytest.raises(HTTPException) as caught:
        validate_content(filename, content)
    assert caught.value.status_code == 422
    assert caught.value.detail["code"] == "file_invalid"


def test_malformed_office_xml_returns_controlled_rejection():
    from io import BytesIO
    from zipfile import ZipFile

    output = BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr("[Content_Types].xml", "<not-closed")
        archive.writestr("_rels/.rels", "<Relationships/>")
        archive.writestr("word/document.xml", "<document/>")
    with pytest.raises(HTTPException) as caught:
        validate_content("document.docx", output.getvalue())
    assert caught.value.status_code == 422


def test_parser_deadline_returns_controlled_failure(monkeypatch):
    import subprocess

    from app.systems.platform.files.validation_worker import validate_bounded

    def timeout(*args, **kwargs):
        assert kwargs["timeout"] == 60
        raise subprocess.TimeoutExpired("parser", 60)

    monkeypatch.setattr("app.systems.platform.files.validation_worker.subprocess.run", timeout)
    with pytest.raises(HTTPException) as caught:
        validate_bounded("document.pdf", b"%PDF-1.7")
    assert caught.value.status_code == 503


def test_valid_pdf_and_jpeg_are_inspectable():
    from io import BytesIO

    from PIL import Image
    from pypdf import PdfWriter

    pdf = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(pdf)
    assert validate_content("document.pdf", pdf.getvalue()).media_type == "application/pdf"
    jpeg = BytesIO()
    Image.new("RGB", (2, 2)).save(jpeg, format="JPEG")
    assert validate_content("photo.jpeg", jpeg.getvalue()).content == jpeg.getvalue()


def test_office_requires_matching_package_relationship_and_main_part():
    from io import BytesIO
    from zipfile import ZipFile

    def package(content_type):
        output = BytesIO()
        with ZipFile(output, "w") as archive:
            archive.writestr(
                "[Content_Types].xml",
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Override PartName="/word/document.xml" ContentType="'
                + content_type
                + '"/></Types>',
            )
            archive.writestr(
                "_rels/.rels",
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                'relationships/officeDocument" Target="word/document.xml"/></Relationships>',
            )
            archive.writestr(
                "word/document.xml",
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
            )
        return output.getvalue()

    content_type = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    )
    assert validate_content("document.docx", package(content_type)).content == package(content_type)
    with pytest.raises(HTTPException):
        validate_content("document.docx", package("application/x-wrong"))


def test_encrypted_pdf_and_mismatched_image_extension_are_rejected():
    from io import BytesIO

    from PIL import Image
    from pypdf import PdfWriter

    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.encrypt("test password")
    writer.write(output)
    with pytest.raises(HTTPException):
        validate_content("document.pdf", output.getvalue())
    output = BytesIO()
    Image.new("RGB", (2, 2)).save(output, format="JPEG")
    with pytest.raises(HTTPException):
        validate_content("image.png", output.getvalue())
