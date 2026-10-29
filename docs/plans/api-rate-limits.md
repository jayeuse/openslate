# API rate-limit policy

Status: **proposed**, waiting for owner approval. Nothing here is implemented yet.

Specs normally go in `docs/specs/`; this one is in `docs/plans/` because it is a cross-cutting policy plan with five slices, like `supabase-foundation.md`.

## Outcome

Every API request counts against a budget, in every environment. One person, one browser tab, or one script cannot take the API away from other users. A refused request gets a 429 that tells the client when to try again. Automated sample-pack runs and e2e suites get a larger, still finite budget through a signed token. People, including hands-on testers, never get the token: a person who hits a limit shows that the limit is wrong.

### Exclusions

- Several API worker processes. The new counters are in-process; running more than one Uvicorn worker is a separate deployment decision.
- Per-object write limits (for example 20 writes per 2 s on one record). Deferred until a measurement shows a need.
- Admin-tunable budgets. The budgets are code constants (decision D3).
- Caddy-level limiting. Caddy has no built-in limiter; `mholt/caddy-ratelimit` needs a custom build.
- Changes to the existing login, MFA, Comms send, typing, slow-mode, SSE, and Realtime-token limits, except the two named in S1 and S2.

### Preserved behavior

- Login, MFA, recovery, Comms send (20 per 10 s), slow mode, typing (1 per 2 s), Realtime token (6 per minute), SSE (4 per user, 128 total), file transfer slots, and the lifecycle challenge limits keep their numbers, keys, and storage.
- `SERVER_MAX_CONCURRENCY` (64) stays the global cap and still answers 503. No token lifts it.
- Existing 429 bodies keep their shapes (`{"detail": "..."}` or `{"detail": {"code", "message"}}`).
- Relaxed development keeps loopback proxy trust, the relaxed origin check, the non-`Secure` cookie, and the other non-limit relaxations. S4 removes only the limit exceptions.
- Frontend reads keep `retry: false`: nothing retries on its own (decision D6).

## Current state (verified 2026-10-28)

| Fact | Source |
|---|---|
| No per-user or per-source limit on ordinary authenticated routes; only the global 503 cap | `backend/app/__main__.py:29-33` |
| Relaxed development removes the global cap and the anonymous identity budgets | `__main__.py:32`, `access/identity/provider_actions.py:49-51` |
| `E2E_SEEDING_WITHOUT_ANONYMOUS_LIMITS` exists for the smoke seeder only | `core/config/settings.py:115,297`, `tests/smoke_runner.py:361` |
| User and organization resolve only in dependencies, not in middleware | `common/dependencies/auth.py:78-289` |
| Source address is `request.client.host` after Uvicorn proxy-header handling | `access/auth/request_security.py:16` |
| Dev: the Next launcher overwrites `X-Forwarded-For` with the browser peer; FastAPI trusts loopback, so it sees the browser address | `frontend/tooling/run-next.mjs:263-291`, `__main__.py:21` |
| Test stacks start Uvicorn directly; it trusts only `127.0.0.1` by default, so a Docker Caddy peer is untrusted | `tests/fullstack_runner.py:424,503`, `tests/smoke_runner.py:350` |
| Production Auth sets no `GOTRUE_RATE_LIMIT_EMAIL_SENT`. Upstream default is 30 per hour, one bucket for the whole instance (`limiterOpts.Email.Allow()`, no key), plus 1 minute per recipient. Dev sets 1000 | `infra/supabase/compose.yaml:64-87`, `compose.dev.yaml:13-23`, supabase/auth `internal/api/mail.go` |
| Five 429s have no `Retry-After`: `/api/events`, `/api/auth/email/complete`, lifecycle actor-blocked, backup export password, publication password | `platform/events/router.py:151`, `auth/email_router.py:134`, `sandbox/lifecycle/router.py:71-76`, `manage/backups/router.py:366`, `sandbox/publications/router.py:117` |
| Frontend: `ApiError.retryAfter` exists; queries and mutations never retry on their own | `frontend/src/lib/api.ts:518-534`, `components/query-provider.tsx:17-18` |
| Seeder rate, whole run, all actors together (journal has no actor key): Harbor 7,186 requests in 557 s, School 8,741 in 453 s | `.agent-runtime/sample-runs/{5a06abf2,6aed8c0f}*/requests.jsonl` |

Seeder peaks from those journals (upper bounds, because one run uses many accounts):

