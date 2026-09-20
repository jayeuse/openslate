# Lifecycle and State Management

> **Scope:** Domain close/reopen/purge state and file scanning state.

Departments, modules, fields, records, and relationships have explicit lifecycle behavior. Ordinary deletion requests a controlled close flow where required. Services compute impact, require confirmations, acquire locks, revalidate scope, make individual ORM changes, and record audit entries. Purge is disabled by default through `LIFECYCLE_PURGE_ENABLED=false`.

Password challenges for destructive lifecycle work use FastAPI Identity verification. The service locks and validates the challenge before consuming it, rejects expired or already-used challenges, and does not treat a browser cookie as proof of the requested password action.

Files progress through private quarantine, scan scheduling/claim, verified clean promotion or rejection, and authorized download. Scanner uncertainty blocks publication. Restart recovery preserves pending work and does not make a missing or uncertain scan result clean.

After a committed audit-aware mutation, the event publisher sends opaque PostgreSQL invalidation. Notification failure does not roll back the business transaction; consumers resynchronize by reading authorized resources again.
