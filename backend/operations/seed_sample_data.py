"""Populate development domain data through the authenticated FastAPI API.

The access token must belong to an existing local administrator and is read from
the protected ``SEED_ACCESS_TOKEN`` environment variable. It is never printed.
Domain/reference data is seeded by default;
sample users are optional invitations because invitees do not have local
credentials.
"""

import argparse
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import get_seed_settings, get_settings
from app.core.config.instance import (
    assert_instance_target,
    assert_local_backend_url,
    instance_identity_for_process,
    instance_target_for_process,
)
from app.core.database.session import get_engine

if __package__:
    from .seed_sample_data_specs import (  # type: ignore[import-not-found]
        DEPARTMENT_SPECS,
        FIELD_SPECS,
        MODULE_SPECS,
        RECORD_SPECS,
        ROLE_SPECS,
        SAMPLE_USER_SPECS,
    )
else:
    from seed_sample_data_specs import (
        DEPARTMENT_SPECS,
        FIELD_SPECS,
        MODULE_SPECS,
        RECORD_SPECS,
        ROLE_SPECS,
        SAMPLE_USER_SPECS,
    )

DOMAIN_LIST_PATHS = (
    "/api/departments",
    "/api/modules",
    "/api/fields",
    "/api/records",
)
SAMPLE_ROLE_NAMES = frozenset({"manager", "staff"})


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--with-sample-users",
        action="store_true",
        help="send invitations for the optional sample users after creating roles",
    )
    return parser


class ApiClient:
    def __init__(self, base_url: str, token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def verify_instance(self, expected_identity: str) -> None:
        """Verify the API process before sending its first authenticated seed request."""
        request = Request(
            f"{self.base_url}/api/health",
            headers={"Accept": "application/json"},
            method="GET",
        )
        try:
            with urlopen(request) as response:
                response.read()
                observed_identity = response.headers.get("X-OpenSlate-Instance")
                response_url = response.geturl()
        except (HTTPError, URLError, OSError):
            raise RuntimeError("Unable to verify the configured OpenSlate API instance") from None
        expected_origin = urlsplit(self.base_url)
        observed_origin = urlsplit(response_url)
        if (
            observed_identity != expected_identity
            or (observed_origin.scheme, observed_origin.netloc)
            != (expected_origin.scheme, expected_origin.netloc)
        ):
            raise RuntimeError("BACKEND_URL does not identify this OpenSlate instance")

    def request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any] | None = None,
        query: Mapping[str, str | int] | None = None,
    ) -> dict[str, Any] | None:
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urlencode(query)}"
        headers = {"Accept": "application/json"}
        if self.token is not None:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode()
        request = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(request) as response:
                body = response.read()
        except HTTPError as error:
            raise RuntimeError(f"{method} {path} failed ({error.code})") from error
        except URLError as error:
            raise RuntimeError(f"Unable to reach API at {self.base_url}: {error.reason}") from error
        return json.loads(body) if body else None


def _list_items(
    client: ApiClient,
    path: str,
    *,
    limit: int,
    offset: int,
) -> tuple[list[Mapping[str, Any]], bool]:
    response = client.request(
        "GET",
        path,
        query={"limit": limit, "offset": offset, "deleted": "include"},
    )
    if not isinstance(response, Mapping):
        raise RuntimeError(f"Unable to inspect {path}: API returned no list response")
    items = response.get("items")
    if not isinstance(items, list) or not all(isinstance(item, Mapping) for item in items):
        raise RuntimeError(f"Unable to inspect {path}: API returned an invalid list response")
    pagination = response.get("pagination")
    if not isinstance(pagination, Mapping) or not isinstance(pagination.get("has_more"), bool):
        raise RuntimeError(f"Unable to inspect {path}: API returned invalid pagination")
    return items, pagination["has_more"]


def _preflight_seed(client: ApiClient) -> dict[str, str]:
    role_items: list[Mapping[str, Any]] = []
    role_offset = 0
    while True:
        page_items, has_more = _list_items(
            client,
            "/api/roles",
            limit=100,
            offset=role_offset,
        )
        role_items.extend(page_items)
        if not has_more:
            break
        if not page_items:
            raise RuntimeError(
                "Unable to inspect roles: API returned an empty page with more results"
            )
        role_offset += len(page_items)

    role_ids: dict[str, str] = {}
    for item in role_items:
        role_name = item.get("role")
        role_id = item.get("id")
        if not isinstance(role_name, str) or not isinstance(role_id, str):
            raise RuntimeError("Unable to inspect roles: API returned an invalid role")
        role_ids[role_name.lower()] = role_id

    existing_sample_roles = SAMPLE_ROLE_NAMES.intersection(role_ids)
    if existing_sample_roles:
        raise RuntimeError("Sample data seeder is one-time: sample roles already exist")

    for path in DOMAIN_LIST_PATHS:
        items, _has_more = _list_items(client, path, limit=1, offset=0)
        if items:
            raise RuntimeError("Sample data seeder is one-time: domain data already exists")
    return role_ids


