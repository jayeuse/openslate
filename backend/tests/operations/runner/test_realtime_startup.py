"""A transient seed/main health transition may use only the existing startup budget."""

import subprocess
from contextlib import nullcontext

import pytest

from tests import supabase_runtime


@pytest.mark.parametrize(
    "expired", [False, True], ids=["healthy-within-budget", "deadline-exhausted"]
)
def test_realtime_seed_transition_never_restarts_or_extends_the_startup_budget(
    tmp_path, monkeypatch, expired
):
    clock, starts = [100.0], []
    ports = iter((49152, 49153, 49154, 49155))
    monkeypatch.setattr(supabase_runtime, "_available_port", lambda: next(ports))
    monkeypatch.setattr(supabase_runtime, "_network_allocation", nullcontext)
    monkeypatch.setattr(supabase_runtime, "monotonic", lambda: clock[0], raising=False)
    with (tmp_path / "private.log").open("w") as log:
        runtime = supabase_runtime.DisposablePostgres(
            tmp_path, "a" * 32, {}, log, template_port=8008
        )
        monkeypatch.setattr(runtime, "_free_network_block", lambda: 1)
        monkeypatch.setattr(runtime, "_write_inputs", lambda: None)
        monkeypatch.setattr(runtime, "_ownership", lambda: {"service_ids": {"db": "a" * 64}})
        monkeypatch.setattr(runtime, "_inspect_json", lambda _args: [{"Name": "/owned-db"}])
        checked = []
        monkeypatch.setattr(runtime, "assert_cluster_identity", lambda: checked.append(True))

        def compose(arguments, **_kwargs):
            if arguments[0] == "up":
                starts.append(arguments)
                raise subprocess.CalledProcessError(1, ["docker", "compose", "up"])
            mappings = {"5432": 49152, "8000": 49153, "8025": 49154, "8001": 49155}
            output = f"127.0.0.1:{mappings[arguments[-1]]}" if arguments[0] == "port" else ""
            return subprocess.CompletedProcess(arguments, 0, output)

        def inspect_state(arguments, **_kwargs):
            if arguments[0] == "ps":
                output = "\n".join(
                    str(index) for index in range(len(supabase_runtime.PROVIDER_IMAGES))
                )
            else:
                clock[0] += 181 if expired else 1
                output = "\n".join(
                    f"{name} false 0"
                    if name == "provider-volume-init"
                    else f"{name} true 0 healthy"
                    for name in supabase_runtime.PROVIDER_IMAGES
                )
            return subprocess.CompletedProcess(arguments, 0, output)

        monkeypatch.setattr(runtime, "_compose", compose)
        monkeypatch.setattr(runtime, "_run", inspect_state)
        if expired:
            with pytest.raises(subprocess.CalledProcessError):
                runtime.start()
            assert checked == []
        else:
            runtime.start()
            assert checked == [True]
        assert starts == [["up", "-d", "--wait", "--wait-timeout", "180"]]
