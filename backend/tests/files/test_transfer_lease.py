"""Cancellation must not free capacity while a synchronous worker still runs."""

from threading import Event, Thread

import pytest
from fastapi import HTTPException

from app.systems.platform.files import providers
from app.systems.platform.files.providers import (
    FileCapacity,
    file_processing,
    transfer_admission,
)


@pytest.fixture
def pool(monkeypatch: pytest.MonkeyPatch) -> FileCapacity:
    capacity = FileCapacity(10, 2)
    monkeypatch.setattr(providers, "_pool", capacity)
    monkeypatch.setattr(providers, "_storage_cleanup_uncertain", False)
    return capacity


def test_response_timeout_keeps_the_body_reservation_until_the_worker_exits(pool):
    entered, finish = Event(), Event()
    errors = []
    with transfer_admission(6) as first:

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
            first.close_response()
            with pytest.raises(HTTPException) as caught:
                with transfer_admission(6):
                    pytest.fail("Timed-out worker lost its body reservation")
            assert caught.value.status_code == 503
        finally:
            finish.set()
            thread.join(5)
        assert not thread.is_alive() and not errors
        assert pool.reserved == 0
        with transfer_admission(10):
            pass


def test_worker_starting_after_middleware_timeout_is_not_admitted(pool):
    with transfer_admission() as lease:
        lease.release_middleware()
        with pytest.raises(HTTPException) as caught:
            with lease.retain_worker():
                pytest.fail("Expired request started file work")
        assert caught.value.detail["code"] == "files_busy"


def test_missing_request_admission_fails_closed(pool):
    from fastapi import Request

    from app.systems.platform.files.providers import hold_file_worker

    request = Request({"type": "http"})
    with pytest.raises(HTTPException) as caught:
        with hold_file_worker(request):
            pytest.fail("Worker ran without body admission")
    assert caught.value.status_code == 503


def test_worker_release_is_idempotent_without_releasing_other_request(pool):
    with transfer_admission(5) as lease, transfer_admission(5):
        worker = lease.retain_worker()
        worker.release()
        worker.release()
        lease.release_middleware()
        assert pool.reserved == 5
        with pytest.raises(HTTPException):
            with transfer_admission(6):
                pytest.fail("Duplicate release freed a live request's reservation")


def test_storage_cleanup_fence_denies_capacity_without_losing_it(pool, monkeypatch):
    monkeypatch.setattr(providers, "_storage_cleanup_uncertain", True)
    with pytest.raises(HTTPException):
        with transfer_admission(1):
            pytest.fail("Uncertain physical storage work admitted another transfer")
    with pytest.raises(HTTPException):
        with file_processing(wait_seconds=0):
            pytest.fail("Uncertain physical storage work admitted processing")
    monkeypatch.setattr(providers, "_storage_cleanup_uncertain", False)
    assert (pool.reserved, pool.busy_slots) == (0, 0)
    with transfer_admission(10), file_processing(wait_seconds=0):
        assert (pool.reserved, pool.busy_slots) == (10, 2)


def test_fence_set_during_admission_returns_the_newly_admitted_capacity(pool, monkeypatch):
    class FenceOnFit(FileCapacity):
        def _fits(self, size: int, slot: bool) -> bool:
            providers._storage_cleanup_uncertain = True
            return super()._fits(size, slot)

    raced = FenceOnFit(10, 2)
    monkeypatch.setattr(providers, "_pool", raced)
    with pytest.raises(HTTPException):
        with file_processing(4, wait_seconds=0):
            pytest.fail("Fence raced past admission")
    assert (raced.reserved, raced.busy_slots) == (0, 0)


def test_a_waiting_caller_is_refused_after_its_bound_while_every_slot_stays_busy(pool):
    with file_processing(wait_seconds=0), file_processing(wait_seconds=0):
        with pytest.raises(HTTPException) as caught:
            with file_processing(wait_seconds=0.05):
                pytest.fail("A waiting caller was admitted past the slot bound")
        assert caught.value.detail["code"] == "files_busy"
        assert caught.value.headers == {"Retry-After": "1"}
    with file_processing(wait_seconds=0.05):
        assert pool.busy_slots == 1
