# EduSupervise Solo Launch — Launch Checklist

> Launch owner: Cameron Ashley. Mavis root = Tech Lead.
> Launch window: T-7 to T+30.
> Target launch: Mon 2026-07-13, 09:30 ET (weekday launch — LinkedIn and email
> reach school admins and teachers during work hours).
> Source of truth: this file. Update after every meaningful change.

## Status snapshot (as of 2026-07-04)

| Pillar      | State | Evidence                                                                 |
|-------------|-------|--------------------------------------------------------------------------|
| Code        | 🟢    | 113 tests passing, security audit PASS, 13 issues closed                 |
| Marketing   | 🟢    | 4 artifacts in `docs/marketing/` (LinkedIn, Jason, Upwork, case study)   |
| Infra       | 🟢    | https://edusupervise.ashbi.ca live, PDF drop + recurring duties shipped  |
| Distribution| 🟡    | Upwork profile still default; cold-email send not yet scheduled          |

---

## 1. Pre-launch (T-7 to T-0)

### Day -7 (Sat 2026-07-04)

- [ ] **Mavis (project-manager):** Publish this checklist; circulate to swarm leads. *Source: this file.*
- [ ] **Cameron:** Confirm launch day + hour. Default target: Mon 2026-07-13, 09:30 ET.

### Day -6 (Sun 2026-07-05)

- [ ] **Cameron:** Update Upwork profile with `docs/marketing/upwork-profile-solo-lead.md`.
      Preview mobile + desktop before save. *Demo-first: visible (Upwork).*
- [ ] **Cameron:** Pick the final LinkedIn variant — `linkedin-solo-launch-post-v2-a.md` or `v2-b.md`.
      Trim to <=300 words if needed.

### Day -5 (Mon 2026-07-06)

- [ ] **Mavis (coder):** Run `pnpm test` + `pnpm test:integration` from repo root.
      Confirm 113 tests still green; CI step not masked by `continue-on-error`.
- [ ] **Cameron:** End-to-end solo signup walkthrough on https://edusupervise.ashbi.ca.
      Screenshot each of the 5 wizard steps. *Demo-first: functional verification.*

### Day -4 (Tue 2026-07-07)

- [ ] **Cameron:** Send the Jason follow-up email (`docs/marketing/jason-followup-email-v2-b.md`).
      One-on-one beta ask only — Jason is a known contact, not a blast.
      *Demo-first: visible (one-to-one outreach).*
- [ ] **Mavis (coder):** PDF parser smoke test on https://edusupervise.ashbi.ca
      with a real Canadian school board PDF. Confirm ~250ms parse,
      group-row detection ("Cyriac, Loganathan, Sheikh"), cell-edit, save.

### Day -3 (Wed 2026-07-08)

- [ ] **Cameron:** Final pass on LinkedIn copy + cover image (`assets/linkedin-cover.svg`).
      Keep the "vice-principal sorting Friday lunchroom duty" opener.
      *Demo-first: visible (social).*
- [ ] **Mavis (coder):** Add UptimeRobot ping on edusupervise.ashbi.ca every 5 minutes
      through T+30. Alert channel: Cameron's email.

### Day -2 (Thu 2026-07-09)

- [ ] **Cameron:** Soft-launch dry run. Save LinkedIn post as a draft. Send 1 test
      cold email to self. Verify every link resolves.
- [ ] **Mavis (project-manager):** Confirm Upwork profile live, case study
      (`docs/marketing/case-study-edusupervise.md`) staged but NOT published
      externally, landing CTA pointing at `/signup?mode=solo`.

### Day -1 (Fri 2026-07-10)

- [ ] **Cameron:** Cancel non-essential meetings for Mon morning.
- [ ] **Mavis (project-manager):** Pre-publish checklist sign-off. No client-facing
      copy goes out without Cameron review (camerons-hard-rules).

---

## 2. Launch day (T+0 — Mon 2026-07-13)

- [ ] **09:00 ET — Cameron:** Final check. Site up, signup wizard responsive on phone.
- [ ] **09:30 ET — Cameron:** Publish LinkedIn post (manually or scheduled).
      *Demo-first: visible (public social).*
- [ ] **09:35 ET — Cameron:** Send the cold-email batch from
      `docs/marketing/cold-emails-batch-1.md` — start with the top 5 leads
      from `lead-gen-targets.md`. Hold 3 backups for T+7 if needed.
      *Demo-first: visible (outbound).*
- [ ] **10:00 ET — Mavis (project-manager):** Open monitoring window.
      Watch DB signups, error log, UptimeRobot. 30-min check-in cadence through 17:00.
- [ ] **12:00 ET — Cameron:** Reply to every LinkedIn comment within 4 hours.
      DM the top 3 commenters with the link.
- [ ] **16:00 ET — Mavis (project-manager):** First KPI snapshot.
      Signups, solo completions, inbound leads, 5xx count.
      Save to `docs/launch/kpi-snapshot-2026-07-13.md`.
- [ ] **20:00 ET — Cameron:** Optional one-line LinkedIn update if a milestone
      is worth sharing (e.g. "First 10 solo teachers signed up today").
      *Demo-first: visible (social).*

---

## 3. Post-launch follow-up (T+1 to T+30)

### Weekly cadence (every Fri 15:00 ET)

