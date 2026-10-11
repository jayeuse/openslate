"""The repository root, found from the Git checkout rather than a fixed nesting depth.

Tests that read repository files outside backend/ (contracts/, frontend/, infra/) use it,
so they also work from a copied tree such as mutmut's backend/mutants/.
"""

from pathlib import Path

REPOSITORY_ROOT = next(
    parent for parent in Path(__file__).resolve().parents if (parent / ".git").exists()
)
