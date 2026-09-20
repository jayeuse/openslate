# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

OpenSlate is for Philippine micro, small, and medium businesses, initially
favoring organizations in Metro Manila. Business owners, administrators, and
operators need to turn their existing processes into a dedicated system;
employees then need to use that system for everyday work without requiring
high technical confidence.

## Product Purpose

OpenSlate centralizes business workflows that are otherwise split across
spreadsheets and disconnected tools. It exists to reduce inconsistent and
duplicate data, repeated manual verification, and the effort required to keep
operational records trustworthy.

Success means an MSME can shape one system around how its business actually
works, then give its team a clear, dependable place to operate that workflow.

## Positioning

OpenSlate is a no-code, freeform system builder centered on a visual Sandbox.
Instead of only configuring tables or drawing static relationships, users can
represent their organization and workflow spatially, then use a simulation
interface to understand how data moves through the structure they created.

This combination of freeform visual modeling and data-flow simulation is the
primary intended differentiator from low-code builders such as Kintone and
general-purpose tools such as Google Sheets.

## Operating Context

Target businesses commonly record operational data in multiple Google Sheets
or other disconnected tools. Their workflows differ by organization, so the
product must let them model their own departments, structures, relationships,
records, and data movement rather than imposing one industry template.

The current repository is a self-hosted Next.js and FastAPI application backed
by local PostgreSQL, FastAPI Identity, private filesystem files, and authenticated
SSE invalidation. Its workspace is presently UI-first: much of the visible
business data and interaction state is local sample state, while the backend
contains implemented domain capabilities. The Sandbox's save, publish, and
simulation experiences must not be represented as persistent production
automation until they are connected to authorized backend workflows.

## Capabilities and Constraints

- The core product mechanism is a no-code, freeform Sandbox for building a
  business-specific organization and workflow model.
- A simulation interface should explain how data moves through the modeled
  structure and relationships.
- Self-hosting is the first distribution priority. A managed cloud offering is
  a later priority when operating resources allow it.
- The current implementation is web-based. The intended product should also be
  delivered as an installable desktop application and native mobile
  experiences, adapting its interaction language to each platform. The exact
  packaging, mobile stack, and delivery sequence remain open decisions.
- OpenSlate is the current product name. A rename to Slate is planned, but its
  timing and migration are not yet decided.
- The product must stay approachable for people with low technical knowledge;
  no-code flexibility must not expose avoidable implementation complexity.
- Each self-hosted deployment currently represents one organization trust
  domain; shared multi-tenant hosting is not an implemented product guarantee.

## Brand Commitments

The current name is OpenSlate, with Slate as the planned future name. Product
language should feel clear, direct, and familiar to non-technical operators.
The interface should be innovative and intuitive without making routine work
feel foreign, complex, or difficult to learn.

## Evidence on Hand

The repository contains working code and architecture evidence for configurable
departments, modules, typed fields, records, relationships, roles and
permissions, lifecycle controls, audit history, saved views, private files,
the visual Sandbox, and local simulation behavior.

No customer case study, testimonial, benchmark, validated deployment outcome,
or managed-cloud availability was confirmed during initialization. Future work
must not fabricate these forms of proof.

## Product Principles

1. Model the business as it actually operates instead of forcing it into a
   generic template.
2. Make structure and data movement visible so users can understand a system
   before relying on it.
3. Replace disconnected records with one trustworthy operational source.
4. Keep powerful configuration understandable to people with low technical
   confidence.
5. Deliver pragmatically: self-hosted first, then expand to managed cloud and
   additional application platforms without overstating readiness.

## Accessibility & Inclusion

Design for users with varied technical literacy by using familiar language,
progressive disclosure, clear recovery paths, and visible system status. The
existing frontend commitment to semantic controls, keyboard access, visible
focus, sufficient contrast, and reduced-motion support must be preserved. A
formal accessibility certification target remains undecided.