def main(argv: Sequence[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    settings = get_seed_settings()
    application = get_settings()
    target = instance_target_for_process(application.database_url, "openslate_runtime")
    assert_local_backend_url(settings.backend_url, expected_port=application.backend_port)
    if target is not None:
        with get_engine().connect() as connection:
            assert_instance_target(connection, target, expected_user="openslate_runtime")
    client = ApiClient(
        settings.backend_url,
        token=settings.seed_access_token.get_secret_value(),
    )
    expected_identity = instance_identity_for_process()
    if expected_identity is None:
        raise RuntimeError("Unable to identify the current OpenSlate instance")
    client.verify_instance(expected_identity)

    role_ids = _preflight_seed(client)
    if "admin" not in role_ids:
        raise RuntimeError("The seeded admin role is missing")
    client.request(
        "PATCH",
        f"/api/roles/{role_ids['admin']}",
        {"permissions": ROLE_SPECS["admin"]},
    )
    for role_name in ("manager", "staff"):
        if role_name not in role_ids:
            role = client.request(
                "POST",
                "/api/roles",
                {"role": role_name, "permissions": ROLE_SPECS[role_name]},
            )
            if role is None:
                raise RuntimeError(f"Role creation returned no response: {role_name}")
            role_ids[role_name] = role["id"]

    if args.with_sample_users:
        for email, username, role_name in SAMPLE_USER_SPECS:
            invitation = client.request(
                "POST",
                "/api/users",
                {
                    "email": email,
                    "username": username,
                    "role_id": role_ids[role_name],
                },
            )
            if invitation is None:
                raise RuntimeError(f"Invitation returned no response: {username}")
            print(f"sample_user={username} invitation_requested")

    department_ids: dict[str, str] = {}
    for logical_id, name in DEPARTMENT_SPECS.items():
        department = client.request("POST", "/api/departments", {"department_name": name})
        if department is None:
            raise RuntimeError(f"Department creation returned no response: {name}")
        department_ids[logical_id] = department["id"]

    module_ids: dict[str, str] = {}
    for logical_id, (department_id, name) in MODULE_SPECS.items():
        module = client.request(
            "POST",
            "/api/modules",
            {"department_id": department_ids[department_id], "module_name": name},
        )
        if module is None:
            raise RuntimeError(f"Module creation returned no response: {name}")
        module_ids[logical_id] = module["id"]

    field_ids: dict[str, str] = {}
    for logical_id, module_id, name, field_type, required, position, config in FIELD_SPECS:
        field = client.request(
            "POST",
            "/api/fields",
            {
                "module_id": module_ids[module_id],
                "name": name,
                "type": field_type,
                "required": required,
                "position": position,
                "config": config,
            },
        )
        if field is None:
            raise RuntimeError(f"Field creation returned no response: {name}")
        field_ids[logical_id] = field["id"]

    populated_module_ids = {module_id for _logical_id, module_id, *_rest in FIELD_SPECS}
    for logical_id in MODULE_SPECS:
        if logical_id not in populated_module_ids:
            continue
        accepted = client.request(
            "POST",
            f"/api/modules/{module_ids[logical_id]}/schema/accept",
        )
        if accepted is None:
            raise RuntimeError(f"Schema acceptance returned no response: {logical_id}")

    record_ids: dict[str, str] = {}
    record_responses: dict[str, dict[str, Any]] = {}
    for logical_id, module_id, data in RECORD_SPECS:
        record_data = cast(Mapping[str, Any], data)
        record = client.request(
            "POST",
            "/api/records",
            {
                "module_id": module_ids[module_id],
                "data": {field_ids[key]: value for key, value in record_data.items()},
            },
        )
        if record is None:
            raise RuntimeError(f"Record creation returned no response: {logical_id}")
        record_ids[logical_id] = record["id"]
        record_responses[logical_id] = record

    # The API has no audit-create endpoint. This PATCH creates the sample update audit entry.
    sample_record = record_responses["rec-001"]
    updated_data = dict(sample_record["data"])
    updated_data[field_ids["field-prod-stock"]] = 18
    client.request("PATCH", f"/api/records/{record_ids['rec-001']}", {"data": updated_data})
    print("Sample domain data seeded through the API with generated UUIDs")


if __name__ == "__main__":
    main()
