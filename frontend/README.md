# OpenSlate Frontend

The workspace is currently UI-first: business data, roles, permissions, branding, and interaction state are local sample state. Workspace screens do not fetch business APIs or subscribe to realtime updates. Existing-account sign-in, session validation/refresh, and logout remain connected to Supabase Auth.

FastAPI does not need to be running for existing-account login and workspace UI work. Existing configuration still supplies a backend URL, and invitation onboarding retains its protected backend acceptance flow. The backend and BFF implementations remain available for later integration; current workspace controls do not call them.

Frontend-specific commands and architecture are documented in the repository root [`README.md`](../README.md).

Workspace pages use `/sandbox`, `/boards`, `/comms`, `/access`, `/openview`, `/manage`, and `/platform`. The URL prefix is independent of the local placeholder data.
