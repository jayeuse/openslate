"""Portable result values shared by temporary-input test evaluation."""

from __future__ import annotations

from dataclasses import dataclass

from app.systems.sandbox.test_runs.schemas import TestValue


@dataclass(frozen=True, slots=True)
class SandboxTestIssue:
    code: str
    message: str
    target_id: str | None = None


@dataclass(frozen=True, slots=True)
class SandboxTestRoute:
    label: str
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class SandboxTestTriggerTrace:
    trigger_id: str
    label: str
    outcome: str


@dataclass(frozen=True, slots=True)
class SandboxTestResult:
    values: dict[str, TestValue]
    routes: tuple[SandboxTestRoute, ...]
    trigger_traces: tuple[SandboxTestTriggerTrace, ...]
    issues: tuple[SandboxTestIssue, ...]
