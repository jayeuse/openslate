# Security policy

## Supported versions

OpenSlate has no released version yet. Only the `main` branch gets security fixes.

## Report a vulnerability

Do not open a public issue, pull request, or discussion for a vulnerability.

1. Go to the [Security tab](https://github.com/jayeuse/openslate/security) of this repository.
2. Select **Report a vulnerability**.
3. Write the affected component, the steps to reproduce, and the effect.
4. Send the report.

The report stays private between you and the maintainer.
The maintainer replies in the private advisory.

## Scope

The scope includes the code in this repository: the FastAPI backend, the Next.js frontend, the Compose stacks, and the packaging scripts.

Report a vulnerability in Supabase, PostgreSQL, or another upstream project to that project.

## Secrets

This repository contains no real credentials.
Values in tests, fixtures, and `.env.example` are placeholders.
If you find a real credential in this repository or its history, report it with the procedure above.
