# Security policy

## Summary

OpenSlate is pre-release software in development. It has no released version, and no organization runs it yet.
Only the latest commit on the `main` branch gets security fixes.

**Report a vulnerability privately:**
<https://github.com/jayeuse/openslate/security/advisories/new>

Do not put vulnerability details in a public issue, pull request, commit, or comment.

One person maintains OpenSlate. The maintainer acknowledges each report within 7 days, usually sooner.
If you get no reply in 14 days, open a public issue with the title "Security report waiting". Do not add details.
The maintainer coordinates disclosure with you. The disclosure window is up to 90 days from your report.
There is no bug bounty. The maintainer credits you in the advisory unless you ask otherwise.
Test only on an installation that you run yourself.

## Supported versions

| Code | Security fixes |
|---|---|
| Latest commit on `main` | Yes |
| Older commits, other branches, forks | No |

The version `0.1.0` in the package manifests is not a release.
When the first tagged GitHub release exists, this table will list it.

## How to report

1. Open <https://github.com/jayeuse/openslate/security/advisories/new>.
2. Give the commit SHA that you tested.
3. Name the affected component, for example the API route or file path.
4. Give the configuration: the `ENVIRONMENT` value, and development or production Compose stack.
5. Write the steps to reproduce the problem.
6. Describe the effect: what an attacker can read, change, or stop.
7. Say if you used AI tools, and what they did.
8. Submit the report.

The report stays private between you and the maintainer.
The maintainer replies in the private advisory.

### AI-assisted reports

You can use AI tools to find a problem. You must check the result yourself.
Each report must show a real code path in this repository and steps that you ran.
The maintainer closes reports that look like unverified AI output, without further reply.
The maintainer can block accounts that send many such reports.

## What happens next

1. The maintainer acknowledges the report within 7 days.
2. The maintainer aims to tell you within 30 days if the report is accepted.
3. The maintainer develops the fix in a temporary private fork. You can take part if you want.
4. The fix goes to `main`. Then the maintainer publishes a GitHub security advisory.
5. You can publish your details after the advisory, or 90 days after your report. Ask if you need a different date.

If attackers already use the problem, the maintainer can fix and disclose it sooner.
Until the first tagged release, advisories have no CVE ID, because no installation runs the code.
From the first tagged release, the maintainer requests a CVE through GitHub for each confirmed vulnerability.
There is no fixed date for a fix. The maintainer sends status updates in the advisory.
There is no second maintainer. If the maintainer is not available, the 14-day public notice in the Summary applies.

## Scope

The scope is the code in this repository, as shipped:

- the FastAPI backend (`backend/`) and the static Next.js frontend (`frontend/`);
- the Compose definitions and Caddy template (`infra/`);
- the backup and restore tooling (`packaging/backup/`) and the operator commands (`backend/operations/`);
- real credentials found in this repository or its history.

Examples of in-scope problems: a login or session bypass; access to a module or record that the access rules deny; a provider account that gets access without a local binding; a revoked session that works again; cross-site request forgery on a cookie-authenticated change; a file that passes validation but is not an allowed type, or that escapes the validation limits.

### Out of scope

| Report | Reason |
|---|---|
| Behavior that needs `ENVIRONMENT=development` with a loopback bind | Development removes some limits on purpose. See `docs/architecture/14-security-architecture.md`. |
| Attacks from another process or user on the developer's own machine | Development trusts the local host. |
| Malware inside a valid file of an allowed type | OpenSlate checks file type, not content safety. This is an accepted risk. |
| OpenComms sample screens | They are browser-local examples with no server permissions. |
| Attacks that need an OpenSlate administrator or host access | That person already controls the installation. |
| Infrastructure that the operator changes or runs: host, Docker, network, TLS certificates | The operator owns these. A flaw in the shipped default configuration is in scope. |
| Problems in Supabase, PostgreSQL, or another upstream project | Report them to that project. |
| Scanner output, missing headers, or best-practice advice without a shown effect | Show the effect on OpenSlate. |
| Unsigned OpenSlate Manager builds from CI | They are development artifacts, not supported installers. |
| Windows or macOS server operation | Windows acceptance is pending. macOS is not a server target. |
| Older commits, forks, and modified code | Only `main` is supported. |
| Denial of service by volume | Report it only if one small request causes large damage. |

