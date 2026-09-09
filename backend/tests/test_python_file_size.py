"""Enforce the backend handwritten Python file-size limit."""
from __future__ import annotations

from pathlib import Path

MAX_LINES = 500
SOURCE_DIRECTORIES = ("app", "scripts", "tests")
EXCLUDED_DIRECTORY_NAMES = {
    ".nox",
    ".tox",
    ".venv",
    "__pycache__",
    "dist",
    "migrations",
    "site-packages",
    "venv",
}


def _handwritten_python_files() -> list[Path]:
    backend = Path(__file__).parents[1]
    files: list[Path] = []
    for directory_name in SOURCE_DIRECTORIES:
        directory = backend / directory_name
        files.extend(
            path
            for path in directory.rglob("*.py")
            if not EXCLUDED_DIRECTORY_NAMES.intersection(path.parts)
        )
    return sorted(files)


def test_handwritten_backend_python_files_fit_the_size_limit() -> None:
    backend = Path(__file__).parents[1]
    oversized = [
        f"{path.relative_to(backend)}: {len(path.read_text(encoding='utf-8').splitlines())}"
        for path in _handwritten_python_files()
        if len(path.read_text(encoding="utf-8").splitlines()) > MAX_LINES
    ]
    assert not oversized, "Python files exceed 500 lines:\n" + "\n".join(oversized)
