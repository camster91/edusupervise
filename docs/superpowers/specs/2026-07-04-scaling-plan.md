# Solo-Teacher Scaling Plan

**Date:** 2026-07-04
**Status:** Phase 0 shipped (commits 9f05f35, 71c8b5a, 5f9117a, 456b5ab, b89e5f8)
**Owner:** Cameron (PM), Mavis (coordinator), Coder swarm (per-phase execution)
**Source signal:** Jason (Toronto teacher, beta tester) chat 2026-07-04, two screenshots
**Linked:** Phase 0 commit `b89e5f8`, schema migration 0007

## Why this plan exists

EduSupervise's current onboarding leads with school-admin-led adoption (whole-school trial). Jason's feedback — "start with Teacher lead personal scheduler and moving on an expanding from there" — and the data model gaps in his real-world duty roster (EAs as first-class role, group duties, recurring time-bound duties) tell us:

1. **Solo teachers are the bigger near-term market** than whole-school districts. Lower friction, faster viral loop, easier to learn what teachers actually need.
2. **Whole-school is the upsell**, not the entry point. A hooked solo teacher brings their principal.
3. **The current data model is admin-shaped.** It assumes a school has many teachers; EAs don't exist; group duties are 1:1. Adding a solo path doesn't fix this — we need to relax the model.

This plan ships the solo path first (Phase 1), adds the AI/PDF assist that lowers time-to-first-duty to under 2 minutes (Phase 2), then expands the model for school-wide adoption (Phase 3), and finally opens district multi-tenancy (Phase 4 — parked).

## Phases at a glance

| Phase | Window | Goal | KPI |
|---|---|---|---|
| **0** (shipped 2026-07-04) | Done | Solo CTA on landing, admin path blurb, EA role in DB | Signup funnel: solo conversions |
| **1** | 2-3 weeks | Solo onboarding wizard, EA role in UI, EA defaults | Solo signups completing onboarding |
| **2** | 4-6 weeks | PDF table extraction (pdfplumber) + review card | Time-to-first-duty ≤ 2 min |
| **3** | 6-10 weeks | Group duties, recurring duties, admin billing wall | Schools with ≥ 5 active teachers |
| **4** | Month 3+ | District multi-tenancy | Parked — only build if Phase 3 lands 10+ paying schools |

## Cross-cutting constraints (apply to all phases)

- **Backward-compatible migrations.** No `DROP COLUMN` without a deprecation window. New roles, new tables, new enum values — yes. Data loss — never.
- **Demo data must always work.** Phase 0 added `educational_assistant` to the role enum; the demo seed must be updated in the same migration so `/api/signup/demo` still produces a working school.
- **RLS is non-negotiable.** Every new route goes through `withSchoolId(session.schoolId, async (tx) => ...)`. Every new table gets FORCE RLS policies for the runtime role.
- **CSRF on every POST.** Use the existing `csrfToken` loader data; never mint your own.
- **No hidden pricing.** Solo path stays free in Phase 1. Billing wall only lands in Phase 3, with a clear value exchange (multi-teacher admin features).
- **Don't ship client-facing changes without a screenshot/Loom first.** Per Cameron's hard rule.

## Anti-goals (do not build until proven)

- ❌ Vision-model PDF parsing (GPT-4V / Claude Vision on screenshots) — Phase 2 uses pdfplumber table extraction first, vision as fallback only for boards without text-layer PDFs.
- ❌ Auto-detect schedule from email subject lines / calendar invites — Jason didn't ask for this; nobody has.
- ❌ Native mobile apps — PWA only for the first 100 solo teachers.
- ❌ Public school board API integrations — 500+ Canadian/US boards each with their own format. Manual CSV import is Phase 4+.
- ❌ Re-imagining the Today screen for solo vs admin in Phase 1 — measure first, redesign only if bounce rate > 40%.

## Success criteria for "scaling plan complete"

1. Solo teachers can sign up, complete onboarding, and receive their first reminder in under 2 minutes without admin help.
2. PDF ingestion handles at least 3 real-world district PDF formats with <5% misread rate on teacher names and duty times.
3. School admin flow supports group duties and recurring duties without breaking the solo path.
4. 10+ paying schools OR a clear next-step decision based on Phase 3 data.