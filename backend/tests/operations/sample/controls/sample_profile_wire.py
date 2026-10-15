"""Stateful HTTP boundary for the real SampleClient profile control journey."""

import copy
import json
from hashlib import sha256
from uuid import uuid4

import httpx

from app.systems.access.users.schemas import (
    SelfProfileUpdate,
    UserPreferencesResponse,
    UserPreferencesUpdate,
)
from app.systems.platform.files.schemas import FileCreate, FileResponse
from app.systems.platform.files.validation import validate_content

ORIGIN = "http://127.0.0.1:3000"
PASSWORD = "owned-profile-fixture-password"
STAMP = "2026-09-30T12:00:00Z"


class ProfileWire:
    def __init__(self, actor_id, admin_id, role, *, defect=None):
        self.actor_id, self.admin_id, self.role = actor_id, admin_id, role
        self.defect = defect
        self.profile = {
            "display_name": "Original owned name",
            "job_title": "Original job",
            "phone": "Original phone",
            "bio": "Original bio",
            "avatar_file_id": None,
        }
        self.preferences = {
            "user_id": actor_id,
            "theme": "dark",
            "appearance": {"motion": "system", "keyboard_shortcuts": True},
        }
        if defect == "original_avatar":
            self.profile["avatar_file_id"] = str(uuid4())
        if defect == "nullable_text":
            self.profile.update(display_name=None, job_title=None, phone=None, bio=None)
        self.initial = copy.deepcopy((self.profile, self.preferences))
        self.files, self.objects, self.sessions = {}, {}, {}
        self.requests, self.receipts, self.writes = [], [], []
        self.bound_reads = 0

    def response(self, request, status=200, body=None, *, content=None, headers=None):
        request_id = str(uuid4())
        self.receipts.append((request.method, request.url.path, status, request_id))
        pairs = list(headers.items()) if isinstance(headers, dict) else list(headers or [])
        kwargs = {"headers": [("X-Request-ID", request_id), *pairs]}
        if content is not None:
            return httpx.Response(status, content=content, **kwargs)
        return httpx.Response(status, json=body, **kwargs)

    def self_body(self):
        result = {
            "id": self.actor_id,
            "email": "owned-person@example.test",
            "username": "owned_person",
            "status": "active",
            "role": self.role,
            "sponsor_user_id": self.admin_id if self.role == "guest" else None,
            "expires_at": "2027-01-01T00:00:00Z" if self.role == "guest" else None,
            "invitation_sent_at": None,
            "created_at": STAMP,
            "updated_at": STAMP,
            "deleted_at": None,
            "is_deleted": False,
            "performed_by": None,
            "access": [],
            **self.profile,
        }
        if self.defect == "missing_private_read":
            result.pop("phone")
        account = {key: value for key, value in result.items() if key not in {
            "role", "access", "sponsor_user_id", "expires_at", "invitation_sent_at",
        }}
        org = {"org_id": self.admin_id, "name": "Example", "slug": "example", "role": self.role}
        result.update(account=account, memberships=[org], pending_invitations=[],
                      current_organization={**org, "access": []}, default_organization_blocked=None)
        return result

    def handle(self, request):
        self.requests.append(request)
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content and method != "PUT" else {}
        assert request.headers["origin"] == ORIGIN
        if path == "/api/auth/login":
            identity = self.admin_id if body["email"] == "admin@example.test" else self.actor_id
            assert body["password"] == PASSWORD
            session = str(uuid4())
            self.sessions[session] = identity
            return self.response(
                request,
                body={"authenticated": True, "setup_required": False},
                headers=[
                    ("Set-Cookie", f"openslate_access={session}; Path=/; HttpOnly"),
                    ("Set-Cookie", "openslate_csrf=profile-csrf; Path=/"),
                ],
            )
        cookie = request.headers.get("cookie", "")
        session = next(
            (
                part.split("=", 1)[1]
                for part in cookie.split("; ")
                if part.startswith("openslate_access=")
            ),
            None,
        )
        identity = self.sessions.get(session)
        assert identity in (self.actor_id, self.admin_id)
        if method != "GET":
            assert identity == self.actor_id and request.headers["x-csrf-token"] == "profile-csrf"
            self.writes.append((method, path))
        if path == "/api/auth/me" and method == "GET":
            assert identity == self.actor_id
            return self.response(request, body=self.self_body())
        if path == "/api/auth/me/profile" and method == "PATCH":
            values = SelfProfileUpdate.model_validate(body).model_dump(
                mode="json", exclude_unset=True
            )
            old_id = self.profile["avatar_file_id"]
            new_id = values.get("avatar_file_id", old_id)
            if new_id is not None:
                file = self.files[new_id]
                assert file["creator_id"] == identity and file["state"] == "ready"
            if not (
                self.defect == "ignore_restore"
                and body.get("display_name") == self.initial[0]["display_name"]
            ):
                self.profile.update(values)
            if old_id and old_id != new_id:
                file = self.files[old_id]
                file["is_deleted"], file["deleted_at"] = True, STAMP
                if self.defect == "partial_cleanup":
                    file["state"] = "deleting"
                    return self.response(
                        request, 503, {"detail": {"code": "profile_avatar_cleanup_partial"}}
                    )
                self.objects.pop(old_id)
                file["state"] = "purged"
            return self.response(request, body=self.self_body())
        if path == f"/api/users/{self.actor_id}/preferences":
            if method == "PATCH":
                payload = UserPreferencesUpdate.model_validate(body)
                if "theme" in payload.model_fields_set:
                    self.preferences["theme"] = payload.theme
                self.preferences["appearance"].update(
                    payload.appearance.model_dump(exclude_unset=True)
                )
            return self.response(
                request,
                body=UserPreferencesResponse.model_validate(self.preferences).model_dump(
                    mode="json"
                ),
            )
        if path.endswith("/card"):
            target = path.split("/")[-2]
            is_actor = target == self.actor_id
            public = {
                "display_name": (self.profile["display_name"] or "owned_person")
                if is_actor
                else "Administrator",
                "job_title": self.profile["job_title"] if is_actor else None,
                "avatar_url": f"/api/users/{target}/avatar"
                if is_actor and self.profile["avatar_file_id"]
                else None,
            }
            if identity == self.admin_id or self.role != "guest":
                public.update(
                    email="owned-person@example.test" if is_actor else "admin@example.test",
                    phone=self.profile["phone"] if is_actor else None,
                    bio=self.profile["bio"] if is_actor else None,
                )
            return self.response(request, body=public)
        if path.endswith("/avatar"):
            assert path == f"/api/users/{self.actor_id}/avatar"
            if self.profile["avatar_file_id"] is None:
                return self.response(request, 404, {"detail": "Avatar not found"})
            file_id = self.profile["avatar_file_id"]
            content = self.objects[file_id]
            self.bound_reads += 1
            if self.defect == "corrupt_avatar":
                content = b"not the admitted image"
            return self.response(
                request,
                content=content,
                headers={
                    "Content-Type": "image/png",
                    "Cache-Control": "private, no-store",
                    "X-Content-Type-Options": "nosniff",
                },
            )
        if path == "/api/files" and method == "POST":
            payload = FileCreate.model_validate(body)
            assert payload.purpose == "user_avatar"
            file_id = str(uuid4())
            file = {
                "id": file_id,
                **payload.model_dump(mode="json"),
                "board_id": None,
                "creator_id": identity,
                "media_type": None,
                "actual_size": None,
                "digest": None,
                "state": "awaiting_upload",
                "failure_code": None,
                "created_at": STAMP,
                "updated_at": STAMP,
                "deleted_at": None,
                "is_deleted": False,
            }
            self.files[file_id] = file
            return self.response(
                request, 201, FileResponse.model_validate(file).model_dump(mode="json")
            )
        if path.startswith("/api/files/"):
            file_id = path.split("/")[3]
            file = self.files[file_id]
            assert file["creator_id"] == identity
            if method == "PUT":
                assert (
                    len(request.content) == file["expected_size"]
                    and file["state"] == "awaiting_upload"
                )
                normalized = validate_content(file["filename"], request.content, logo=True)
                self.objects[file_id] = normalized.content
                file.update(
                    state="ready",
                    media_type=normalized.media_type,
                    digest=sha256(normalized.content).hexdigest(),
                    actual_size=len(normalized.content),
                )
                if self.defect == "wrong_creator":
                    file["creator_id"] = self.admin_id
            return self.response(
                request, body=FileResponse.model_validate(file).model_dump(mode="json")
            )
        raise AssertionError(f"Unexpected profile wire route: {method} {path}")
