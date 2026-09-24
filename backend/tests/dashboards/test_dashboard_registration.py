"""The private Dashboard API is mounted by the application."""

from app.main import app


def test_private_dashboard_routes_are_registered() -> None:
    mounted = {
        (path, method.upper())
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }
    assert {
        ("/api/dashboards", "GET"),
        ("/api/dashboards", "POST"),
        ("/api/dashboards/{dashboard_id}", "GET"),
        ("/api/dashboards/{dashboard_id}", "PATCH"),
        ("/api/dashboards/{dashboard_id}", "DELETE"),
        ("/api/dashboards/{dashboard_id}/restore", "POST"),
    } <= mounted
