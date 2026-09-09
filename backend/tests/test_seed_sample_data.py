from collections import defaultdict
from collections.abc import Mapping
from typing import Any

from scripts import seed_sample_data as seed
from scripts.seed_sample_data_specs import FIELD_SPECS, MODULE_SPECS, RECORD_SPECS


class RecordingClient:
    def __init__(self, _base_url: str, token: str | None = None) -> None:
        self.token = token
        self.calls: list[dict[str, Any]] = []
        self.field_ids: dict[str, str] = {}
        self.module_ids: dict[str, str] = {}
        self._field_index = 0
        self._module_index = 0
        self._record_index = 0

    def request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any] | None = None,
        query: Mapping[str, str | int] | None = None,
    ) -> dict[str, Any] | None:
        call = {"method": method, "path": path, "payload": payload, "query": query}
        self.calls.append(call)
        if method == "GET" and path == "/api/roles":
            return {
                "items": [
                    {"id": "role-admin", "role": "admin"},
                    {"id": "role-manager", "role": "manager"},
                    {"id": "role-staff", "role": "staff"},
                ]
            }
        if method == "POST" and path == "/api/departments":
            return {"id": f"department-{len(self.module_ids)}-{len(self.calls)}"}
        if method == "POST" and path == "/api/modules":
            logical_id = tuple(MODULE_SPECS)[self._module_index]
            module_id = f"module-{logical_id}"
            self.module_ids[logical_id] = module_id
            self._module_index += 1
            return {"id": module_id}
        if method == "POST" and path.endswith("/schema/accept"):
            return {"id": path.split("/")[-3]}
        if method == "POST" and path == "/api/fields":
            logical_id = FIELD_SPECS[self._field_index][0]
            field_id = f"field-{logical_id}"
            self.field_ids[logical_id] = field_id
            self._field_index += 1
            return {"id": field_id}
        if method == "POST" and path == "/api/records":
            record_id = f"record-{self._record_index}"
            self._record_index += 1
            return {"id": record_id, "data": dict(payload["data"]) if payload else {}}
        return {"id": "response"} if method == "PATCH" else None


def test_seed_definitions_use_contiguous_zero_based_positions() -> None:
    positions: dict[str, list[int]] = defaultdict(list)
    for _logical_id, module_id, _name, _type, _required, position, _config in FIELD_SPECS:
        positions[module_id].append(position)

    for module_id, values in positions.items():
        assert sorted(values) == list(range(len(values))), module_id


def test_seed_main_accepts_populated_modules_before_records_and_preserves_values(
    monkeypatch, capsys
) -> None:
    recorder = RecordingClient("http://test", token="token")
    monkeypatch.setattr(seed, "ApiClient", lambda _base_url, token: recorder)

    seed.main(["--access-token", "token"])

    field_calls = [
        call
        for call in recorder.calls
        if call["method"] == "POST" and call["path"] == "/api/fields"
    ]
    assert [call["payload"]["position"] for call in field_calls] == [
        spec[5] for spec in FIELD_SPECS
    ]

    expected_acceptance_paths = [
        f"/api/modules/{recorder.module_ids[module_id]}/schema/accept"
        for module_id in MODULE_SPECS
        if any(spec[1] == module_id for spec in FIELD_SPECS)
    ]
    acceptance_calls = [
        call
        for call in recorder.calls
        if call["method"] == "POST" and call["path"].endswith("/schema/accept")
    ]
    assert [call["path"] for call in acceptance_calls] == expected_acceptance_paths

    record_calls = [
        call
        for call in recorder.calls
        if call["method"] == "POST" and call["path"] == "/api/records"
    ]
    first_record_index = next(
        index for index, call in enumerate(recorder.calls) if call["path"] == "/api/records"
    )
    assert len(record_calls) == len(RECORD_SPECS)

    acceptance_indices = [
        index
        for index, call in enumerate(recorder.calls)
        if call["path"].endswith("/schema/accept")
    ]
    assert max(acceptance_indices) < first_record_index

    for call, (_logical_id, _module_id, source_data) in zip(
        record_calls, RECORD_SPECS, strict=True
    ):
        expected_data = {
            recorder.field_ids[field_key]: value for field_key, value in source_data.items()
        }
        assert call["payload"]["data"] == expected_data

    assert not any(call["path"] == "/api/users" for call in recorder.calls)
    assert "Sample domain data seeded through the API" in capsys.readouterr().out
