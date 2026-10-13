from __future__ import annotations

from collections.abc import Mapping

import httpx

from operations.sample.client import SampleClient
from operations.sample.phases.actions import PhaseExecutionContext

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
MEMBER_ID = "9ec0d287-ae14-4603-91c2-f9a4d7b73c0a"
TARGET_ID = "e40862a7-fbb7-4e71-a590-90e11f4e893d"
GROUP_ID = "4f10e3a8-6798-4ae8-bf5a-66ef6c54c02e"


def sample_login_response(request: httpx.Request) -> httpx.Response | None:
    if request.url.path != "/api/auth/login":
        return None
    return httpx.Response(
        200,
        headers=[
            ("Set-Cookie", "openslate_csrf=fixture-csrf; Path=/; SameSite=Lax"),
            ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly; SameSite=Lax"),
        ],
        json={"ok": True},
    )


def sample_phase_context(
    clients: Mapping[str, SampleClient], *, mappings=None
) -> PhaseExecutionContext:
    return PhaseExecutionContext(
        clients=clients,
        user_ids={"admin": ADMIN_ID, "member": MEMBER_ID, "target": TARGET_ID},
        group_ids={"finance-office": GROUP_ID},
        department_ids={"finance": "56af8be1-8862-47a8-9906-1717395ccf20"},
        module_ids={},
        field_ids={},
        mappings=mappings or {},
        admin_password="fixture-admin-password",
    )
