"""Expose manager schedule controls and the completed Report history API."""

from app.main import app


def test_report_schedule_and_history_routes_are_registered() -> None:
    mounted = {
        (path, method.upper())
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }
    assert {
        ("/api/reports/{report_id}/schedule", "GET"),
        ("/api/reports/{report_id}/schedule", "POST"),
        ("/api/reports/{report_id}/schedule", "PATCH"),
    } <= mounted
    assert ("/api/reports", "GET") in mounted
    assert ("/api/reports/{report_id}/runs", "GET") in mounted
