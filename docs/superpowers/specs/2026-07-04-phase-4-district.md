# Phase 4 — District Multi-Tenancy (PARKED)

**Date:** 2026-07-04
**Status:** Spec only — do not build. Revisit after Phase 3 has 10+ paying schools.
**Owner:** Unassigned.

## Why parked

District multi-tenancy is a 3-month project. It introduces a new entity (district), a new role (district admin), and new governance (which schools belong to which district). It's also the layer where board-published PDFs come in — but until we know which boards matter, building for "all of them" is a trap.

Build Phase 4 only if Phase 3 lands 10+ paying schools AND a non-trivial number of them are in the same district.

## Goal (when built)

A district admin (e.g. a TDSB board-level administrator) can:
- See all schools in their district that use EduSupervise.
- Push a duty rotation update (e.g. "Fall 2026 schedule") to all schools at once.
- Pull aggregate reporting (coverage rate, parent-alert volume) across schools.

## High-level shape

- New table `districts` (id, name, board_url, plan).
- New table `school_districts` (school_id, district_id, joined_at).
- New role enum value `district_admin`.
- New `school_plan` enum value `district`.
- New routes for district admin dashboard, district push, district reports.

## Decision criteria for "start Phase 4"

- Phase 3 ships and gets 10+ paying schools.
- At least 3 of those schools are in the same district (Toronto, York, Peel, etc.).
- One of those districts has expressed interest in board-level reporting.
- We have bandwidth — Phase 4 is a 3-month project with its own sprint planning.

Until then, this spec exists only to make Phase 3 work easier (we keep schema and code structured so a future district layer can plug in without rewrites).