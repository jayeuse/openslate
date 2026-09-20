# Error Handling and Recovery

> **Scope:** Current application errors and known operational limits.

Routes roll back their transaction before translating expected database errors. Authentication errors remain generic. Invalid Origin/CSRF input is rejected without a refresh attempt. Invalid or replayed refresh tokens revoke or clear the browser session as appropriate; retry is not an authorization bypass.

Identity failures such as invalid credentials, expired action token, incomplete setup, inactive user, or rate limit have controlled responses and durable local state where needed. With optional SMTP enabled, invitation and recovery payloads are encrypted in the local outbox and a bounded worker records retry, cancellation, and terminal transport failures. SMTP is at least once: a delivery record only establishes the worker's transport result, never recipient receipt or action-token use.

File write, read, promotion, and deletion errors return controlled storage failures. Digest/size mismatch, unsafe filesystem state, scanner unavailability, and uncertain scan work fail closed. Promotion and database metadata cannot be made one transaction, so recovery procedures must inspect both the row and object state.

SSE notification failure never undoes an already committed mutation. Clients resynchronize with authorized API reads. A stalled stream is closed so it releases its subscription capacity.

Customer-facing recovery remains incomplete: signed installer retry, database restore, filesystem backup restore, and cross-host validation are planned in the deployment architecture. Current local reset operations are development-only and are not a recovery guarantee.
