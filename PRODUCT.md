# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

OpenSlate is for any organization that runs on people, records, and repeated
work: businesses, schools, nonprofits, clubs, cooperatives, and public
offices. Owners, administrators, and operators know how their organization
works but may not be technical; they shape the system. Staff, members, and
volunteers then use that system for everyday work without needing high
technical confidence.

Early deployments will be small organizations the team can support directly.
That is a delivery constraint, not a statement of who the product is for.
Product copy, positioning, and defaults must not name a country, region, or
industry as the audience.

## Product Purpose

OpenSlate gives an organization one system of its own in place of work that is
otherwise split across spreadsheets and disconnected tools. It exists to reduce
inconsistent and duplicate data, repeated manual verification, and the effort
required to keep records trustworthy.

Success means an organization can shape one system around how it actually
works, then give its people a clear, dependable place to do that work.

## Positioning

OpenSlate lets an organization build its own system without code, centered on
a visual Sandbox. Instead of only configuring tables or drawing static
relationships, people lay out their organization and how work moves through it
spatially, then use a simulation interface to see how data moves through the
structure they created.

This combination of freeform visual modeling and data-flow simulation is the
primary intended differentiator from low-code builders such as Kintone and
general-purpose tools such as Google Sheets.

"Organization builder" is an internal category label, not customer copy.
Customer-facing lines speak about ownership and outcome in plain words (your
organization, your own system, one place for your people) and avoid
"builder", "no-code", "platform", "workflow", and "module".

The public line is **"Draw your ___ as it works."** The blank rotates through
kinds of organization (business, school, clinic, shop, club, nonprofit) so
each reader sees their own; the line names no single audience. Rules for
using it:

- The rotating word reserves the width of the longest word, so the line never
  shifts or rewraps.
- With reduced motion, the word does not cycle; one word stays in place.
- Assistive technology reads one fixed sentence ("Draw your organization as it
  works"), not each word change.
- Where the line cannot move (print, a social image, a slide), use one fixed
  word chosen for that audience.
- A plain outcome line follows it, so "draw" is not read as a diagram tool:
  OpenSlate turns the drawing into one system the organization's people use
  every day.

## Operating Context

Organizations commonly record operational data in several spreadsheets or other
disconnected tools. Their ways of working differ, so the product must let them
model their own departments, structures, relationships, records, and data
movement rather than imposing one industry template.

The current repository is a self-hosted Next.js and FastAPI application. It
uses Supabase PostgreSQL, Auth, and Storage; FastAPI owns authorization,
revocable sessions, and file access, and authenticated SSE carries
invalidations. Parts of the workspace still run on local sample state. The
Sandbox's save, publish, and simulation experiences must not be represented as
persistent production automation until they are connected to authorized
backend workflows.

## Capabilities and Constraints

- The core product mechanism is a no-code, freeform Sandbox for building an
  organization-specific structure and workflow model.
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
- The product must not assume one country, language, currency, timezone, or
  regional format. These belong to the organization's settings, with defaults
  taken from the person's device where no setting exists.
- Each self-hosted deployment currently represents one organization trust
  domain; shared multi-tenant hosting is not an implemented product guarantee.

## Brand Commitments

The current name is OpenSlate, with Slate as the planned future name. Product
language should feel clear, direct, and familiar to non-technical people in
any kind of organization. The interface should be innovative and intuitive
without making routine work feel foreign, complex, or difficult to learn.

## Evidence on Hand

The repository contains working code and architecture evidence for configurable
departments, modules, typed fields, records, relationships, roles and
permissions, lifecycle controls, audit history, saved views, private files,
the visual Sandbox, and local simulation behavior.

No customer case study, testimonial, benchmark, validated deployment outcome,
or managed-cloud availability was confirmed during initialization. Future work
must not fabricate these forms of proof.

## Product Principles

1. Model the organization as it actually operates instead of forcing it into a
   generic template.
2. Make structure and data movement visible so people can understand a system
   before relying on it.
3. Replace disconnected records with one trustworthy operational source.
4. Keep powerful configuration understandable to people with low technical
   confidence.
5. Deliver pragmatically: self-hosted first, then expand to managed cloud and
   additional application platforms without overstating readiness.

## Accessibility & Inclusion

Design for people with varied technical literacy by using familiar language,
progressive disclosure, clear recovery paths, and visible system status. The
existing frontend commitment to semantic controls, keyboard access, visible
focus, sufficient contrast, and reduced-motion support must be preserved. A
formal accessibility certification target remains undecided.
