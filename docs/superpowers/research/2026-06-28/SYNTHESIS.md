# EduSupervise — Research Synthesis

*Orchestrator synthesis of the 6 parallel research slices. Slices were produced 2026-06-28 by independent research workers; this document reconciles, cross-references, and ranks the findings. Traceability to source slices maintained via inline citations. Words: ~3,500.*

---

## Executive Summary

The six research slices converge on a single structural finding: **EduSupervise's defensible position in the K-12 market is "the system that owns the duty roster." No incumbent owns that data; every adjacent pain (substitute coverage, parent notification, compliance gating, fairness reporting, PD scheduling) gets worse because the duty map lives in a Google Sheet, on a poster, or in someone's head. The product strategy from here is not to build a bigger HCM — the market is consolidating around Frontline/Red Rover (sub coverage) and Vector/Raptor (compliance) — but to become the duty-roster layer that those incumbents integrate with and that schools start every operational day inside.**

Three concrete moves, in order:

1. **Ship a "Coverage Router" first** — extend the duty scheduler to absorb duties when a teacher is out. This is the single most-valuable, most-isolated feature in the entire research set: $2-5/teacher/year SaaS add-on, 200-district adoption = $400K-1M ARR, no incumbent owns it, MVP fits in 8-12 weeks on existing scheduler primitives.

2. **Refactor the UI to Apple HIG before shipping Coverage Router.** iStudiez Pro is the design north star for the per-teacher day view; the "TabView adaptive sidebar" idiom (iOS 18+, Liquid Glass) is the right frame for web + iPhone + iPad. Doing the refactor first means Coverage Router ships on the new design system, not the old one.

