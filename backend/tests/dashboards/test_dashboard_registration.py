"""The department OpenView API is mounted, and nothing personal is left in it."""

from app.main import app

OPENVIEW_PREFIXES = ("/api/dashboards", "/api/views", "/api/reports", "/api/charts")
REMOVED_PATHS = {
    "/api/dashboards/default",
    "/api/views/audience-options",
    "/api/views/defaults",
    "/api/views/defaults/{module_id}",
    "/api/reports/audience-users",
    "/api/reports/audience-roles",
    "/api/charts/preferences",
}
PERSONAL_WORDS = ("owner", "audience", "visibility")


def _mounted() -> set[tuple[str, str]]:
    return {
        (path, method.upper())
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }


def test_department_dashboard_routes_are_registered() -> None:
    assert {
        ("/api/dashboards", "GET"),
        ("/api/dashboards", "POST"),
        ("/api/dashboards/{dashboard_id}", "GET"),
        ("/api/dashboards/{dashboard_id}", "PATCH"),
        ("/api/dashboards/{dashboard_id}", "DELETE"),
        ("/api/dashboards/{dashboard_id}/restore", "POST"),
    } <= _mounted()


def test_openview_has_no_personal_routes_or_owner_and_audience_fields() -> None:
    """S4-6 for the API: no route, parameter or schema field names an owner or audience."""

    schema = app.openapi()
    paths = {path for path in schema["paths"] if path.startswith(OPENVIEW_PREFIXES)}
    assert not paths & REMOVED_PATHS
    assert {
        ("/api/charts", "GET"),
        ("/api/charts", "POST"),
        ("/api/charts/{chart_id}", "GET"),
        ("/api/charts/{chart_id}", "PATCH"),
        ("/api/charts/{chart_id}", "DELETE"),
        ("/api/charts/{chart_id}/restore", "POST"),
        ("/api/charts/{chart_id}/usage", "GET"),
    } <= _mounted()
    parameters = {
        parameter["name"]
        for path in paths
        for operation in schema["paths"][path].values()
        for parameter in operation.get("parameters", [])
    }
    assert not [name for name in parameters if name.startswith(PERSONAL_WORDS)]
    openview_schemas = {
        name: body
        for name, body in schema["components"]["schemas"].items()
        if name.startswith(("Dashboard", "View", "Report", "Schedule", "SharedReportRun"))
        or "Dashboard" in name
        or "View" in name
        or "Report" in name
    }
    fields = {
        (name, field)
        for name, body in openview_schemas.items()
        for field in body.get("properties", {})
        if field.startswith(PERSONAL_WORDS)
    }
    assert fields == set()
