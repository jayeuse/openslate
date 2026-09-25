"""Mount Report, schedule, run, and recipient-safe notification surfaces."""

from app.main import app


def test_report_and_notification_routes_are_registered() -> None:
    mounted = {
        (path, method.upper())
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }
    assert ("/api/notifications", "GET") in mounted
    assert ("/api/notifications/{notification_id}/read", "POST") in mounted
    assert ("/api/reports", "GET") in mounted
    assert ("/api/reports/{report_id}/runs", "GET") in mounted
    assert ("/api/reports/shared-runs", "GET") in mounted
    assert ("/api/reports/{report_id}/runs/{run_id}/csv", "GET") in mounted
    assert ("/api/reports/{report_id}/schedule", "GET") in mounted
