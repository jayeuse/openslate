"""Blank-but-valid upload files for sample Board attachments.

Each builder is deterministic: the same name always gives the same bytes, so a
readback can rebuild the expected bytes after a download. The output matches the
frontend test builder (frontend/tests/helpers/dummy-files.ts) byte for byte, and the
backend upload validation accepts every type. A file is never empty: the browser,
the upload validation and the database all refuse a zero-byte upload.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import PurePosixPath

_OFFICE_MAIN = "application/vnd.openxmlformats-officedocument"
MEDIA_TYPES = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".docx": f"{_OFFICE_MAIN}.wordprocessingml.document",
    ".xlsx": f"{_OFFICE_MAIN}.spreadsheetml.sheet",
    ".pptx": f"{_OFFICE_MAIN}.presentationml.presentation",
}


def _pdf() -> bytes:
    objects = (
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
    )
    body = "%PDF-1.4\n"
    offsets: list[int] = []
    for index, item in enumerate(objects, start=1):
        offsets.append(len(body.encode("latin-1")))
        body += f"{index} 0 obj\n{item}\nendobj\n"
    xref = len(body.encode("latin-1"))
    body += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    body += "".join(f"{offset:010d} 00000 n \n" for offset in offsets)
    body += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return body.encode("latin-1")


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def _png() -> bytes:
    # One white pixel: 8-bit RGB, filter byte 0, then 255 255 255.
    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return b"".join(
        (
            b"\x89PNG\r\n\x1a\n",
            _png_chunk(b"IHDR", header),
            _png_chunk(b"IDAT", zlib.compress(bytes((0, 255, 255, 255)))),
            _png_chunk(b"IEND", b""),
        )
    )


def _jpeg() -> bytes:
    # One white grayscale pixel, baseline. With a quantization table of ones, the
    # only coefficient is DC 1016 (category 10). Each Huffman table holds one
    # one-bit code: DC category 10, and AC end-of-block. The scan bits are
    # 0, 1111111000, 0, padded with ones: 0x7f 0x0f.
    def huffman(table_class: int, symbol: int) -> bytes:
        return bytes((0xFF, 0xC4, 0x00, 0x14, table_class, 1, *([0] * 15), symbol))

    return b"".join(
        (
            bytes((0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00, *([1] * 64))),
            bytes((0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00)),
            huffman(0x00, 0x0A),
            huffman(0x10, 0x00),
            bytes((0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x7F, 0x0F)),
            bytes((0xFF, 0xD9)),
        )
    )


def _zip(entries: tuple[tuple[str, str], ...]) -> bytes:
    """A stored (uncompressed) zip with fixed 1980-01-01 timestamps."""
    dos_date = 0x21
    locals_: list[bytes] = []
    centrals: list[bytes] = []
    offset = 0
    for entry_name, text in entries:
        name, data = entry_name.encode(), text.encode()
        checksum = zlib.crc32(data)
        local = struct.pack(
            "<IHHHHHIIIHH", 0x04034B50, 20, 0, 0, 0, dos_date, checksum, len(data), len(data),
            len(name), 0,
        )  # fmt: skip
        central = struct.pack(
            "<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, 0, 0, dos_date, checksum, len(data),
            len(data), len(name), 0, 0, 0, 0, 0, offset,
        )  # fmt: skip
        locals_.append(local + name + data)
        centrals.append(central + name)
        offset += len(local) + len(name) + len(data)
    directory = b"".join(centrals)
    end = struct.pack(
        "<IHHHHIIH", 0x06054B50, 0, 0, len(entries), len(entries), len(directory), offset, 0
    )
    return b"".join(locals_) + directory + end


_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
_OFFICE = {
    ".docx": (
        "word/document.xml",
        f"{_OFFICE_MAIN}.wordprocessingml.document.main+xml",
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body/></w:document>",
    ),
    ".xlsx": (
        "xl/workbook.xml",
        f"{_OFFICE_MAIN}.spreadsheetml.sheet.main+xml",
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
    ),
    ".pptx": (
        "ppt/presentation.xml",
        f"{_OFFICE_MAIN}.presentationml.presentation.main+xml",
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    ),
}


def _office(extension: str) -> bytes:
    part, content_type, root = _OFFICE[extension]
    return _zip(
        (
            (
                "[Content_Types].xml",
                f'{_XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Default Extension="rels" '
                'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                '<Default Extension="xml" ContentType="application/xml"/>'
                f'<Override PartName="/{part}" ContentType="{content_type}"/></Types>',
            ),
            (
                "_rels/.rels",
                f"{_XML}<Relationships "
                'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/'
                f'2006/relationships/officeDocument" Target="{part}"/></Relationships>',
            ),
            (part, f"{_XML}{root}"),
        )
    )


def extension_of(name: str) -> str:
    return PurePosixPath(name).suffix.lower()


def dummy_file(name: str) -> bytes:
    """Build a blank-but-valid file whose type follows the name's extension."""
    extension = extension_of(name)
    if extension not in MEDIA_TYPES:
        raise ValueError(f"No dummy file type for {name}")
    if extension == ".pdf":
        return _pdf()
    if extension == ".png":
        return _png()
    if extension in {".jpg", ".jpeg"}:
        return _jpeg()
    return _office(extension)
