"""Real same-installation sample backup/export control."""

from __future__ import annotations

import secrets
import ssl
from collections.abc import Mapping
from contextlib import ExitStack
from datetime import UTC, datetime
from typing import Any, cast
from uuid import uuid4

import httpx

from app.common.listing import StandardListResponse
from app.systems.manage.backups.schemas import (
    BackupExportResponse,
    BackupRunResponse,
    BackupStatusResponse,
)
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.controls.host_environment import (
    HostControlRuntime,
    admit_development,
    production_topology,
    require,
    restore_account,
    runner,
)
from operations.sample.controls.host_verification import verify_delivery
from operations.sample.controls.mfa import plan_mfa_controls
from operations.sample.controls.mfa_verification import _factor_inventory, _group_members, _uuid
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _read_json,
    _record_mapping,
    _request_id,
    _result,
)
from operations.sample.population.people import SampleActorCredential


def plan_host_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None or not dataset.host_acceptance:
        return ()
    return (
        PhaseAction(
            key="control:backups:physical_backup_export",
            phase="reorganization",
            kind="backup_controls",
            actor_key=plan_mfa_controls(dataset)[0].actor_key,
            target_key="control:backups",
            values={"operation": "physical_backup_export"},
            expected_status=200,
            expected_detail=None,
            expected_end_state={
                "source_backup_verified": True,
                "export_verified": True,
                "native_download_verified": True,
                "development_restored": True,
                "role_groups_restored": True,
            },
        ),
    )


def execute_host_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    on_substep: PhaseSubstep | None = None,
    *,
    runtime: HostControlRuntime | None = None,
) -> dict[str, object]:
    if runtime is None:
        raise SamplePhaseActionError("Trusted host runtime is required", step="host_setup")
    run = _Delivery(action, dataset, context, runtime, on_substep)
    attempted, failure, proof = False, None, {}
    try:
        run.admit()
        attempted = True  # A lost promotion response still requires fresh cleanup.
        promoted = run.read_response(
            run.request(
                "admin",
                "promote_actor",
                "PATCH",
                f"/api/users/{run.actor_id}",
                body={"role": "admin"},
            ),
            "promote_actor",
        )
        run.person(promoted, "admin")
        require(
            _group_members(run.admin)
            == {
                group: [uid for uid in members if uid != run.actor_id]
                for group, members in run.groups.items()
            },
            "host_promote",
        )
        with production_topology(runtime, on_substep), ExitStack() as stack:
            acting = stack.enter_context(https_client(runtime))
            for step, path in (("host_health", "/api/health"), ("host_readiness", "/api/ready")):
                response = run.request(action.actor_key, step, "GET", path, client=acting)
                require(
                    response.headers.get("X-OpenSlate-Instance")
                    == run.capture["production_api_identity"],
                    "host_https",
                )
                body = run.read_response(response, "host_https")
                require(
                    body.get("status") == ("ok" if path == "/api/health" else "ready"),
                    "host_https",
                )
            run.login(acting, "login_actor", "admin")
            run.status(acting, "production_idle", 0)
            name = "Owned sample physical acceptance"
            queued_response = run.request(
                action.actor_key,
                "queue_source",
                "POST",
                "/api/backups",
                201,
                client=acting,
                body={"name": name},
                headers={"Idempotency-Key": str(uuid4())},
            )
            source = BackupRunResponse.model_validate(
                run.read_response(queued_response, "queue_source")
            )
            require(
                source.name == name
                and source.state == "queued"
                and source.provenance == "manual"
                and source.installation == "current"
                and source.started_at is None
                and queued_response.headers.get("Location") == f"/api/backups?run_id={source.id}",
                "queue_source",
            )
            run.status(acting, "source_queued", 1)
            completed = runner(runtime, "run")
            require(
                completed.get("state") == "succeeded" and completed.get("run_id") == str(source.id),
                "host_source",
            )
            page = StandardListResponse[BackupRunResponse].model_validate(
                run.read_response(
                    run.request(
                        action.actor_key,
                        "source_readback",
                        "GET",
                        "/api/backups",
                        client=acting,
                        params={"run_id": str(source.id), "limit": 100, "offset": 0},
                    ),
                    "source_readback",
                )
            )
            require(
                page.pagination.total == 1
                and page.pagination.count == 1
                and len(page.items) == 1
                and not page.pagination.has_more
                and page.items[0].id == source.id,
                "host_source",
            )
            source = page.items[0]
            require(
                source.state == "succeeded"
                and source.verified_at is not None
                and source.reconciled_at is not None
                and source.failure_code is None,
                "host_source",
            )
            run.status(acting, "export_idle", 0)
            passphrase = secrets.token_urlsafe(48)
            export_response = run.request(
                action.actor_key,
                "queue_export",
                "POST",
                "/api/backups/exports",
                201,
                client=acting,
                body={"backup_run_id": str(source.id), "passphrase": passphrase},
                headers={"Idempotency-Key": str(uuid4())},
            )
            exported = BackupExportResponse.model_validate(
                run.read_response(export_response, "queue_export")
            )
            require(
                exported.backup_run_id == source.id
                and exported.state == "queued"
                and export_response.headers.get("Location")
                == f"/api/backups/exports/{exported.id}",
                "queue_export",
            )
            ready = runner(runtime, "run")
            require(
                ready.get("state") == "ready" and ready.get("export_id") == str(exported.id),
                "host_export",
            )
            exported = BackupExportResponse.model_validate(
                run.read_response(
                    run.request(
                        action.actor_key,
                        "export_readback",
                        "GET",
                        f"/api/backups/exports/{exported.id}",
                        client=acting,
                    ),
                    "export_readback",
                )
            )
            require(
                exported.backup_run_id == source.id and exported.state == "ready", "host_export"
            )
            proof = verify_delivery(runtime, source, exported, passphrase, run.credential)
            run.native_requests(proof, str(exported.id))
        require(runtime.reconciliation.get("development_restored") is True, "host_restore")
    except SamplePhaseActionError as error:
        failure = error
        raise
    except Exception:
        failure = SamplePhaseActionError(
            "Physical host control did not complete", step="host_delivery"
        )
        raise failure from None
    finally:
        if attempted:
            try:
                # Before any topology transition the original services are still admitted.
                if runtime.reconciliation.get("development_restored") is not False:
                    run.restore_account()
                else:
                    require(False, "host_restore_account")
            except Exception:
                runtime.reconciliation["role_groups_restored"] = False
                if failure is None:
                    raise SamplePhaseActionError(
                        "Owned account restoration is not confirmed", step="host_restore_account"
                    ) from None
        context.private_values["host_reconciliation"] = dict(runtime.reconciliation)
    require(runtime.reconciliation.get("role_groups_restored") is True, "host_restore_account")
    mappings: list[dict[str, str]] = []
    _record_mapping(context, run.admin, "backup_run", action.key, str(source.id), mappings)
    _record_mapping(
        context, run.admin, "backup_export", action.key + ":export", str(exported.id), mappings
    )
    return _result(
        action,
        context,
        run.evidence,
        mappings,
        extra={
            **proof,
            "backup_run_id": str(source.id),
            "export_id": str(exported.id),
            "development_restored": True,
            "role_groups_restored": True,
            "original_actor_group_ids": run.actor_groups,
            "original_group_members": run.groups,
            "owner_factors": run.owner_factors,
            "primary_actor_keys": sorted(key for key in context.clients if key != "admin"),
        },
    )


