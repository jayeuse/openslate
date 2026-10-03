"""Encode the established audit UI CSV format before releasing response bytes."""

import csv
import io
import json
import re

from app.systems.manage.audit.labels import humanize_entity_type
from app.systems.manage.audit.schemas import AuditLogResponse

_FORMULA = re.compile(r"^[\s\ufeff]*[=+\-@]")


def _safe_cell(value: str) -> str:
    return "'" + value if _FORMULA.match(value) else value


def _json_value(value: object) -> object:
    # JSON.stringify displays integral JSON numbers without Python's .0 suffix.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return value


def _format_values(values: dict[str, object] | None, empty: str) -> str:
    if not values:
        return empty
    return "\n".join(
        f"{humanize_entity_type(key)}: "
        + (
            value
            if isinstance(value, str)
            else json.dumps(_json_value(value), ensure_ascii=False, separators=(",", ":"))
        )
        for key, value in values.items()
    )


def encode_audit_csv(logs: list[AuditLogResponse]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    writer.writerow(["Date", "User", "Entity", "Action", "Target", "Before", "After"])
    for log in logs:
        writer.writerow(
            [
                _safe_cell(str(log.model_dump(mode="json")["created_at"])),
                _safe_cell((log.actor_name or "").strip() or "Unknown person"),
                _safe_cell(humanize_entity_type(log.entity_type)),
                _safe_cell(log.action[0].upper() + log.action[1:]),
                _safe_cell(log.target_label),
                _safe_cell(_format_values(log.before, "No previous values recorded.")),
                _safe_cell(_format_values(log.after, "No updated values recorded.")),
            ]
        )
    return output.getvalue().removesuffix("\r\n").encode("utf-8")