- **Mavis (project-manager):** Pull signup count, solo-completion count, inbound
  leads, error count. Compare against KPI targets. Save weekly snapshot.
- **Cameron:** Reply to every LinkedIn DM and email inquiry within 24 hours.
- **Cameron:** One weekly LinkedIn update — milestone, lesson, or customer quote.

### T+3 (Thu 2026-07-16)

- [ ] **Cameron:** DM the 3 most-engaged LinkedIn commenters. Offer a 15-min
      walkthrough in exchange for honest feedback.

### T+7 (Mon 2026-07-20) — first-week review

- [ ] **Mavis (project-manager):** First-week KPI report vs. targets.
      Flag any metric off by >50%.
- [ ] **Cameron:** Decide whether to send the held-back 3 cold emails
      from `lead-gen-targets.md` (if LinkedIn <20 reactions AND cold reply <5%).

### T+14 (Mon 2026-07-27) — second-week review

- [ ] **Cameron:** Pull one concrete testimonial (DM or email quote) from a teacher
      who completed the wizard. Add to `case-study-edusupervise.md` and Upwork profile.
- [ ] **Mavis (coder):** If solo-completion rate is <50%, queue a UX audit on
      wizard steps 2-4 (the drop-off zone in similar funnels).

### T+30 (Mon 2026-08-10) — launch closeout

- [ ] **Mavis (project-manager):** Final 30-day report. Total signups, solo
      completions, inbound leads, conversion rate. Compare to KPI targets.
      Save to `docs/launch/retrospective-30d.md`.
- [ ] **Cameron:** Write 3 wins, 3 misses, 3 next-quarter actions.
      Update `case-study-edusupervise.md` with actuals (replace the
      forward-looking "200+ teachers" copy).
- [ ] **Mavis (project-manager):** Identify the top 5 teachers by usage
      frequency. Schedule 60-day check-in (T+60) for retention
      → handoff to `account-manager`.

---

## 4. KPI targets — first 30 days

| KPI                                   | Target | Stretch | Source of truth                                |
|---------------------------------------|--------|---------|------------------------------------------------|
| Solo signups (wizard completed)       | 30     | 50      | DB `users` where role=teacher AND source=solo |
| Wizard completion rate (start → done) | 60%    | 75%     | DB: 5-step funnel events                       |
| Median time-to-first-duty             | ≤15 min| ≤11 min | case-study benchmark                           |
| Inbound leads (email inquiries)       | 5      | 10      | inbox + `/contact` form submissions            |
| Visitor → signup conversion           | 5%     | 8%      | Plausible or PostHog + DB count                |
| LinkedIn post engagement (week 1)     | 50 reactions, 10 comments | 200 / 30 | LinkedIn analytics                |
| Cold-email reply rate                 | 10%    | 20%     | `cold-emails-batch-1.md` reply tracking        |
| Critical errors (5xx)                 | 0      | 0       | Sentry or UptimeRobot                          |

**Case-study note:** the draft case study lists "205 teachers in the first 30 days"
and "200+ teacher sign-ups" — those numbers are **forward-looking** copy. Do not
publish the case study externally until T+30, and replace with actuals first.

---

## 5. Risk register

| #  | Risk                                                                              | L     | I     | Mitigation                                                                                                  |
|----|-----------------------------------------------------------------------------------|-------|-------|-------------------------------------------------------------------------------------------------------------|
| R1 | Solo signup flow has a UX bug that drops users mid-wizard                         | Med   | High  | Day -5 e2e walkthrough by Cameron; Day -4 PDF smoke test by Mavis; UptimeRobot + Sentry from Day -3        |
| R2 | LinkedIn post flops (<10 reactions in 24h)                                        | Med   | Med   | Jason email + Upwork profile live as parallel funnels; held-back 3 cold emails ready for T+7                |
| R3 | Jason beta test exposes a real bug in the wizard or PDF parser                    | Low   | High  | Demo-first rule — never auto-send a fix without Cameron's sign-off; revert > rework if uncertain           |
| R4 | Cold-email reply rate <5% (well below target)                                     | Med   | Med   | T+7 review; if confirmed, switch tactic to LinkedIn DMs (higher reply, lower volume, warmer signal)         |
| R5 | Case-study numbers ("200+ teachers") leak externally before T+30 and contradict actuals | Low   | Med | Keep case study internal-only until T+30; update with actuals before any external publish or pitch        |

---

**Stop when:** all T-7 to T+30 items checked, KPI targets reviewed weekly,
retrospective written at T+30, no critical errors during launch window,
top-5 retention list handed to `account-manager`.

## Code Status (verified 2026-07-04)

Pre-launch audit FAIL → swarm shipped (28 + 15 = 43 commits) → runtime probes caught 8 real bugs my smoke tests missed → all 8 fixed + verified → now genuinely PASSED.

- 12 + 1 = 13 GitHub issues closed (#2 through #14)
- 113/113 tests passing across the monorepo
- Zero new real-bug TS errors
- All 6 fix-swarm commits verified by an independent security audit
- migration 0011 applied (FORCE RLS on auth_session)
- CSP header live, Docker compose hardened, Stripe timestamp tolerance added
- Pre-launch audit verdict: PASSED smoke (BLOCKING/HIGH verified by Verifier A + Security-Audit B)