def https_client(runtime: HostControlRuntime) -> SampleClient:
    context = ssl.create_default_context(cafile=runtime.ca_file)
    return SampleClient(
        runtime.origin,
        runtime.origin,
        runtime.journal_path,
        transport=httpx.HTTPTransport(verify=context, trust_env=False),
    )


class _Delivery:
    def __init__(
        self,
        action: PhaseAction,
        dataset: SampleDataset,
        context: PhaseExecutionContext,
        runtime: HostControlRuntime,
        substep: PhaseSubstep | None,
    ) -> None:
        require(action in plan_host_controls(dataset), "host_plan")
        self.action, self.dataset, self.context, self.runtime, self.substep = (
            action,
            dataset,
            context,
            runtime,
            substep,
        )
        self.actor_id = _uuid(context.user_ids.get(action.actor_key), "host_actor")
        self.owner_id = _uuid(context.user_ids.get("admin"), "host_owner")
        require(
            self.actor_id != self.owner_id
            and len([v for v in context.user_ids.values() if v == self.actor_id]) == 1,
            "host_actor",
        )
        raw = context.private_values.get("credentials")
        require(isinstance(raw, Mapping), "host_credential")
        self.credentials = cast(Mapping[str, SampleActorCredential], raw)
        for key in context.clients:
            if key != "admin":
                credential = self.credentials.get(key)
                require(
                    isinstance(credential, SampleActorCredential)
                    and credential.user_id == context.user_ids[key],
                    "host_credential",
                )
        self.credential = self.credentials[action.actor_key]
        self.admin, self.actor = context.clients["admin"], context.clients[action.actor_key]
        self.person_spec = next(
            p for p in dataset.organization.actors.people if p.key == action.actor_key
        )
        require(self.credential.email == self.person_spec.email, "host_credential")
        self.evidence: list[dict[str, object]] = []

    def observed(
        self, actor: str, step: str, method: str, path: str, response: httpx.Response, expected: int
    ) -> httpx.Response:
        request_id = _request_id(response)
        require(
            request_id is not None and response.headers.get("Cache-Control") == "no-store", step
        )
        self.evidence.append(
            {
                "step": step,
                "actor_key": actor,
                "actor_id": self.context.user_ids[actor],
                "method": method,
                "path": path,
                "status_code": response.status_code,
                "expected_status": expected,
                "request_id": request_id,
            }
        )
        if response.status_code != expected:
            raise SamplePhaseActionError(
                "Host request did not match its admitted outcome",
                step=step,
                status_code=response.status_code,
                request_id=request_id,
            )
        return response

    def request(
        self,
        actor: str,
        step: str,
        method: str,
        path: str,
        expected: int = 200,
        *,
        client: SampleClient | None = None,
        body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        if self.substep is not None:
            self.substep(step)
        response = (client or self.context.clients[actor]).request(
            method, path, json_body=body, headers=headers, params=params, refresh_first=False
        )
        return self.observed(actor, step, method, path, response, expected)

    def read_response(self, response: httpx.Response, step: str) -> dict[str, Any]:
        return _read_json(response, step=step)

    def read(
        self, actor: str, step: str, path: str, client: SampleClient | None = None
    ) -> dict[str, Any]:
        return self.read_response(self.request(actor, step, "GET", path, client=client), step)

    def person(self, body: Mapping[str, Any], role: str) -> None:
        expiry = body.get("expires_at")
        require(
            body.get("id") == self.actor_id
            and body.get("role") == role
            and body.get("status") == "active"
            and body.get("email") == self.credential.email
            and body.get("username") == self.person_spec.username
            and (
                expiry is None
                or datetime.fromisoformat(str(expiry).replace("Z", "+00:00")) > datetime.now(UTC)
            ),
            "host_actor",
        )

    def login(self, client: SampleClient, step: str, role: str) -> None:
        self.observed(
            self.action.actor_key,
            step,
            "POST",
            "/api/auth/login",
            client.login(self.credential.email, self.credential.password),
            200,
        )
        self.person(
            self.read(self.action.actor_key, step + "_identity", "/api/auth/me", client), role
        )

    def status(self, client: SampleClient, step: str, queued: int) -> None:
        status = BackupStatusResponse.model_validate(
            self.read(self.action.actor_key, step, "/api/backups/status", client)
        )
        require(
            status.policy == self.policy
            and status.active_run is None
            and status.queued_count == queued
            and status.runner.state == "available",
            step,
        )

    def admit(self) -> None:
        self.capture = admit_development(self.runtime)
        require(self.capture["owner_user_id"] == self.owner_id, "host_owner")
        self.owner = self.read("admin", "owner_identity", "/api/auth/me")
        require(
            self.owner.get("id") == self.owner_id
            and self.owner.get("role") == "admin"
            and self.owner.get("status") == "active",
            "host_owner",
        )
        self.owner_factors = _factor_inventory(
            self.read("admin", "owner_factors", "/api/auth/mfa"), self.owner_id, "host_owner"
        )[1]
        self.person(self.read("admin", "actor_profile", f"/api/users/{self.actor_id}"), "member")
        self.person(self.read(self.action.actor_key, "actor_identity", "/api/auth/me"), "member")
        require(
            _factor_inventory(
                self.read(self.action.actor_key, "actor_factors", "/api/auth/mfa"),
                self.actor_id,
                "host_actor",
            )[1]
            == [],
            "host_actor",
        )
        require(
            self.read("admin", "mfa_policy", "/api/workspace/security").get("mfa_require_admin")
            is False,
            "host_policy",
        )
        status = BackupStatusResponse.model_validate(
            self.read("admin", "development_idle", "/api/backups/status")
        )
        self.policy = status.policy
        require(
            status.policy.adopted is True
            and status.policy.schedule == "disabled"
            and status.policy.next_due_at is None
            and status.active_run is None
            and status.queued_count == 0,
            "host_idle",
        )
        self.groups = _group_members(self.admin)
        self.actor_groups = sorted(
            group for group, members in self.groups.items() if self.actor_id in members
        )
        require(
            self.actor_groups
            == sorted(
                _uuid(self.context.group_ids.get(group), "host_groups")
                for group in self.person_spec.groups
            ),
            "host_groups",
        )

    def restore_account(self) -> None:
        restore_account(self)

    def native_requests(self, proof: Mapping[str, object], export_id: str) -> None:
        for step, method, path in (
            ("login", "POST", "/api/auth/login"),
            ("identity", "GET", "/api/auth/me"),
            ("admission", "POST", f"/api/backups/exports/{export_id}/download-admission"),
            ("content", "GET", f"/api/backups/exports/{export_id}/content"),
        ):
            self.evidence.append(
                {
                    "step": "native_" + step,
                    "actor_key": self.action.actor_key,
                    "actor_id": self.actor_id,
                    "method": method,
                    "path": path,
                    "expected_status": 200,
                    "status_code": 200,
                    "request_id": _uuid(proof.get(f"native_{step}_request_id"), "host_native"),
                }
            )
