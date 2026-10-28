"""Seed one pack at Small into a disposable smoke stack through the sample-data seeder.

``tests/smoke_runner.py`` runs this as a subprocess so the gateway's local certificate
authority (``SSL_CERT_FILE``) applies to every seeder client. Parameters, including the
administrator password, come from a private JSON file; only the run status and the
run directory are printed.
"""

import json
import sys
from datetime import date
from pathlib import Path

from operations.sample.packs import get_pack
from operations.sample.population.run import populate_sample_data


def main(arguments: list[str]) -> int:
    if len(arguments) != 1:
        raise SystemExit("Usage: smoke_seed.py <private-parameters.json>")
    parameters = json.loads(Path(arguments[0]).read_text(encoding="utf-8"))
    report = populate_sample_data(
        api_url=parameters["api_url"],
        origin=parameters["origin"],
        mailpit_url=parameters["mailpit_url"],
        # The installation operator; it invites the pack's own administrator.
        operator_email=parameters["admin_email"],
        expected_operator_id=parameters["admin_id"],
        operator_password=parameters["admin_password"],
        run_root=Path(parameters["run_root"]),
        profile="small",
        seed=int(parameters["seed"]),
        anchor_date=date.fromisoformat(parameters["anchor_date"]),
        organization=get_pack(parameters["organization"]),
        organization_id=parameters["organization_id"],
        partner_organization_id=parameters["partner_organization_id"],
    )
    print(f"status={report.status}", flush=True)
    print(f"run_directory={report.run_directory}", flush=True)
    for issue in report.issues:
        print(f"incomplete: {issue}", flush=True)
    return 0 if report.status == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