## Good faith

OpenSlate has no open-source license. All rights are reserved, and you can read the code on GitHub.
The maintainer gives you one more permission: you can run your own copy on systems that you control, only to find and report vulnerabilities under this policy.
This permission does not let you use OpenSlate for other purposes, give copies to other persons, or run it for an organization.

The maintainer will not take legal action against you for good-faith research that follows this policy.
This promise covers only the maintainer. It does not cover a client organization that runs OpenSlate.
You need the operator's permission to test an installation that someone else runs.
If you are not sure, ask in a private report before you continue.

## For operators

- Only the latest `main` gets fixes. Back up before you update. See `infra/supabase/RESTORE.md`.
- Advisories appear at <https://github.com/jayeuse/openslate/security/advisories>. Dependabot does not alert you about OpenSlate itself.
- The update check in OpenSlate cannot show a fix until the first tagged release exists.
- Set `ENVIRONMENT=production` exactly. Other values do not trust the Caddy proxy subnet.
- Generate `SECURITY_EVENT_SERVER_KEY` yourself, with at least 32 random bytes (for example `openssl rand -base64 48`). The key generator does not create it.
- Keep Supabase Studio bound to loopback. Treat backups, exports, and `docker compose config` output as secrets.
- One installation serves one organization. Use separate installations for organizations that do not trust each other.
- You are responsible for the data-protection duties of your organization in your country.
- If you think your installation is compromised, handle it as an incident in your organization first. Report the software flaw here.

Details: `infra/supabase/README.md`, `docs/architecture/12-deployment-architecture.md`, `docs/architecture/20-architecture-risks.md`.

---

## Reference for automated tools

This section is for AI code reviewers, coding agents, and scanners.
The keywords MUST, MUST NOT, SHOULD, and MAY have the meanings in RFC 2119 and RFC 8174 when they appear in uppercase.
Rule IDs are stable. A changed rule keeps its ID; a removed rule's ID is not reused.

### Facts

Field names follow OpenSSF Security Insights v2.2.0. This block is not a `security-insights.yml` file.

```yaml
status: pre-release
supported: main (latest commit only)
reports-accepted: true
bug-bounty-available: false
contact: https://github.com/jayeuse/openslate/security/advisories/new
other-channels: none
policy: https://github.com/jayeuse/openslate/blob/main/SECURITY.md
pgp-key: none
maintainers: 1
backup-maintainer: none
installations-in-use: none
license: none (all rights reserved; running a copy is permitted only for security research under this policy)
acknowledgement-target-days: 7
silence-fallback-days: 14
triage-target-days: 30
fix-deadline: none
disclosure-window-days: 90
embargo-list: none
cve-ids: from the first tagged release; advisories before that have none
credit: advisory, unless declined
ai-assisted-reports: allowed if disclosed and verified by a human
accepts-automated-change-request: true  # Dependabot pull requests
last-reviewed: 2026-10-15
```

### Rules

**SEC-R1.** A tool MUST NOT put details of an unfixed vulnerability in a public place: issue, pull request title, body, or comment, commit message, branch name, code comment, or discussion.
- Correct: "Commit message: `fix(files): tighten archive bounds`" with details only in the private advisory.
- Wrong: "Commit message: `fix zip bomb that bypasses the ratio check in <path>:<line>`" before the advisory is published.

**SEC-R2.** A tool MUST submit a vulnerability report only through the `contact` URL, and only when a human user tells it to. A tool MUST NOT submit reports on its own.
- Correct: "Drafted the advisory text; the user submitted it."
- Wrong: "Agent opened a private advisory for each scanner hit."

**SEC-R3.** A tool MUST NOT read, print, copy, or send secret values. Secrets include `.env`, `.env*.local`, provider and application env files, backup repositories and their passwords, export passphrases, and `docker compose config` output without `--quiet`. A tool MAY name a variable without its value.
- Correct: "`SECURITY_EVENT_SERVER_KEY` is required but not generated (settings.py:101)."
- Wrong: "Printed `.env` to confirm the key is set."

