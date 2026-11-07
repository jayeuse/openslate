"""The worker creates audit months on PostgreSQL as the runtime role (D20)."""

from types import SimpleNamespace

import pytest
from sqlalchemy import text

from app.systems.platform.scheduling import worker as worker_module
from tests.migrations.audit_partition_support import (
    AuditEngines,
    leaf_names,
    month_starts,
    partition_name,
)
from tests.migrations.audit_partition_support import (
    audit_engines as audit_engines,
)

pytestmark = pytest.mark.integration


def test_the_worker_commits_a_missing_month_as_the_runtime(
    audit_engines: AuditEngines, monkeypatch: pytest.MonkeyPatch
) -> None:
    with audit_engines.owner.begin() as connection:
        missing = partition_name(month_starts(connection)[2])
        connection.execute(text(f"DROP TABLE public.{missing}"))
    monkeypatch.setattr(worker_module, "get_engine", lambda: audit_engines.runtime)

    try:
        worker_module.ReportSchedulingWorker(
            SimpleNamespace(environment="test", e2e_background_workers=False)
        ).ensure_audit_partitions_once()

        with audit_engines.owner.connect() as connection:
            assert missing in leaf_names(connection)
    finally:
        with audit_engines.owner.begin() as connection:
            connection.execute(text("SELECT public.ensure_audit_partitions()"))
