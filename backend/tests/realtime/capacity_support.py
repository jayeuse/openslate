"""S02-derived numeric guards/footprints, bound to the current disposable manifest."""

import ipaddress
import json
import math
import os
import re
import subprocess
import time
from pathlib import Path

from psycopg import connect

from app.core.config.instance import assert_psycopg_target, instance_target_for_process
from operations.provision_database_role import _postgres_url, _psycopg_url


def distribution(values):
    rows = sorted(values)
    return (
        {
            "n": len(rows),
            "p95": rows[math.ceil(len(rows) * 0.95) - 1],
            "min": rows[0],
            "max": rows[-1],
        }
        if rows
        else {"n": 0}
    )


def machine():
    output = subprocess.check_output(["memory_pressure", "-Q"], text=True, timeout=5)
    match = re.search(r"System-wide memory free percentage:\s*(\d+)%", output)
    if not match:
        raise RuntimeError("RAM headroom unavailable")
    return {
        "at": time.monotonic(),
        "ram_headroom_percent": int(match[1]),
        "load1": os.getloadavg()[0],
    }


class Metrics:
    def __init__(self):
        env = dict(os.environ)
        self.target = instance_target_for_process(
            env["MIGRATION_DATABASE_URL"], "openslate_owner", env
        )
        if self.target is None:
            raise RuntimeError("A guarded disposable target is required")
        self.url = _psycopg_url(_postgres_url(env["DATABASE_BOOTSTRAP_URL"], name="bootstrap"))
        manifest = json.loads(Path(env["OPENSLATE_TEST_DATABASE_MANIFEST"]).read_text())
        self.realtime = manifest["ownership"]["service_ids"]["realtime"]
        self.network = manifest["ownership"]["project"] + "_provider"

    def limits(self):
        names = (
            "max_concurrent_users",
            "max_channels_per_client",
            "max_events_per_second",
            "max_joins_per_second",
        )
        with connect(self.url) as connection:
            assert_psycopg_target(connection, self.target, expected_user="supabase_admin")
            rows = connection.execute(
                "SELECT " + ",".join(names) + " FROM _realtime.tenants"
            ).fetchall()
        assert len(rows) == 1
        return dict(zip(names, rows[0], strict=True))

    def footprint(self):
        def docker(*args):
            return subprocess.check_output(["docker", *args], text=True, timeout=10).strip()

        value = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", self.realtime)
        parsed = re.fullmatch(r"([\d.]+)([KMGT]?i?B) / ([\d.]+)([KMGT]?i?B)", value)
        if not parsed:
            raise RuntimeError("Realtime memory metric unavailable")
        units = {
            "B": 1,
            "KiB": 1024,
            "MiB": 1024**2,
            "GiB": 1024**3,
            "KB": 1000,
            "MB": 1000**2,
            "GB": 1000**3,
        }
        address = docker(
            "inspect",
            "--format",
            '{{(index .NetworkSettings.Networks "' + self.network + '").IPAddress}}',
            self.realtime,
        )
        ipaddress.ip_address(address)
        with connect(self.url) as connection:
            assert_psycopg_target(connection, self.target, expected_user="supabase_admin")
            connections = connection.execute(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE datname=current_database() AND client_addr=%s::inet",
                (address,),
            ).fetchone()[0]
        return {
            "realtime_memory_bytes": int(float(parsed[1]) * units[parsed[2]]),
            "realtime_database_connections_by_owned_container_address": connections,
        }
