"""The API must not dispose a pool while provider sign-out still uses it."""

import asyncio
from types import SimpleNamespace

from fastapi import FastAPI

import app.main as main


def test_lifespan_retains_database_pool_for_inflight_provider_signout(monkeypatch) -> None:
    app = FastAPI()
    def idle() -> SimpleNamespace:
        return SimpleNamespace(start=lambda: None, stop=lambda: True)

    app.state.events_listener = idle()
    app.state.smtp_outbox_worker = idle()
    app.state.trigger_worker = idle()
    app.state.report_scheduling_worker = idle()
    app.state.provider_signout_worker = SimpleNamespace(start=lambda: None, stop=lambda: False)
    disposed: list[bool] = []
    monkeypatch.setattr(main, "configure_observability_logging", lambda: None)
    monkeypatch.setattr(main, "instance_target_for_process", lambda *_args: None)
    monkeypatch.setattr(main, "dispose_database_resources", lambda: disposed.append(True))

    async def exercise() -> None:
        async with main.application_lifespan(app):
            pass

    asyncio.run(exercise())
    assert not disposed