| Measure | Harbor | School | Proposed budget | Ratio (worst) |
|---|---|---|---|---|
| Points per 60 s (read 1, write 5) | 6,728 | 10,572 | 900 | 11.7× |
| Points per 10 s | 1,888 | 2,133 | 300 burst + 150 refill | 4.7× |
| POST per 60 s | 1,138 | 1,792 | 80 | 22.4× |
| POST per hour | 3,558 | 4,310 | 500 | 8.6× |
| Exports per 60 s / hour | 18 / 35 | 18 / 35 | 10 / 60 | 1.8× |
| Search per 60 s | 17 | 17 | 60 | 0.3× |

## Decisions

Each decision names what it removes.

- **D1 Keying.** Authenticated requests count per user, across all of that user's organizations. Only requests without a valid identity count per source address. Admin email budgets also count per organization. *Removes:* separate budgets per organization for one account (the draft's (org, user) key). That separation only let a multi-organization account multiply its budget; the server load is per person.
- **D2 Storage.** New server-protection budgets live in process memory: token buckets in one `RateLimiter` object. Admin email budgets and the identity budgets stay in PostgreSQL (`IdentityRateLimitBucket`), because they guard external side effects and must survive a restart. *Removes:* exact counts across a restart and across several workers. A restart resets the in-process buckets.
- **D3 Budgets are code constants**, in one policy table. No setting changes or disables them, so development, test, and production run the same numbers by construction. *Removes:* tuning without a release.
- **D4 Automation token multiplier M = 30.** Sized from the worst measured class (22.4× on POST per minute) with 34% headroom. It multiplies every new budget, including the anonymous and invitation-completion budgets, because a seeder sends all invitation completions from one address. It does not change the existing login, MFA, recovery, or Comms limits; seeders already pass those. *Removes:* nothing for people. Pain point: the ratio is from whole-run totals. Solution: once the sample client journals an actor key, re-measure per user and lower M.
- **D5 In-flight cap 20 per user, no queue.** Excess gets 429 with `Retry-After: 1`. Long-lived and transfer-bound requests do not count: `/api/events`, file content upload and download, backup and Comms export content. The S1 hands-on pass measures the peak concurrent requests on a cold load of the OpenView dashboard (4×5 widgets), Boards, and Comms in production mode (HTTP/2 through Caddy). If any peak is above 15, raise the cap before S1 is committed. *Removes:* nothing measured today; dev browsers use HTTP/1.1 and send at most 6 at a time.
- **D6 No automatic retry on 429.** The frontend shows "Too many requests. Try again in N s." and disables the Retry button until the countdown ends. Writes and reads behave the same. *Removes:* silent recovery from a short in-flight spike (the draft's "reads retry after Retry-After"). It keeps the existing rule that nothing retries on its own, so a limit problem stays visible during hands-on tests.
- **D7 Route classes.** One policy table names the routes in each class by method and path template. A test walks `app.routes` and fails if a table entry matches no route or a route matches two classes. Content creation is every `POST` that creates a resource; the table lists them, because only 46 of 164 `POST` routes declare `201`. Comms message send stays in content creation and keeps its own stricter 20 per 10 s.
- **D8 Invitation completion counts failures.** Token hashes are 56 hex characters, so guessing is infeasible; counting every attempt only blocks offices and test stacks that share an address. *Removes:* the 5 attempts per 15 minutes cap on successful completions.

## Policy table

All budgets are token buckets unless marked. "Window" is the refill period of the full quota.

| Policy id | Applies to | Key | Quota | Burst | Storage |
|---|---|---|---|---|---|
| `general` | every `/api` request | user, or source when anonymous | 900 points per 60 s; read 1, write 5 | 300 | memory |
| `in-flight` | every `/api` request except the D5 exemptions | user | 20 concurrent | — | memory |
| `anonymous` | requests without a valid identity, except `/api/health` and `/api/internal/security-events` | source | 120 per 60 s | 120 | memory |
| `content` | content-creating `POST`s (table) | user | 80 per 60 s and 500 per hour | 80 | memory |
| `search` | `/api/search`, `/api/comms/search`, candidate and people lookups (table) | user | 60 per 60 s | 20 | memory |
| `export` | record, audit, security-event, report-run, sandbox, backup, and Comms exports (table) | user | 10 per 60 s and 60 per hour; 2 concurrent | 10 | memory |
| `upload` | file content `PUT`s (table) | user | 30 per 60 s and 1 GiB per hour by `Content-Length` | 30 | memory |
| `admin-email` | invite, resend, reconcile, create user, admin recovery | admin user; organization | 100 per hour per admin; 300 per hour per organization | fixed window | PostgreSQL |
| `invitation-failure` | `POST /api/auth/invitations/complete` failures | source | 10 failures per 15 min, then 15 min cooldown | fixed window | PostgreSQL |
| `invitation-attempt` | same route, all attempts | source | 60 per 15 min | fixed window | PostgreSQL |

Upload budget: the draft had 300 MiB per hour. That is 30 full-size files (10 MiB each), which one person can reach with a folder of scanned documents. 1 GiB per hour still bounds abuse; the pending-upload quota (`platform/files/quota.py`) bounds storage separately.

A request charges `general` (and `in-flight` when counted) plus at most one class. The class charge comes first; a refused class request does not charge `general`.

## Response contract

Every 429 from a new policy:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
RateLimit-Policy: "general";q=900;w=60
RateLimit: "general";r=0;t=12
Cache-Control: no-store

{"detail": {"code": "rate_limited", "message": "Too many requests. Try again in 12 s.", "policy": "general", "retry_after_seconds": 12}}
```

- Header syntax follows draft-ietf-httpapi-ratelimit-headers-11 (2026-05-23). `upload` uses `qu="content-bytes"` on its hourly item; `in-flight` and `export` concurrency use `qu="concurrent-requests"`. `general` reports points in `q`; the policy id names that unit.
- The headers go on 429 responses only.
- `Retry-After` is whole seconds, at least 1, and never earlier than the effective window ends.
- The five existing 429s without `Retry-After` get one (S1). Their bodies stay as they are.

## Mechanism

1. A pure ASGI middleware (`core/middleware/rate_limits.py`) creates a per-request admission record, applies the `anonymous` pre-check for requests with no credential at all, and releases in-flight slots when the response ends. `/api/health` and non-`/api` paths pass through.
2. Identity resolution (`common/dependencies/auth.py`, `_resolve_identity`) calls `admission.bind_user(user_id)` once per request. This charges `general`, the route's class, and `in-flight`, and raises 429 when one is exhausted.
3. A request that ends without a bound user (anonymous route, or 401) charges `anonymous` for its source when the response ends.
4. `admin-email`, `invitation-*` use the existing `IdentityRateLimitBucket` helpers in `access/identity/rate_limits.py`; no new table and no migration.
5. The policy table, buckets, and header builder live in `core/rate_limits/` (`policy.py`, `buckets.py`, `automation.py`). Every file stays under 500 lines.

Pain point: identity resolution runs before the user is charged, so a flood with a valid session still costs one session lookup per request. Solution: none needed now; the global cap of 64 bounds concurrent work, and a lookup is one indexed read.

## Automation token

- Setting `RATE_LIMIT_AUTOMATION_SECRET`. No default and no line in `.env.example` with a value. Unset: the header is ignored and budgets are normal. Set but shorter than 32 bytes: startup refuses with a clear error.
- Header `X-OpenSlate-Automation: v1.<run_id>.<expires_unix>.<signature>`. The signature is base64url HMAC-SHA256 over `openslate:rate-limit-automation:v1`, `run_id`, and `expires_unix`. A token with a bad signature, an expiry in the past, or an expiry more than 24 hours ahead counts as absent.
- Effect: multiplies every new budget by M = 30. The global cap still applies. The token never authenticates; the request still needs a session.
- The request log records the `run_id` when a token is accepted.
- `app/core/rate_limits/automation.py` has `mint_token(secret, run_id, ttl)`. The sample client, `tests/smoke_runner.py` and `tests/smoke_seed.py`, and the Playwright fullstack runner (through `extraHTTPHeaders`) use it. Hands-on accounts never send it.
- Operator step (S1, before commit): add the secret to the dev stack `.env` without printing it. The command appends a generated value and reads nothing:

  ```bash
  python3 -c "import secrets; print('RATE_LIMIT_AUTOMATION_SECRET=' + secrets.token_urlsafe(48))" >> .env
  ```

  Test stacks generate their own secret per run.

## Supabase Auth

- Keep `GOTRUE_RATE_LIMIT_HEADER` unset. The API calls Auth server-side with only `apikey` and `Authorization` (`core/integrations/supabase_auth.py:106`), so Auth sees one caller.
- Production defect (S2): with the upstream default, the whole installation can send 30 Auth emails per hour, so the 31st invitation in an hour fails. Set `GOTRUE_RATE_LIMIT_EMAIL_SENT: "1000"` in `infra/supabase/compose.yaml` and remove the dev-only override, so every environment has the same value. The application `admin-email` budget is the real limit; Auth's is the backstop.
- Keep the 1-minute per-recipient Auth limit in production. The API maps Auth's `over_email_send_rate_limit` to 429 with `Retry-After` (S2 checks the current mapping).
- Token, verify, OTP, and recover limits: in the pinned Auth v2.196.0 (`compose.yaml:46`), `performRateLimiting` applies these only to a request with an `Sb-Forwarded-For` address or a configured `GOTRUE_RATE_LIMIT_HEADER` value (`internal/api/middleware.go:72-133`). The API sends neither, so these limits do not apply to the API's calls. The email-sent limit is different: `sendEmail` calls the unkeyed `limiterOpts.Email.Allow()`, so it always applies.
- Open observation: a seven-pack parallel run on 2026-10-28 got 401 on `/api/auth/refresh` and 503 `authentication_unavailable` on `/api/auth/login` from Auth at about 2.75 token requests per second. The source above says the token limit cannot be the cause; the Auth logs of that stack are gone. Other possible causes are refresh-token rotation conflicts and Auth latency under load. RL-27 finds the real cause before production gets any token override.

## Acceptance criteria

Each criterion gets one owner test at the lowest faithful layer. Unit tests use a fake clock.

### S1 — general budget, in-flight, headers, keying, token

- **RL-1** A user sends 300 reads at once: all pass. The next read before refill gets 429 with `Retry-After`, `RateLimit`, `RateLimit-Policy`, and the `rate_limited` body.
- **RL-2** A write costs 5 points: 60 writes in a burst pass, the 61st gets 429.
- **RL-3** User A exhausts `general`; user B in the same organization and the same source still gets 200.
- **RL-4** One account in two organizations shares one `general` budget.
- **RL-5** A user with 20 requests in flight gets 429 `in-flight` on the 21st; `/api/events` and file content transfers do not count.
- **RL-6** 120 anonymous requests from one source pass; the 121st gets 429. An authenticated user at the same source still gets 200.
- **RL-7** A request with an invalid session cookie that ends in 401 charges the source `anonymous` budget.
- **RL-8** With a valid token, the 30×N+1st request gets 429; N×30 pass. An expired token, a bad signature, a token more than 24 h ahead, and any token when the secret is unset all get the normal budget N.
- **RL-9** Startup refuses a secret shorter than 32 bytes. Startup accepts an unset secret.
- **RL-10** Configuration parity: the policy table built under `ENVIRONMENT` development, test, and production is identical; `Settings` has no field that changes or disables a budget; the policy constructor refuses zero or negative values.
- **RL-11** Classification: every policy-table entry matches exactly one live route; no route matches two classes.
- **RL-12** The five existing 429s listed in Current state now carry `Retry-After`.
- **RL-13** Hands-on feature pass: cold-load peak concurrent requests on the OpenView dashboard, Boards, and Comms are 15 or less (D5), measured as a `<dept>.writer@harbor.test` account in production mode.

### S2 — class budgets, admin email, invitations, Auth email

- **RL-20** One owner test per class (`content`, `search`, `export`, `upload`): N pass, N+1 gets 429 with the class policy id; user isolation holds.
- **RL-21** `export` allows 2 concurrent runs per user; the third gets 429 `export`.
- **RL-22** `upload` refuses the request that takes the hourly byte total above 1 GiB, by `Content-Length`.
- **RL-23** An admin's 101st email-sending request in an hour gets 429 `admin-email`; a second admin in the same organization stops at the organization total of 300. Nothing reaches Auth after a refusal. These counts survive an API restart.
- **RL-24** Invitation completion: 10 failures from one source start a 15-minute cooldown; successful completions do not count toward it; the 61st attempt in 15 minutes gets 429.
- **RL-25** `infra/supabase/compose.yaml` sets `GOTRUE_RATE_LIMIT_EMAIL_SENT` and no environment overrides it (a compose contract test).
- **RL-26** An Auth `over_email_send_rate_limit` answer becomes an API 429 with `Retry-After`.
- **RL-27** Auth capacity probe on a disposable stack with production Auth settings: 3 token requests per second through the API for 10 minutes (logins and refreshes for several testing accounts). Record every Auth status and `error_code` the API receives. Pass: no Auth 429. Any 401 or 503 is traced to its Auth log line before a decision about a production Auth setting.

### S3 — automation callers

- **RL-30** The sample client sends the token on every request when the secret is present, and never when it is absent.
- **RL-31** The smoke runner and the Playwright fullstack runner mint a per-run token from a per-run secret; `E2E_SEEDING_WITHOUT_ANONYMOUS_LIMITS` no longer exists in settings, runner, or tests.
- **RL-32** The test-stack Uvicorn trusts its gateway's peer address (`--forwarded-allow-ips`) the same way production trusts its private subnet.
- **RL-33** A Small Harbor run on a disposable stack completes with zero 429 responses and a 429 count in its summary.

### S4 — remove the dev limit exceptions

- **RL-40** Relaxed development applies the global concurrency cap and the anonymous identity budgets; the other relaxations stay (`development.py` tests).
- **RL-41** `anonymous_rate_limits_enabled()` and the `enforce_rate_limit=False` route arguments that existed only for it are removed; unit tests that pass `False` directly keep working.
- **RL-42** A permanent sample run on the dev stack with the secret set completes with zero 429s.

### S5 — frontend and live probe

- **RL-50** A 429 shows "Too many requests. Try again in N s." from `retryAfter`; the Retry control is disabled until the countdown ends; no request repeats on its own (isolated Playwright).
- **RL-51** Sample verification adds a probe: a testing account without the token sends `search` until 429 and checks the headers and body.
- **RL-52** Hands-on pass on Harbor: admin, writer, reader, and guest work through a normal session with no 429.

## Slices

| Slice | Contents | Depends on | Files (approx.) | Proof |
|---|---|---|---|---|
| S1 | Policy table, buckets, middleware, identity hook, headers, token verify and mint, setting, the five `Retry-After` fixes | none; coordination below | `core/rate_limits/` (3 new), `core/middleware/rate_limits.py`, `common/dependencies/auth.py`, `core/config/settings.py`, `main.py` (one registration line), 5 routers, tests | unit (fake clock) + HTTP batch `tests/runtime`, `tests/auth`; hands-on RL-13 |
| S2 | Class tables, admin email, invitation counting, Auth email setting and mapping | S1 | `core/rate_limits/policy.py`, `identity/rate_limits.py`, `auth/router.py`, `users/router.py`, `infra/supabase/compose*.yaml`, tests | PostgreSQL integration for RL-23, RL-24 |
| S3 | Token in sample client, smoke runner, smoke seed, Playwright fullstack; E2E flag removal; test-stack proxy trust | S1; the sample-pack session landing | `operations/sample/client.py`, `tests/smoke_*.py`, `tests/fullstack_runner.py`, `frontend/playwright.fullstack.config.ts`, settings | runner unit tests + one Small run |
| S4 | Remove the dev limit exceptions | S3 | `__main__.py`, `provider_actions.py`, `auth/router.py`, `email_router.py`, tests | `tests/runtime/test_development_security.py` + dev sample run |
| S5 | Frontend 429 copy and countdown; live probe | S1 | `frontend/src/lib/api-errors.ts`, shared Retry control, `operations/sample/verification/` | isolated Playwright + sample verification |

### Coordination with the sample-pack session

- `backend/app/main.py` has that session's uncommitted edits. S1 adds one registration line and carries those edits forward; the limiter lives in new modules.
- S1 applies the new budgets on the dev stack at once. A dev sample run without the token exceeds `general` within seconds. Before S1 is committed: (1) the operator step adds the secret to `.env`, and (2) the sample-pack session adds the token header to `operations/sample/client.py` (or confirms no dev run is planned until S3). This document does not edit that file before then.
- S4 turns on the 64-request cap in dev. Seven parallel packs at one request at a time each stay far below it; the sample client must still treat 503 as retryable for reads.

## Planned verification

- Focused unit and HTTP batches per slice; the PostgreSQL integration batch for S2.
- Hands-on passes after S1 (RL-13) and S5 (RL-52) with the Harbor testing accounts.
- The pre-push gate (`scripts/prepush.py --base main --serial`) only right before a push.
