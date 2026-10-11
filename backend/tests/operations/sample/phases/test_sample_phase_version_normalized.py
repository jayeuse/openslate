"""Expected design versions use the server's normalized design form."""

from __future__ import annotations

import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from operations.sample.phases.plan import phase_version_documents, plan_phases
from tests.operations.sample.sample_datasets import sample_dataset


@pytest.mark.parametrize("pack_key", ["harbor", "school"])
def test_every_expected_design_version_is_server_normalized(pack_key: str) -> None:
    # The server fills defaults such as an empty Text defaultValue when it stores a design,
    # so an expected version must already be in that form or verification reads a mismatch.
    dataset = sample_dataset(pack=pack_key)
    versions = phase_version_documents(dataset, tuple(plan_phases(dataset)))
    assert versions
    for key, document in versions.items():
        normalized = SandboxDocument.model_validate(document).model_dump(
            by_alias=True, mode="json", exclude_none=True
        )
        assert document == normalized, key
