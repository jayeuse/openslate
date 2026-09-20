# Observability

> **Scope:** Current signals and limits.

FastAPI provides bounded readiness checks, request identifiers, and allowlisted structured operational logs. Audit rows capture application ORM changes. Security events capture relevant local identity operations. Logs and events must not include passwords, cookie values, bearer tokens, connection strings, file paths, or file contents.

File and scanner signals distinguish queued, claimed, clean, rejected, and uncertain states. SSE uses opaque invalidation signals; it is not an audit stream or monitoring transport. Caddy can provide gateway logs under its configured local runtime path.

The repository does not establish centralized telemetry, packaged-host diagnostics, alerting, backup freshness reporting, or a customer support export workflow. The future installer design requires explicit consent before diagnostic export or support upload.
