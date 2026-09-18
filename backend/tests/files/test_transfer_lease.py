"""Cancellation must not free capacity while a synchronous worker still runs."""

from threading import Event, Thread

import pytest
from fastapi import HTTPException

from app.systems.platform.files.providers import transfer_slot


def test_response_timeout_keeps_capacity_until_worker_exits():
    entered, finish = Event(), Event()
    errors = []
    with transfer_slot() as first, transfer_slot():

        def worker():
            try:
                with first.retain_worker():
                    entered.set()
                    assert finish.wait(5)
            except BaseException as error:
                errors.append(error)
                entered.set()

        thread = Thread(target=worker)
        thread.start()
        assert entered.wait(5)
        try:
            assert not errors
            first.release_middleware()
            first.release_middleware()
            with pytest.raises(HTTPException) as caught:
                with transfer_slot():
                    pytest.fail("Timed-out worker lost its physical slot")
            assert caught.value.status_code == 503
        finally:
            finish.set()
            thread.join(5)
        assert not thread.is_alive() and not errors
        with transfer_slot():
            pass


def test_worker_starting_after_middleware_timeout_is_not_admitted():
    with transfer_slot() as lease:
        lease.release_middleware()
        with pytest.raises(HTTPException) as caught:
            with lease.retain_worker():
                pytest.fail("Expired request started file work")
        assert caught.value.detail["code"] == "files_busy"


def test_missing_request_admission_fails_closed():
    from fastapi import Request

    from app.systems.platform.files.providers import hold_file_worker

    request = Request({"type": "http"})
    with pytest.raises(HTTPException) as caught:
        with hold_file_worker(request):
            pytest.fail("Worker ran without body admission")
    assert caught.value.status_code == 503


def test_worker_release_is_idempotent_without_releasing_other_request():
    with transfer_slot() as lease, transfer_slot():
        worker = lease.retain_worker()
        worker.release()
        worker.release()
        with pytest.raises(HTTPException):
            with transfer_slot():
                pytest.fail("Duplicate release freed a live middleware slot")


def test_storage_cleanup_fence_denies_capacity_without_losing_slots(monkeypatch):
    from app.systems.platform.files import providers

    monkeypatch.setattr(providers, "_storage_cleanup_uncertain", True, raising=False)
    with pytest.raises(HTTPException):
        with transfer_slot():
            pytest.fail("Uncertain physical storage work admitted another transfer")
    monkeypatch.setattr(providers, "_storage_cleanup_uncertain", False)
    with transfer_slot(), transfer_slot():
        pass


def test_fence_set_during_acquire_returns_newly_acquired_slot(monkeypatch):
    from app.systems.platform.files import providers

    original = providers._slots

    class FenceOnAcquire:
        def acquire(self, **kwargs):
            acquired = original.acquire(**kwargs)
            providers._storage_cleanup_uncertain = True
            return acquired

        def release(self):
            original.release()

    monkeypatch.setattr(providers, "_storage_cleanup_uncertain", False)
    monkeypatch.setattr(providers, "_slots", FenceOnAcquire())
    with pytest.raises(HTTPException):
        with transfer_slot():
            pytest.fail("Fence raced past admission")
    monkeypatch.setattr(providers, "_slots", original)
    monkeypatch.setattr(providers, "_storage_cleanup_uncertain", False)
    with transfer_slot(), transfer_slot():
        pass
