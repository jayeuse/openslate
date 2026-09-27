import re
from types import SimpleNamespace

import pytest
from pydantic import SecretStr

from app.core.config.instance import InstanceTargetError
from operations import seed_sample_data as sample_seeder
from operations.seed_sample_data_specs import FIELD_SPECS, RECORD_SPECS

CANONICAL_DECIMAL = re.compile(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?$")


def _assert_canonical_decimal(value: object) -> None:
    assert isinstance(value, str)
    assert CANONICAL_DECIMAL.fullmatch(value)
    assert value != "-0"
    if "." in value:
        integer_part, fractional_part = value.split(".", 1)
        assert not fractional_part.endswith("0")
    else:
        integer_part = value
    assert len(integer_part.removeprefix("-")) <= 38
    assert "." not in value or len(fractional_part) <= 18


def test_sample_seed_uses_canonical_strings_for_every_decimal_producer() -> None:
    field_types = {spec[0]: spec[3] for spec in FIELD_SPECS}

    for _logical_id, _module_id, _name, field_type, _required, _position, config in FIELD_SPECS:
        if field_type == "decimal":
            for bound_name in ("minimum", "maximum"):
                if bound_name in config:
                    _assert_canonical_decimal(config[bound_name])

    for _logical_id, _module_id, data in RECORD_SPECS:
        for field_id, value in data.items():
            if field_types.get(field_id) == "decimal":
                _assert_canonical_decimal(value)


class _FakeSeedApiClient:
    def __init__(self, _base_url: str, token: str | None = None) -> None:
        self.token = token
        self.calls: list[tuple[str, str, dict[str, str | int] | None]] = []
        self.role_pages: list[list[dict[str, str | bool]]] = [
            [
                {"id": "admin-id", "role": "admin"},
                {"id": "member-id", "role": "member"},
            ]
        ]
        self.domain_items: dict[str, list[dict[str, str | bool]]] = {
            "/api/departments": [],
            "/api/modules": [],
            "/api/fields": [],
            "/api/records": [],
        }
        self.next_id = 0
        self.invitation_payloads: list[dict[str, str]] = []
        self.verified_identity: str | None = None

    def verify_instance(self, expected_identity: str) -> None:
        self.verified_identity = expected_identity

    def request(self, method, path, payload=None, query=None):
        self.calls.append((method, path, dict(query) if query is not None else None))
        if method == "GET":
            if path == "/api/roles":
                offset = query.get("offset", 0) if query is not None else 0
                page_index = offset // 100
                return {
                    "items": self.role_pages[page_index],
                    "pagination": {"has_more": page_index + 1 < len(self.role_pages)},
                }
            return {"items": self.domain_items[path], "pagination": {"has_more": False}}
        if path == "/api/roles":
            return {"id": f"role-{payload['role']}"}
        if path == "/api/users":
            self.invitation_payloads.append(dict(payload))
            return {"id": f"user-{self.next_id}", "status": "pending"}
        self.next_id += 1
        if path == "/api/records":
            return {"id": f"record-{self.next_id}", "data": payload["data"]}
        return {"id": f"item-{self.next_id}"}


def _run_sample_seed(
    monkeypatch: pytest.MonkeyPatch,
    client: _FakeSeedApiClient,
    *arguments: str,
    backend_url: str = "http://127.0.0.1:8000",
) -> None:
    settings = SimpleNamespace(
        backend_url=backend_url,
        seed_access_token=SecretStr("test-access-token"),
    )
    application = SimpleNamespace(
        database_url="postgresql+psycopg://openslate_runtime:test@127.0.0.1:54322/openslate",
        backend_port=8000,
    )
    monkeypatch.setattr(sample_seeder, "get_seed_settings", lambda: settings)
    monkeypatch.setattr(sample_seeder, "get_settings", lambda: application)
    monkeypatch.setattr(sample_seeder, "instance_target_for_process", lambda *_args: None)
    monkeypatch.setattr(sample_seeder, "instance_identity_for_process", lambda: "unit-instance")
    monkeypatch.setattr(sample_seeder, "ApiClient", lambda *_args, **_kwargs: client)
    sample_seeder.main(list(arguments))


def test_sample_seed_rejects_remote_or_different_worktree_api_before_requests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeSeedApiClient("http://127.0.0.1:8000")

    with pytest.raises(InstanceTargetError, match="BACKEND_URL"):
        _run_sample_seed(monkeypatch, client, backend_url="https://api.example.test:8000")

    assert client.calls == []


@pytest.mark.parametrize("observed", [None, "different-instance"])
def test_seed_api_identity_mismatch_is_rejected_before_authenticated_requests(
    monkeypatch: pytest.MonkeyPatch, observed: str | None
) -> None:
    seen = {}

    class _Response:
        def __init__(self) -> None:
            self.headers = {} if observed is None else {"X-OpenSlate-Instance": observed}

        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def read(self) -> bytes:
            return b'{"status":"ok","service":"openslate-api"}'

        def geturl(self) -> str:
            return "http://127.0.0.1:8000/api/health"

    def open_request(request):
        seen["request"] = request
        return _Response()

    monkeypatch.setattr(sample_seeder, "urlopen", open_request)
    client = sample_seeder.ApiClient(
        "http://127.0.0.1:8000", token="must-not-be-sent-before-verification"
    )

    with pytest.raises(RuntimeError, match="BACKEND_URL"):
        client.verify_instance("expected-instance")

    assert seen["request"].get_header("Authorization") is None


@pytest.mark.parametrize(
    ("role_pages", "domain_path"),
    [
        (
            [
                [
                    {"id": "admin-id", "role": "admin"},
                    {"id": "staff-id", "role": "staff", "is_deleted": True},
                ]
            ],
            None,
        ),
        (
            [
                [{"id": f"admin-id-{index}", "role": "admin"} for index in range(100)],
                [{"id": "manager-id", "role": "manager", "is_deleted": True}],
            ],
            None,
        ),
        ([[{"id": "admin-id", "role": "admin"}]], "/api/departments"),
        ([[{"id": "admin-id", "role": "admin"}]], "/api/modules"),
        ([[{"id": "admin-id", "role": "admin"}]], "/api/fields"),
        ([[{"id": "admin-id", "role": "admin"}]], "/api/records"),
    ],
)
def test_sample_seed_rejects_reruns_before_any_mutation(
    monkeypatch: pytest.MonkeyPatch,
    role_pages: list[list[dict[str, str | bool]]],
    domain_path: str | None,
) -> None:
    client = _FakeSeedApiClient("https://api.example.test")
    client.role_pages = role_pages
    if domain_path is not None:
        client.domain_items[domain_path] = [{"id": "existing", "is_deleted": True}]

    with pytest.raises(RuntimeError, match="one-time|already exists"):
        _run_sample_seed(monkeypatch, client)

    assert client.calls
    assert all(method == "GET" for method, _path, _query in client.calls)
    assert all(
        query is not None and query.get("deleted") == "include"
        for _method, _path, query in client.calls
    )


def test_sample_seed_allows_an_empty_workspace_with_only_default_roles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _FakeSeedApiClient("https://api.example.test")

    _run_sample_seed(monkeypatch, client)

    assert client.calls[:5] == [
        ("GET", "/api/roles", {"limit": 100, "offset": 0, "deleted": "include"}),
        ("GET", "/api/departments", {"limit": 1, "offset": 0, "deleted": "include"}),
        ("GET", "/api/modules", {"limit": 1, "offset": 0, "deleted": "include"}),
        ("GET", "/api/fields", {"limit": 1, "offset": 0, "deleted": "include"}),
        ("GET", "/api/records", {"limit": 1, "offset": 0, "deleted": "include"}),
    ]
    assert any(method in {"PATCH", "POST"} for method, _path, _query in client.calls[5:])


def test_sample_users_request_email_invitations_without_temporary_credentials(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    client = _FakeSeedApiClient("https://api.example.test")

    _run_sample_seed(monkeypatch, client, "--with-sample-users")

    output = capsys.readouterr().out
    assert client.invitation_payloads
    assert all("delivery" not in payload for payload in client.invitation_payloads)
    assert "password" not in output
    assert output.count("invitation_requested") == len(client.invitation_payloads)
