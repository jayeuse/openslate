from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.systems.fields.router import (
    module_fields_router,
)
from app.systems.fields.router import router as fields_router
from app.systems.records.router import router as records_router


def test_routers_expose_crud_restore_and_reorder_contract() -> None:
    app = FastAPI()
    app.include_router(fields_router, prefix="/api")
    app.include_router(module_fields_router, prefix="/api")
    app.include_router(records_router, prefix="/api")
    client = TestClient(app)

    paths = client.get("/openapi.json").json()["paths"]
    assert set(paths["/api/fields"]) == {"get", "post"}
    assert set(paths["/api/fields/{field_id}"]) == {"get", "patch", "delete"}
    assert set(paths["/api/fields/{field_id}/restore"]) == {"post"}
    assert set(paths["/api/modules/{module_id}/fields/reorder"]) == {"post"}
    assert set(paths["/api/records"]) == {"get", "post"}
    assert set(paths["/api/records/{record_id}"]) == {"get", "patch", "delete"}
    assert set(paths["/api/records/{record_id}/restore"]) == {"post"}