**SEC-R4.** Each finding MUST cite `path:line` at a commit SHA and give steps that ran against this code. A finding MUST NOT cite files, functions, or settings that do not exist.
- Correct: "`<path>:<line>` at `<commit SHA>`: request `<X>` returns 403 for a hidden module; expected 404. Steps: ..."
- Wrong: "The `verify_admin()` middleware may be bypassable."

**SEC-R5.** Before a tool reports a finding, it MUST check the Out of scope table and the NF list below. A finding that holds only when `ENVIRONMENT=development` and the bind host is loopback MUST NOT be reported as a vulnerability.
- Correct: "Missing `X-Frame-Options` in the dev server: NF-1, not reported."
- Wrong: "High severity: no security headers on localhost:3000."

**SEC-R6.** In code review, a tool MUST flag as blocking (P1 or higher) any change that weakens a control in the Controls table, unless the change states why.
- Correct: "P1: this route reads a module without `scope.py`; it skips the one access function."
- Wrong: "Nit: consider adding authorization."

**SEC-R7.** A report prepared with AI MUST name the tool and what it did, and a human MUST verify it before submission.
- Correct: "Found with a code-review agent; reproduced by hand on a local stack at commit `abc1234`."
- Wrong: An unreviewed model transcript pasted into the advisory form.

**SEC-R8.** A tool MUST NOT test any installation except a local stack that the user runs. A tool MUST NOT send traffic to a client deployment.
- Correct: "Ran the request against the local development stack."
- Wrong: "Probed the client's public origin to confirm."

### Known non-findings

| ID | Observation | Why it is not a vulnerability | Source |
|---|---|---|---|
| NF-1 | No Host check, security headers, body, concurrency, or anonymous rate limits; non-Secure cookies on HTTP | Only when `ENVIRONMENT=development` and the bind host is loopback | `backend/app/core/config/development.py` |
| NF-2 | Local processes can reach development services on loopback | Development trusts the local host | `infra/supabase/README.md` |
| NF-3 | A harmful file inside an allowed type is accepted | No antivirus by decision; type validation only | `docs/architecture/20-architecture-risks.md` |
| NF-4 | OpenComms actions have no server authorization | Browser-local sample state | `docs/architecture/20-architecture-risks.md` |
| NF-5 | A Supabase ban or MFA change takes up to 10 s to deny access | Documented provider account cache | `docs/architecture/08-authentication-authorization.md` |
| NF-6 | Avatars are served `inline`, not as attachments | Images with `nosniff` and `private, no-store` | `backend/app/systems/access/users/avatar_delivery.py` |
| NF-7 | `RLIMIT_AS` applies only on Linux | The production API runs in a Linux container | `backend/app/systems/platform/files/validation_child.py` |
| NF-8 | One installation does not isolate organizations from each other | One client per installation by design | `docs/architecture/20-architecture-risks.md` |
| NF-9 | `CORS_ORIGINS` is rejected | Same-origin design; no CORS on purpose | `backend/app/core/config/settings.py` |

### Controls that reviews protect

| Control | Location |
|---|---|
| One access function; hidden module returns 404 | `backend/app/systems/access/policy/scope.py`, `checks.py` |
| Explicit provider binding; revocable local sessions | `docs/architecture/08-authentication-authorization.md` |
| CSRF token plus exact `Origin` on cookie-authenticated changes | `backend/app/common/dependencies/auth.py` |
| Cookie and bearer credentials never mixed | `backend/app/common/dependencies/auth.py` |
| Relaxed-development predicate stays narrow | `backend/app/core/config/development.py` |
| File allowlist, archive bounds, parser subprocess limits | `backend/app/systems/platform/files/` |
| Private bucket; downloads as attachments with `nosniff` | `docs/architecture/14-security-architecture.md` |
| `AuditSession` for every application mutation; no bulk or raw ORM changes | `docs/architecture/10-audit-and-history.md` |
| Secrets stay out of the browser bundle and the API env | `docs/architecture/17-configuration.md` |
| SHA-pinned Actions; least-privilege token permissions; no checkout of pull-request code under `pull_request_target` | `.github/workflows/` |
