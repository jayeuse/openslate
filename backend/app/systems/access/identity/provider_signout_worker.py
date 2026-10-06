"""Poll the durable provider sign-out queue without sharing request sessions."""

import threading
from time import monotonic

from app.core.config import Settings
from app.core.config.environment import environment_inputs
from app.core.config.instance import assert_instance_target, instance_target_for_process
from app.core.config.provider_instance import assert_provider_instance
from app.core.config.settings import DOTENV_PATH
from app.core.database.session import AuditSession, get_engine
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.core.observability import log_event
from app.systems.access.identity.provider_signout import drain_provider_signouts
from app.systems.access.identity.session_retention import retain_terminal_sessions

_POLL_SECONDS = 30
_RETENTION_SECONDS = 3600
_SHUTDOWN_SECONDS = 5.0


class ProviderSignoutWorker:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def run_once(self) -> int:
        values = environment_inputs(DOTENV_PATH)
        url = self._settings.database_url
        assert_provider_instance(values, database_url=url, expected_user="openslate_runtime")
        target = instance_target_for_process(url, "openslate_runtime", process=values)
        with AuditSession(bind=get_engine()) as db:
            if target is not None:
                assert_instance_target(db.connection(), target, expected_user="openslate_runtime")
                db.rollback()
            return drain_provider_signouts(db, get_supabase_auth_client())

    def _run_retention_once(self) -> int:
        values = environment_inputs(DOTENV_PATH)
        url = self._settings.database_url
        assert_provider_instance(values, database_url=url, expected_user="openslate_runtime")
        target = instance_target_for_process(url, "openslate_runtime", process=values)
        with AuditSession(bind=get_engine()) as db:
            if target is not None:
                assert_instance_target(db.connection(), target, expected_user="openslate_runtime")
                db.rollback()
            return retain_terminal_sessions(db)

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        thread = threading.Thread(target=self._run, name="openslate-provider-signout", daemon=True)
        thread.start()
        self._thread = thread

    def stop(self) -> bool:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=_SHUTDOWN_SECONDS)
            if self._thread.is_alive():
                return False
        self._thread = None
        return True

    def _run(self) -> None:
        retention_due = monotonic()
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                log_event(
                    "operational_attention",
                    reason_code="provider_signout_poll_failed",
                    upstream="supabase-auth",
                )
            if self._stop.is_set():
                break
            if monotonic() >= retention_due:
                try:
                    self._run_retention_once()
                except Exception:
                    log_event(
                        "operational_attention",
                        reason_code="identity_session_retention_failed",
                        upstream="database",
                    )
                finally:
                    retention_due = monotonic() + _RETENTION_SECONDS
            self._stop.wait(_POLL_SECONDS)