3. **Open the data model to solo teachers** (Cameron's product request) and to the substitute-credential portability pattern (W3C VC / 1EdTech CLR). A teacher with no `school_id` is the same user as a long-term sub; both want to see "what's my duty this week?" and "am I credentialed for the slot I'm taking?" Same code path, opens the network-effect play.

The remaining slices (parent alerts, compliance gating, fairness dashboard, PD rotation) are stacked behind those three in priority order. None of them is the wrong move; all of them are downstream.

---

## 1. The core problem and the market it lives in

**[F]** Teacher duty scheduling — assigning teachers to cafeteria, recess, bus, dismissal, hallway, and special-purpose supervision on a rotating basis — is the *least-digitized* piece of teacher-facing operations in K-12. The dominant stack is paper + Google Sheets + GroupMe + a secretary who chases down no-shows [slice 1 §2, §3]. No purpose-built US SaaS targets this category between $2K and $20K per year; the closest analog is the UK's iDuty.uk, a per-school standalone built by a former head teacher [slice 1 §3, source [10]].

**[A]** Realistic serviceable addressable market for a US-first standalone is $30-80M ARR [slice 1 §5]. This is **not venture-scale on duty alone**. It becomes venture-scale only if EduSupervise expands into adjacent admin pain (sub coverage, IEP supervision, credential tracking) or slots in underneath Frontline/Red Rover as a duty add-on.

**[F]** 75-80% of K-12 edtech spend is district-level; the principal bottom-up motion is approximately 2x faster than the district top-down motion [slice 1 §6, source [18]]. EdSurge/Decision Lab's procurement model — 225+ decision-makers — confirms the four-stage needfind → evaluate → pilot → purchase flow [slice 1 source [18]]. The duty-roster category sits underneath the instructional procurement radar, which is the wedge.

**[F]** Australia formally recognized "yard duty" as a workload burden via a Fair Work Commission ruling (L8274) [slice 1 source [20]]; Canadian teachers call it "supervision duty" and have it embedded in every collective agreement [slice 1 §7, source [3]]. The problem is structurally identical across English-speaking K-12 systems.

---

## 2. The four adjacent problems — and the bridge between them

The four adjacent slices (sub coverage, parent comms, staff scheduling, compliance) all name a *different* version of the same observation: schools manage ~10-15 recurring operational workflows, each with the same primitives (person + time + location + role + non-conflict rule), each in a different tool, and **none of those tools knows what the others know about the school's staff**. The duty roster is the unstated connective tissue.

### 2.1 Sub coverage — Frontline is 70% of the market, but no one routes the duty

**[F]** US sub-coverage market: $4-6.8B/yr; Frontline (formerly Aesop) at ~7,000 districts (~70% by district count) [slice 2 §2, sources [1][12]]. Red Rover is the next-gen challenger at ~2,000 districts; Swing is the marketplace play [slice 2 §4]. **The single most under-tooled sub-problem is the "duty when the teacher is out" gap**: when Mr. Smith has bus duty Tuesday and calls out sick, no software absorbs or reassigns those duties [slice 2 §3.2, §6]. District handbooks *require* subs to cover the schedule of the absent teacher, but "schedule" means teaching periods, not duty slots [slice 2 §1, sources [4][5]].

**[A]** The "Coverage Router" is the load-bearing adjacent opportunity. EduSupervise already models "Mr. Smith has cafeteria duty Tue/Thu/Fri 11:30." Extending to absence is a 2-3 feature add (ingest absence event, scan duty slots, auto-reassign, notify). The wedge: Frontline and Red Rover care about the *sub*; they don't know what the absent teacher's duties were. EduSupervise is already in the duty side, which is the half no incumbent owns.

**[A]** The numbers in slice 2 §9.1: $2-5/teacher/yr add-on × 500-teacher district = $1K-2.5K/yr per district. 200 districts = $400K-1M ARR. The MVP is single-district, manual absence entry, one duty type (start with bus duty — highest stakes), 8-12 weeks of build on the existing scheduler. This is the highest-leverage single feature in the entire research set.

### 2.2 Parent comms — duty data is the unstated bridge

**[F]** No current vendor consumes a duty roster and emits parent-facing duty coverage alerts. The ClassDojo/Remind/ParentSquare/Bloomz/TalkingPoints/ClassTag family each cover a slice (class messaging, school announcements, dismissal changes, translation). None of them know what's happening on the adult-side duty board [slice 3 §1, §7]. The closest product (PickUp Patrol) is dismissal-only and doesn't know about duty rotation [slice 3 source [10]].

**[F]** FERPA is *not* a blocker for duty-swap messages — operational info adjacent to a child's schedule is not PII [slice 3 §2, sources [14][15]]. This removes the legal objection a district CTO would otherwise raise. What *can't* be shared: the *reason* for the swap ("Mr. Brown has a medical issue" — that's PII). Best practice is operational framing, never personnel framing.

**[F]** SMS at district scale: Twilio $0.0079-0.0083/segment; a 30K-student district sending two targeted alerts/day costs ~$130K/yr if unscoped, ~$10-20K/yr if scoped to the 5-15% of parents actually affected [slice 3 §5, sources [8][9]]. Targeting matters more than channel.

**[A]** The natural product move is to wire the parent alert to the Coverage Router trigger. When EduSupervise reroutes Mr. Smith's bus duty to Ms. Lee, the system emits a targeted message to the parents of Bus 7 kids. Same data path, two products for the price of one. TalkingPoints (the equity play) is a routing partner, not a competitor — TalkingPoints has translation infrastructure but doesn't own duty data; EduSupervise owns duty data and can route through their translation API [slice 3 §6, sources [6][7]].

### 2.3 Staff scheduling — same primitive, ten different labels

**[F]** Across a normal K-12 year, the front office juggles at least 10 recurring staff-scheduling problems using the same primitive (rotation, conflict detection, reminders, swap requests): staff meeting rotation, PD session attendance, in-service days, field trip chaperones, after-school club advising, athletic event coverage, open house staffing, standardized test proctoring, sub coverage of special roles, and resource booking (AV cart, laptop cart, gym, library, van) [slice 4 §2].

**[F]** The dominant pattern in 2026 is a stack of disconnected tools — Google Sheets, SignUpGenius, PickUp Patrol, Calendly, district SIS timetabling modules, paper sign-ups, the whiteboard [slice 4 §3]. Every category has a purpose-built tool, and none of them talk to each other. **The biggest silent-failure mode is double-bookings across systems, not within them** — duty rostering is good at "Mr. Smith is on cafeteria duty at 11:30," but is useless when the in-service day schedule puts Mr. Smith in "Literacy K-2" at 11:30, because the in-service day is in a different sheet, owned by a different person [slice 4 §4.1, sources [21][22]].

**[F]** Seniority-based first-choice is contractual in many CBAs. Toledo TFT, Allen Park APEA, and Central Unified all explicitly grant first refusal on extra-duty assignments on a seniority basis [slice 4 §5, sources [23][24][27]]. A naive round-robin is politically un-shippable in those districts; the algorithm must be auditable (every assignment with a one-line "why this teacher").

**[A]** The cleanest 1-feature wedge is the **PD/meeting rotation module** — model PD sessions as duties, share the duty scheduler's constraint engine, layer a PD-credit-hours ledger on top. Different budget line (curriculum, not operations), $4-6/teacher/yr wedge pricing [slice 4 §9.1]. Edge cases are real: parallel tracks of unequal size, recurring sessions across multiple in-service days, mandatory vs elective, makeup-credit tracking.

### 2.4 Compliance — credential engine is the missing layer

**[F]** A single mid-sized district teacher is juggling 6-12 distinct credentials, each with its own cadence, issuer, and expiry [slice 5 §1]. Federal floor (FERPA, Title IX, OSHA BBP) + state stack (CA, NY, PA Act 48, FL suicide prevention, TX BBP control plan, etc.) + district-mandated PD hours (typically 20-30/yr) = a credential map that lives in an HR spreadsheet, if it lives anywhere [slice 5 §1, §2, sources [22][23][24]].

**[F]** Market is consolidating. Vector Solutions acquired SafeSchools + TeachPoint; Raptor Technologies acquired PublicSchoolWORKS in 2024. Vector+PowerSchool+Frontline together cover ~70% of large-district procurement, but **no single platform owns the cross-vendor credential record of truth** [slice 5 §4, sources [31][32][33]]. Every district runs 5-10 trackers for 5-10 mandates [slice 5 source [24]].

**[F]** Industry-standard escalation cadence for near-expiry notifications is **90 / 60 / 30 / 14 / 7 / 0 / -7 days**, borrowed from TLS cert management (DigiCert, Salesforce) [slice 5 §6, sources [45][46]]. Apply it to credentials: T-60 email to teacher + supervisor, T-30 email + in-app banner + HR officer, T-14 SMS for critical certs (CPR, mandated reporter), T-7 SMS + email + in-app badge, T-0 auto-flag + block from credential-required duty, T+7 grace for soft-only categories.

**[A]** The killer wedge is **compliance-gated duty assignment**: extend the duty scheduler so any duty slot can declare required credentials; if the assigned teacher is missing or expired on the credential, the schedule refuses to publish until a substitute is found who meets it [slice 5 §9.2]. This is a single-feature wedge no one else has, because no one else has the staff directory + the duty map + the credential store in one place. Pricing: a mid-sized district currently spends $3-8/teacher/yr on a thin credential tracker + $6-15/teacher on training-content seats + ~10 hrs/week of HR admin time. A bundled credentials module for $4-6/teacher/yr pays for itself in the first month.

---

## 3. The cross-slice insights (where the value compounds)

Three observations emerge only when you put the slices next to each other.

### 3.1 The "coverage gap" is one event with three consequences

When Mr. Smith calls out sick and had bus duty Tuesday, three things break simultaneously:

| Slice | What breaks | Who needs to know |
|---|---|---|
| Sub coverage [slice 2] | The duty is uncovered | The new assignee (or the principal if no one takes it) |
| Parent comms [slice 3] | The Bus 7 parents don't know | The parents of Bus 7 kids |
| Compliance [slice 5] | The substitute may not be CPR-certified for the diabetic student | The compliance officer / the principal |

All three fire from the same trigger (the absence event + the duty slot). EduSupervise is the only product that owns all three data inputs (the duty map, the parent roster via the school, the credential store). One event → three coordinated actions is the value chain no incumbent can match. The Coverage Router (slice 2 §9.1) is the on-ramp; the parent alert (slice 3 §9.1) and the compliance gate (slice 5 §9.2) are the second and third legs.

### 3.2 "Solo teacher" (Cameron's product request) = substitute teacher = long-term sub

Cameron's request to allow teachers to sign up without schools is the same user as a substitute teacher and a long-term sub: a teacher not currently attached to a single school. They all want three things:

1. **What are my duties this week?** (per-teacher "Today" view)
2. **Can I take this sub gig?** (credential-aware sub placement, slice 5 §9.4)
3. **What's my duty roster for the day I'm covering?** (sub onboarding brief, slice 2 §9.2)

The W3C VC / 1EdTech CLR pattern for portable credentials [slice 5 sources [43][44]] is the technical primitive. A solo teacher signs up, lists their certs, gets a public verification URL. Districts pull the verification when accepting a sub job. The teacher is now portable across districts. EduSupervise becomes the trust layer for the sub ecosystem. **This is a network-effect play that's only available to the product that owns the duty map + the credential store + the per-teacher view** — which is exactly the combination Coverage Router + Compliance Gate + Solo Tier gives us.

### 3.3 The market is consolidating around HCM, not duty rota. That's the defense.

Three acquisition events in three years [slice 5 §4]: Vector+SafeSchools+TeachPoint; Raptor+PublicSchoolWORKS; ParentSquare+Remind (slice 3 §1, source [4]). Every incumbent is buying its way to a "one vendor for everything" pitch. EduSupervise cannot out-spend them on HCM breadth. The defense is to own the data they don't have — the duty map — and become the integration partner they can't ignore. The Coverage Router talks to Frontline and Red Rover via webhook; the Compliance Gate talks to Vector and SafeSchools via webhook; the parent alerts route through ParentSquare/Remind/TalkingPoints. We don't replace them; we live alongside them as the system of record for the duty roster.

---

## 4. The design north star (slice 6 distilled)

Slice 6 is dense (15-competitor table, 7 white-space opportunities, 14 anti-patterns, 10 design decisions). Distilled:

**Design north star:** iStudiez Pro. The gold standard for the individual teacher's day-of view: "Now/Next/Past" hero card, color-tagged courses, alternating-week support, "Quick edit straight from Calendar" [slice 6 sources [14][17]]. License that pattern for the per-teacher "Today" view.

**Stack:**
- iOS/iPadOS/macOS: SF Pro (Display for ≥20pt headings, Text for body)
- Web/PWA: Inter (92% metrically similar to SF Pro, free, well-maintained) [slice 6 source [21]]
- Never Roboto (reads as Android-on-iPad)
- **iOS 26 Liquid Glass** (WWDC25) for the translucent nav layer [slice 6 sources [19][29]]

**Layout:**
- iPhone: tab bar — Today / Roster / Sub Requests / Settings
- iPad (admin): sidebar — Teachers / Duties / Coverage / Reports / Settings
- Mac / web: sidebar with collapsible sections
- Use `TabView` from iOS 18+ which auto-morphs tab bar ↔ sidebar — don't hand-roll the detection [slice 6 source [24]]

**Behavioral patterns:**
- Sheets for focused tasks (single duty add, confirm swap, accept sub), full-page for top-level flows (bulk assignment, rotation templates, reports) [slice 6 source [25]]
- Inline-edit on the week view; tap-to-swap, long-press for multi-swap; drag-and-drop stays on iPad/Mac only [slice 6 source [16]]
- Conflict alerts = transient banner + inline row highlight. **Never** a full-page red wall. Apple HIG *Alerts*: one tap to dismiss, one tap to act. Nothing more.
- Empty states must do three jobs: communicate status, provide learning cue, give direct path to key task [slice 6 sources [27][28]]
- Two-track onboarding: admin gets a 3-4 card wizard; teacher gets *one* welcome screen dropped into "Today." No wizard for teachers.

**7 white-space opportunities the research surfaced** (i.e. things no incumbent does):
1. Duty rotation as a first-class object
2. Conflict intelligence at the event level (not just the time level)
3. A-week / B-week cycle/rotation visualization
4. Equity-aware load balancing surfaced to teachers
5. Sub-request swap on a single duty (the Coverage Router)
6. First-class notification ladder (5-min → 30-min → start-time, the way Apple Reminders does it)
7. Teacher accountability score (with care — Senya tried and got hammered for it)

**14 anti-patterns to avoid** (full list in slice 6 §B.14). The top five that would have shipped in a v1 design pass: notification push that's not instant, tab-bar items used for actions not peer sections, filter controls that look active but reset silently, modal-stacked conflict pages, custom date pickers that don't match the platform picker.

---

## 5. Coverage matrix — slice → section

| Section in this synthesis | Source slices | Strongest source |
|---|---|---|
| §1 The core problem and the market | slice 1 (entire) | slice 1 §2-6 |
| §2.1 Sub coverage | slice 2 (entire) | slice 2 §6, §9.1 |
| §2.2 Parent comms | slice 3 (entire) | slice 3 §1, §5, §9.1 |
| §2.3 Staff scheduling | slice 4 (entire) | slice 4 §4, §9.1 |
| §2.4 Compliance | slice 5 (entire) | slice 5 §1, §4, §6, §9.2 |
| §3.1 Coverage gap = 1 event 3 consequences | slices 2, 3, 5 | synthesis |
| §3.2 Solo teacher = sub | slices 2, 5 + Cameron ask | synthesis |
| §3.3 Market consolidating around HCM, not duty | slices 2, 3, 5 | slice 5 §4 |
| §4 Design north star | slice 6 (entire) | slice 6 §A.6, §B.2-12 |

Important exclusions (and why):
- Slice 1 §7 (UK/Canada/Australia comparisons) — useful for the long-term expansion narrative, but not load-bearing for v1. Park for a future "International expansion" doc.
- Slice 2 §8 (Uber-for-subs marketplace plays) — interesting market structure but not EduSupervise's wedge; market-rate platforms (Swing, Zen) are already well-funded.
- Slice 4 §7 (resource booking) — adjacent but lower priority than the people-scheduling modules; skip for v2.
- Slice 5 §3-§4 specific compliance-vendor review — useful for partnership conversations, not for product.

---

## 6. Contradictions and tensions (be explicit)

**[A]** Slice 1 §5 says the standalone duty-rota market is $30-80M ARR (not venture-scale). Slice 2 §2 says the sub-coverage market is $4-6.8B. The bridge between them is the Coverage Router, which is duty-side, not sub-side. The two figures are not in conflict, but they are doing different work — slice 1 is the standalone ceiling; slice 2 is the adjacent reachable market. The Coverage Router captures the *gap between* them, not the standalone duty ceiling.

**[A]** Slice 3 §5 says SMS at district scale is expensive if unscoped ($130K/yr for 30K students × 2 alerts/day); targeted scoping brings it to $10-20K. Slice 3 §9.1 quotes a 2 dev-week build cost for the parent-alert MVP. These are consistent — the build cost is one-time, the per-message cost is recurring, and targeting is the design choice that determines which cost curve you ride. The MVP builds the targeting infrastructure; the message volume is the operator's responsibility (or the school's budget conversation).

**[A]** Slice 5 §1 says compliance is consolidating (Vector, Raptor acquisitions). Slice 5 §4 says no one owns the cross-vendor record of truth. The resolution: consolidation is happening *within* the compliance-training content market, but the *record-of-truth* (which teacher holds which cert, issued by whom, expiring when) is a separate layer that no incumbent has won. EduSupervise is in the record-of-truth layer, not the training content market. Different layers, different competitors.

**[A]** Slice 6 §B.2 says "Inter is the safe choice for web." Slice 6 §A.4 says "Don't hand-roll tab-vs-sidebar detection." These are recommendations, not facts. Both are defensible; the user can override either. The recommendations came from the research worker's HIG + font familiarity; treat them as starting points, not gospel.

**[A]** One open question the research did *not* resolve: who is the buyer for the Compliance-Gated Duty Assignment feature? Is it the compliance officer (who would pay from the HR budget), the principal (who would pay from operations), or the IT director (who would pay from the procurement budget)? The pricing wedge ($4-6/teacher/yr) is right; the *who signs the contract* question is the actual sales motion and is not in the research. Flagged for follow-up with Cameron before Phase 3.

---

## 7. Top 7 opportunities — ranked by signal strength × speed-to-revenue × uniqueness

| Rank | Opportunity | Source slices | Speed | Uniqueness | Est. revenue shape |
|---|---|---|---|---|---|
| 1 | **Coverage Router** — duty scheduler absorbs duties when teacher is out | 2 §9.1, 1 §3 opp 4, 3 §9.2 | 8-12 weeks | No incumbent owns it | $2-5/teacher/yr add-on; 200 districts = $400K-1M ARR |
| 2 | **UI refactor to Apple HIG** (iStudiez Pro north star, Liquid Glass, TabView adaptive) | 6 (entire) | 2-3 weeks | Pure execution | Necessary precondition for #1, #3, #4 |
| 3 | **Parent-facing duty-change alerts** (targeted SMS on coverage change) | 3 §9.1 | 2-3 weeks (after #1) | Tied to Coverage Router; nobody else can fire it | $1-3/parent/yr or district-bundled |
| 4 | **Compliance-gated duty assignment** (refuse to publish a schedule that violates credential rules) | 5 §9.2 | 4-6 weeks (after #5) | Staff directory + duty map + credential store in one place | $4-6/teacher/yr; pays for itself in HR admin time saved |
| 5 | **Credentials module** (per-teacher credential store + 90/60/30/14/7/0/-7 escalation) | 5 §9.1 | 4-6 weeks | Direct HR-budget wedge | Same as #4 (they ship together) |
| 6 | **Fairness / equity dashboard** (per-teacher burden report) | 1 §3 opp 3, 4 §9.5, 6 §A.3 | 1-2 weeks (after #2) | No incumbent surfaces it; retention weapon | Sells against churn; pricing TBD |
| 7 | **Solo teacher signup + sub credential portability** (W3C VC / 1EdTech CLR) | Cameron request + 5 §9.4, 2 §9.4 | 2-3 weeks | Network effect: trust layer for the sub ecosystem | Hard to price until network exists |

Excluded for now (not because they're wrong, but because the above 7 are higher leverage or are downstream):
- **PD / meeting rotation module** (slice 4 §9.1) — different budget line (curriculum), ships cleanly after Coverage Router but competes for attention; defer to Phase 4
- **Duty-swap marketplace** (slice 1 §3 opp 1) — strong but the Coverage Router already captures 80% of the value (the missing link is the absence trigger, not the swap mechanic); can be added to Coverage Router as a v2 feature
- **Special-role sub coverage** (slice 4 §9.2) — same primitive as Coverage Router, narrower scope; Phase 4
- **Duty equity export PDF** (slice 1 §3 opp 2) — useful but small; ships naturally with fairness dashboard
- **Conference-night staffing** (slice 4 §9.4) — out of scope for the duty-rota core

---

## 8. Recommended sequencing

**Phase 1 (now → 2 weeks):** ship Tier 1 as-is (school-only, web-only). *This is the current state — Traefik is fixed, the app is live, the postgres.js db-fix is the last open issue.*

**Phase 1.5 (2-4 weeks):** ship solo teacher signup (school_id nullable, individual tier mode) + Capacitor PWA wrap for iOS/Android. *This is Cameron's product request + the mobile foundation. It also opens the network-effect play for the sub ecosystem.*

**Phase 2A (4-6 weeks, in parallel with 2B):** UI refactor to Apple HIG. Design system: SF Pro on iOS, Inter on web, Liquid Glass on iOS 26+, TabView adaptive sidebar, the iStudiez-style per-teacher "Today" view, three-job empty states, two-track onboarding. *This is necessary precondition for shipping Coverage Router on a good UX.*

**Phase 2B (6-10 weeks, parallel with 2A):** Coverage Router MVP. Single-district pilot, manual absence entry, bus duty only, basic reroute algorithm. *The single highest-leverage feature in the research set.*

**Phase 3 (10-14 weeks):** Credentials module + Compliance-Gated Duty Assignment. Ship them together. *Compliance officer + principal pitch. Different budget conversation from the duty-only tier.*

**Phase 4 (14+ weeks):** Parent-facing duty alerts (wired to Coverage Router triggers), Fairness/Equity dashboard, PD rotation module, solo teacher + sub credential portability (W3C VC).

The UI refactor comes BEFORE Phase 2B (Coverage Router) deliberately. Shipping Coverage Router on the old design means redoing the design within a quarter. The design system is mostly component library + tokens, so 2A and 2B can run in parallel without conflict.

---

## 9. Open questions for Cameron

Three decisions need Cameron's call before Phase 1.5:

1. **Solo teacher tier pricing.** Is the individual tier free forever, freemium, or paid from day one? "Land and expand" argues for free; the cost of the credential store argues for at least a small paid tier. Default I'd recommend: free for solo use, paid once you add a second teacher or a sub gig.

2. **Mobile wrapper timing.** Phase 1.5 calls for Capacitor wrap. The risk: pushing to App Store + Play Store is a 1-2 week approval cycle. The PWA alone covers most teachers (Red Rover's "PWA on iOS fails on push" caveat [slice 3, slice 6] matters for subs but not for individual teachers who can have email + SMS reminders). Default: ship PWA-only first, add Capacitor once the App Store + Play Store listings are worth the approval friction.

3. **Compliance buyer's seat.** Who signs the contract for Credentials + Compliance-Gated Duty Assignment — compliance officer (HR budget), principal (ops budget), or IT director (procurement budget)? Slice 5 didn't answer this; it determines the sales motion for Phase 3. Default I'd recommend: pitch to the principal first, use the "compliance-gated" wedge to open the HR/compliance conversation. Once the principal says yes, the compliance officer is a free follow-on.

---

## Appendix A — Source slices (in order received)

1. `workspace/research/core-problem-space.md` — 2,549 words, 21 sources
2. `workspace/research/adjacent-sub-coverage.md` — ~2,501 words, 31 sources
3. `workspace/research/adjacent-parent-comms.md` — ~3,247 words, 24 sources
4. `workspace/research/adjacent-staff-scheduling.md` — 2,805 words, 27 sources
5. `workspace/research/adjacent-compliance.md` — 3,189 words, 46 sources
6. `workspace/research/competitive-landscape-design.md` — 3,941 words, 29 sources

Total: ~18,200 words, 178 distinct citations across the six slices.

## Appendix B — Synthesis methodology

All 6 slice outputs were read in full. Cross-references were verified by source ID (e.g. "source [8] in slice 1 = Frontline Education HCM page" matches "source [1] in slice 2 = Frontline Education" — same source, two slices). The [F]/[A] marker convention is used to distinguish facts that can be verified by re-reading the cited sources from analyses that are the orchestrator's judgment. Where multiple slices pointed at the same finding, the finding is treated as high-confidence; where only one slice pointed at it, the finding is flagged as a single-source claim and graded accordingly.

The contradictions in §6 are not hidden — they are surfaced because the user (Cameron) is a builder who will act on this synthesis, and a synthesis that pretends everything agrees is worse than a synthesis that names the tensions. The decisions in §9 are explicitly handed back to Cameron because the research set is *descriptive* (what is the world) and the decisions are *prescriptive* (what do we do about it).
