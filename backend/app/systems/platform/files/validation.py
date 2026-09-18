"""Inspect bytes before storage; no parser may fetch external resources."""

from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePosixPath
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile

from defusedxml.ElementTree import fromstring
from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader
from pypdf.errors import PdfReadError

MAX_BYTES = 25 * 1024 * 1024
LOGO_BYTES = 2 * 1024 * 1024
MIME = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


@dataclass(frozen=True)
class ValidatedContent:
    content: bytes
    media_type: str


def invalid() -> HTTPException:
    return HTTPException(422, detail={"code": "file_invalid", "message": "File is not inspectable"})


def _image(content: bytes, extension: str, logo: bool) -> bytes:
    with Image.open(BytesIO(content)) as image:
        if image.format != ("PNG" if extension == ".png" else "JPEG"):
            raise invalid()
        if image.width * image.height > 16_000_000 or max(image.size) > 8192:
            raise invalid()
        if getattr(image, "n_frames", 1) != 1:
            raise invalid()
        image.load()
        if not logo:
            return content
        output = BytesIO()
        image.convert("RGBA" if extension == ".png" else "RGB").save(
            output,
            format="PNG" if extension == ".png" else "JPEG",
        )
        result = output.getvalue()
        if len(result) > LOGO_BYTES:
            raise invalid()
        return result


def _office(content: bytes, extension: str) -> None:
    root = {
        ".docx": "word/document.xml",
        ".xlsx": "xl/workbook.xml",
        ".pptx": "ppt/presentation.xml",
    }[extension]
    with ZipFile(BytesIO(content)) as archive:
        entries = archive.infolist()
        if len(entries) > 2048:
            raise invalid()
        names: set[str] = set()
        content_type_valid = False
        root_relationship_valid = False
        main_root_valid = False
        total = 0
        for entry in entries:
            name = entry.filename
            path = PurePosixPath(name)
            lower = name.lower()
            if (
                name in names
                or path.is_absolute()
                or ".." in path.parts
                or "\\" in name
                or ":" in name
                or "\x00" in name
                or entry.flag_bits & 1
                or (entry.external_attr >> 16) & 0o170000 == 0o120000
            ):
                raise invalid()
            names.add(name)
            if any(token in lower for token in ("vba", "embeddings/", "externallinks/")):
                raise invalid()
            if path.suffix.lower() in {".zip", ".docx", ".xlsx", ".pptx", ".bin"}:
                raise invalid()
            if entry.file_size > MAX_BYTES or entry.file_size > max(entry.compress_size, 1) * 100:
                raise invalid()
            with archive.open(entry) as source:
                payload = source.read(MAX_BYTES + 1)
            total += len(payload)
            if len(payload) > MAX_BYTES or total > 100 * 1024 * 1024:
                raise invalid()
            if lower.endswith((".xml", ".rels")):
                element = fromstring(
                    payload, forbid_dtd=True, forbid_entities=True, forbid_external=True
                )
                if name == root:
                    expected_tag = {
                        ".docx": "document",
                        ".xlsx": "workbook",
                        ".pptx": "presentation",
                    }[extension]
                    expected_namespace = {
                        ".docx": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
                        ".xlsx": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
                        ".pptx": "http://schemas.openxmlformats.org/presentationml/2006/main",
                    }[extension]
                    main_root_valid = element.tag == "{" + expected_namespace + "}" + expected_tag
                for node in element.iter():
                    if name == "[Content_Types].xml":
                        expected_content_type = {
                            ".docx": (
                                "application/vnd.openxmlformats-officedocument."
                                "wordprocessingml.document.main+xml"
                            ),
                            ".xlsx": (
                                "application/vnd.openxmlformats-officedocument."
                                "spreadsheetml.sheet.main+xml"
                            ),
                            ".pptx": (
                                "application/vnd.openxmlformats-officedocument."
                                "presentationml.presentation.main+xml"
                            ),
                        }[extension]
                        if (
                            node.tag.endswith("}Override")
                            and node.attrib.get("PartName") == "/" + root
                            and node.attrib.get("ContentType") == expected_content_type
                        ):
                            content_type_valid = True
                    if (
                        name == "_rels/.rels"
                        and node.attrib.get("Type")
                        == (
                            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
                        )
                        and node.attrib.get("Target") in {root, "/" + root}
                    ):
                        root_relationship_valid = (
                            node.attrib.get("TargetMode", "Internal") == "Internal"
                        )
                    content_type = node.attrib.get("ContentType", "").lower()
                    if any(token in content_type for token in ("macroenabled", "vba", "oleobject")):
                        raise invalid()
                    if node.attrib.get("TargetMode", "").lower() == "external":
                        relation = node.attrib.get("Type", "")
                        target = node.attrib.get("Target", "")
                        if not relation.endswith("/hyperlink") or not target.startswith(
                            ("https://", "http://")
                        ):
                            raise invalid()
        if not (content_type_valid and root_relationship_valid and main_root_valid):
            raise invalid()


def validate_content(filename: str, content: bytes, *, logo: bool = False) -> ValidatedContent:
    extension = PurePosixPath(filename).suffix.lower()
    if (
        extension not in MIME
        or any(ord(c) < 32 or c in "/\\" for c in filename)
        or not content
        or len(content) > (LOGO_BYTES if logo else MAX_BYTES)
        or logo
        and extension not in {".png", ".jpg", ".jpeg"}
    ):
        raise invalid()
    try:
        if extension in {".png", ".jpg", ".jpeg"}:
            content = _image(content, extension, logo)
        elif extension == ".pdf":
            if not content.startswith(b"%PDF-"):
                raise invalid()
            reader = PdfReader(BytesIO(content), strict=True)
            if reader.is_encrypted or not reader.pages:
                raise invalid()
            # Resolve page objects, rather than accepting only a PDF signature.
            for page in reader.pages:
                _ = page.mediabox
        else:
            _office(content, extension)
    except HTTPException:
        raise
    except (
        ValueError,
        OSError,
        KeyError,
        BadZipFile,
        PdfReadError,
        ParseError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
    ) as error:
        raise invalid() from error
    return ValidatedContent(content, MIME[extension])
