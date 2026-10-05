"""Seeded Board attachments use blank files that the real upload validation accepts."""

from __future__ import annotations

import pytest

from app.systems.platform.files.validation import validate_content
from operations.sample.dummy_files import MEDIA_TYPES, dummy_file

NAMES = (
    "Dock 3 loading plan.pdf",
    "Yard layout.png",
    "Crane cab view.jpg",
    "Gate camera still.JPEG",
    "Year 9 trip consent form.docx",
    "Spring timetable changes.xlsx",
    "Induction briefing.pptx",
)


@pytest.mark.parametrize("name", NAMES)
def test_every_dummy_file_passes_upload_validation_and_is_deterministic(name: str) -> None:
    content = dummy_file(name)

    validated = validate_content(name, content)

    assert 0 < len(content) <= 2048
    assert validated.content == content
    assert validated.media_type == MEDIA_TYPES[name[name.rindex(".") :].lower()]
    assert dummy_file(name) == content


def test_dummy_files_refuse_a_type_that_uploads_refuse() -> None:
    with pytest.raises(ValueError, match="No dummy file type"):
        dummy_file("notes.txt")
