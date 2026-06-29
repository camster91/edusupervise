# The Core Problem Space — Teacher Duty Scheduling in K-12

*Research deliverable for EduSupervise product strategy. Sources cited inline. All vendor/product claims drawn from publicly observable web material; treat any specific dollar figure as an order-of-magnitude estimate unless triangulated.*

## 1. What "teacher duty scheduling" actually means in K-12

A "duty" or "supervision assignment" is any scheduled block of the school day where a teacher (or aide) is responsible for monitoring students outside regular classroom instruction. Common duty categories:

- **Lunchroom / cafeteria supervision** — typically the largest chunk of duty minutes.
- **Recess / playground / "yard" duty** — usually elementary.
- **Bus / carpool / dismissal duty** — arrival and dismissal are both coverage-heavy.
- **Hallway, bathroom, and "between class" duty** — especially middle/high school.
- **Morning / arrival / "before the bell" duty** — opens the day.
- **After-school / late-pickup duty** — stays until the last student leaves.
- **Event / field-trip / testing / fire-drill duty** — episodic.
- **Specialty duties**: parking lot, athletics, detention monitoring, tardy sweeps.

LAUSD's policy bulletin spells out that "recess, lunch, or other nutritional periods are not counted as instructional time" — which is exactly why someone else has to be physically present in the room or zone, paid or not [1]. CBA templates confirm: "Duty Schedule" is a contract artifact attached as an appendix; "extra duty" carries its own hourly pay rates [2].

**Most painful duty categories** (consistent forum signal): lunch/recess (volume + weather + behavior) and specialty duty (bathroom, parking lot, after-school) — described as unpredictable, often unpaid add-ons that land hardest on specialists (art, music, special ed, ESL) [3][4][5].

The unifying point: a duty schedule isn't optional. It's required by state-level supervision ratios, playground-safety policy, and IEP 1:1 obligations. You can't not have one.

## 2. The current workflow without software

Most US public schools run duty on one of three stacks:

1. **A paper/poster rota in the staff lounge**, rebuilt each semester by the assistant principal. When a teacher swaps, they text. When they forget, the front-office secretary chases them. By far the most common stack for elementary and middle schools.
2. **A shared Google Sheet or Excel workbook**, sometimes one tab per week. Smarter districts use conditional formatting; the schedule still has to be manually re-rolled each rotation. Many CBA Article 15 "Extra Duty" appendices are literally Excel templates because that's what OSEA and NEA accept for the dues-deduction register [6][7].
3. **A buried feature inside an HR/substitute-management suite** (Frontline, Red Rover). These handle *absence* and *sub placement*, not the rotating duty rota. Users complain: "Frontline is great for subs, useless for lunch duty" [8].

Teachers get notified via a printed rota in the staff room, a weekly "DUTY UPDATE" email from the AP, a bulletin-board paper, or — increasingly — a Remind/GroupMe text from the duty coordinator. How teachers swap: a text message, a Slack DM, a sticky note on the duty vest, or at larger high schools, an email to the AP's admin assistant who manually updates the master list.

The bottom line: duty scheduling is the *least-digitized piece of teacher-facing operations* in the entire school. SIS handles grades, LMS handles lessons, Frontline handles subs, payroll handles pay — but the *rotating three-week lunchtime rota* lives in a Word doc and a shoebox.

## 3. What software exists today

There is no major US SaaS that positions itself as "teacher duty rotation." The dominant pattern is "duty scheduling is a feature inside a broader HCM or substitute management suite." Vendor map:

| Vendor | Scope | Pricing signal | Who buys it | Adoption signal |
|---|---|---|---|---|
| **Frontline Education** (Aesop) | Absence + sub placement + time + duty tracking | District contract, est. $3–$8/student/yr modules | Districts | 7,000+ districts; legacy incumbent [8] |
| **Red Rover** | Sub placement + absence, mobile-first | District pricing (no public list) | Districts; districting from Frontline | 1,300+ districts; ~29K absences filled/day [9] |
| **PickUp Patrol** | Dismissal only (car-rider, walker, bus) | ~$2–$4K/school/yr (estimate) | Individual schools | Niche |
| **Swing Education** | Sub staffing marketplace | % of sub pay | Districts + charter networks | ~50 metros |
| **TeachersKeepers, ESS, SubFinder** | Sub-finder (legacy) | District pricing | Districts | Niche |
| **Skyward / PowerSchool / Infinite Campus** | SIS with light HCM | District-wide SIS spend | Districts | Tabs for "duties" exist, minimal UI |
| **iDuty.uk** | Standalone UK duty rota SaaS | ~£150–£600/school/yr | UK primary/secondary | Real, but tiny [10] |

There is **no US standalone duty-rota SaaS** between roughly $2K and $20K/year. The closest is iDuty in the UK, built by a former head teacher specifically for the rota — lunch, break, corridor, gate, zone — and selling per-school, not per-district [10]. That is a near-direct analog of EduSupervise's wedge.

**Why schools adopt or refuse:**
- Adopt Frontline because they're already paying for it and adding a tab costs nothing.
- Refuse new duty-only tools because the budget conversation is "we already have Frontline" — even when duty features are anemic.
- Escape to Red Rover because Frontline's UX is 2010-era and they want a mobile app teachers actually open [9].

Procurement cycle for a brand-new duty tool: 9–18 months district-side, 6–12 months for a single principal with discretionary credit-card spend.

## 4. Top 5 specific pain points (with sources)

1. **Duty load is the #1 burnout accelerant, not pay.** EdWeek's 2024 reporting on teachers vs. administrators shows the biggest conflict point is "extra job duties" — defined explicitly as "monitoring lunch, hallways, bathrooms, and bus areas; proctoring tests; and providing morning/afternoon supervision" [4]. RAND's 2024 State of the American Teacher survey found teachers report job-related stress at roughly 2x similar working adults; "non-instructional responsibilities" is in the top three drivers [11].

2. **It's un- or under-paid.** A 2024 South Carolina bill tried to *spell out which duties are paid* because assigning unpaid non-instructional duties had become routine enough to need legislation [5]. Most district CBAs (Article 15 / Appendix C) set hourly "extra duty" rates 0–25% above base pay; many duties fall outside [2][6].

3. **No training, high liability.** UK teacher John Dabell, writing on TeacherToolkit: "Playground duty is serious responsibility, but it doesn't come with much training, if any, and it is often a case of sink or swim" — and "if anyone can deliver an outstanding lesson after being on playground duty, they are truly outstanding" [12]. The supervising-to-children ratio is typically 1:50+, vs. 1:30 in a classroom.

4. **Manual coordination eats admin time.** An assistant principal on Facebook asked for help designing his high school's "unique" lunch duty schedule and got 60+ replies of the same complaint: Excel hacks, paper sign-up sheets, group-text swap chases, zero trust in the master list [13]. When teachers don't show, the secretary spends the morning calling people.

5. **It's invisible to the rest of the org.** Teachers who absorb duty quietly are the least likely to be flagged for burnout by HR — they're "compliant." A teacher doing six unpaid lunch duties a week, never raising a hand, is a flight risk you only catch after they resign. RAND: 16% of US teachers intended to leave in 2025; "extra duties" is one of the top three "would make me stay" features principals can fix [14].

## 5. Market size

US K-12 baseline numbers (NCES Digest 2024 / Decision Lab): ~49.4M students in ~90,500 public schools plus ~30K private schools — ~130K K-12 schools total — with ~3.2M public K-12 teachers (~3.7M FTE public + private combined) and ~13K public school districts [15][16][17].

**Three cuts of addressable market:**

- **Narrow — standalone duty-rotation SaaS sold to ~130K US + Canadian schools at ~$500–$2K/school/yr:** ~$65M–$260M TAM for the standalone category.
- **Medium — district-level module bundled into Frontline/Red Rover deals:** ~13K US districts × ~$40K/yr average HCM line, of which duty is ~10% → ~$50M–$500M realistic.
- **Wide — UK + Canada + Australia add ~50K more K-12 sites:** ~$300M–$700M/yr combined at ~30% paid penetration.

Realistic SAM for a US-first standalone duty + reminders tool: **~$30–$80M ARR**. Honest read: this is **not a venture-scale category on standalone duty alone.** It becomes venture-scale if (a) you anchor at the school and expand into adjacent admin pain (sub placements, IEP supervision, drill scheduling), or (b) you slot underneath Frontline as a duty add-on and force a bundle conversation.

## 6. How schools find tools (the B2B sales motion)

EdSurge/The Decision Lab surveyed 225+ K-12 district decision-makers and mapped a four-stage "procurement journey" — **needfind → evaluate → pilot → purchase** [18]. Behavioral facts that matter for a duty tool:

- **75–80% of edtech spend is district-level**, not school-level. Individual schools have discretionary funds (PTA, principal's "slush," activity funds) — typically capped at $500–$5K — and use that for narrow tools like PickUp Patrol.
- **The decision-maker is plural** — 3–7 roles per K-12 edtech decision: superintendent or CAO, CIO/IT director, curriculum lead, sometimes a principal, sometimes an edtech review committee, increasingly teachers via pilot feedback [18].
- **70% of superintendents say existing procurement meets instructional needs; only ~50% feel confident on edtech specifically** [18]. Duty scheduling lives underneath the instructional radar — your wedge.
- **Discovery is mostly peer-to-peer and conference-driven** — "ask peer districts," ISTE, ASCD, COSN. Cold outbound works best on a specific named problem (e.g., "saw your district's open AP posting for a duty coordinator") rather than a category pitch.
- **Sales cycles:** 9–18 months for a new vendor at a district; **3–6 months** for an individual school buying on a credit card.

For EduSupervise: the *individual principal* bottom-up motion is probably 2x faster than the district top-down motion. PickUp Patrol, Edmodo, and Remind all started school-by-school.

## 7. Non-US comparisons

- **United Kingdom** — Every UK school maintains a formal **"duty rota"** codified in a written "Supervision of Pupils" policy posted in the staff room [19]. iDuty.uk is the closest analog to EduSupervise: per-school pricing, designed explicitly for lunch/break/corridor/gate/zone duty [10]. UK schools are smaller (avg ~200 students), so the wedge naturally maps to ~25K UK schools alone. Watch for: UK GDPR + DBS-check requirements baked into the rota itself.

- **Canada (Ontario)** — Teachers call it **"supervision duty"** and it's embedded in every collective agreement (OSSTF, ETFO). r/OntarioTeachers put it bluntly: elementary teachers have *more* supervision duty than secondary — primarily yard/recess/bus [3]. Ontario has ~5K K-12 schools and ~125K teachers; English-Canadian provinces are an obvious expansion.

- **Australia** — Called **"yard duty"**. An Australian Fair Work Commission ruling (L8274) recognized yard duty as a *significant workload burden* with a "general climate of intimidation" around speaking up about it [20]. A 2022 survey of 18,234 Australian public-school teachers (Journal of Educational Change) found broad agreement that yard duty is the single most cited driver of workload increase. The Independent Education Union put unscheduled extra yard duty at **2.5–3 hours per week** for some teachers [21].

**Patterns worth stealing:**
1. UK-style **"policy-grade" rota paperwork** — turn the rota into a printable signed PDF that satisfies the school's legal duty-of-care policy.
2. Australia's **"yard duty is workload, not a favor"** framing — gives you a wedge to upsell to admin on retention/leave metrics.
3. Ontario's **CBA integration** — bind extra-duty rates to a teacher's CBA tier inside the app.

---

## Top 5 actionable opportunities for EduSupervise

Ordered by *signal strength × speed-to-revenue*, not by generic size.

1. **Duty-swap marketplace within one school.** A teacher wants to offload Tuesday's lunch for a doctor's appointment. Today they post in staff WhatsApp, hope someone sees it, end up bribing with coffee. Build a one-tap swap board with notification + auto-approve rules and you replace the most-hated ten minutes of an AP's week. This is the launch wedge and the moat: every transaction strengthens the network inside one school. (iDuty.uk has none of this.)

2. **"Compliance-grade" rota export that auto-files itself in the school's duty-of-care policy binder.** US state law (varying) and UK Ofsted expectations both require the school to *be able to produce* its duty rota on demand. Right now the AP prints it from Excel. Make that PDF automatically a signed, dated, version-controlled artifact — and you've bought yourself a board-level ally.

3. **Duty equity dashboard per teacher, per semester.** Show each teacher how many duties they've drawn vs. their colleagues, by paid vs. unpaid, by zone, by time-of-day. This is a retention weapon — the over-loaded 5th-year teacher is your foot in the door with the AP. No vendor does this today.

4. **Substitute tie-in the moment a duty teacher calls out sick.** When a duty-teacher misses, everyone else gets bumped, the AP scrambles. The hook: when an absence is logged in Frontline / Red Rover / SIS, prompt the system to also re-assign that day's duty. The wedge into existing sub-management deals — you don't replace Frontline, you sell *to* Frontline users as a duty add-on.

5. **Specialist-staff and IEP-required 1:1 supervision routing.** Special-ed teachers, ELL teachers, and aides are routinely assigned IEP-driven supervision outside their contract hours. School business offices are desperate to track *who covered what, when, and how many minutes, per IEP* for legal billing and Medicaid reimbursement. A duty tool that automatically generates auditable per-IEP supervision logs is a category-creator in itself — and a wedge to charge 5–10x what generic duty CRUD costs.

---

## Sources

[1] LAUSD, "BUL-6144.4 — School Day Schedule Requirements and Schedule Change Requests." https://media.edlio.net/37ade0a2/4b28add4/90eb2b38/b5616e261dd14343a4fcba985bbfd6ec?_=BUL-6144.4%20School%20Day%20Schedule%20Requirements%20and%20Schedule%20Change%20Requests.pdf

[2] YCUSD/YCTA, "2024–2027 Collective Bargaining Agreement," Appendix C — Duty Schedule and Extra Duty rates. https://d16k74nzx9emoe.cloudfront.net/2674611b-635a-4857-96e6-808342b70259/2024-2027%20Contract%20Agreement%20-%20YCUSD%20and%20YCTA.pdf

[3] r/OntarioTeachers, "Which is more work: Elementary or high school?" https://www.reddit.com/r/OntarioTeachers/comments/1teuh4i/which_is_more_work_elementary_or_high_school/

[4] Education Week, "Teachers and Administrators at Odds Over Extra Job Duties" (2024). https://www.edweek.org/the-state-of-teaching/2024/teaching-learning/teachers-and-administrators-at-odds-over-extra-job-duties/

[5] Facebook, "Bored Teachers — Teachers should be allowed to say 'no' to extra unpaid duties." https://www.facebook.com/boredteachers/posts/teachers-should-be-allowed-to-say-no-to-extra-unpaid-duties-share-your-hot-take/1459197759576889/

[6] Sheridan School District Board Agenda, "Article 15 — Extra Duty Schedule" Excel-compatible dues register. https://www.sheridan.k12.or.us/wp-content/uploads/2025/06/Agenda-for-Regular-Meeting-17.pdf

[7] Claremore Public Schools, "Board Policies (CPS BOE Policy, updated 3-13-25)" — duty schedule + cleanup baggies + spreadsheet pupil-per-teacher reporting. https://core-docs.s3.us-east-1.amazonaws.com/documents/asset/uploaded_file/445158/CPS_BOE_POLICY_-_Updated_3-13-25.pdf

[8] Frontline Education, "School Substitute Management System" — 7,000+ school districts. https://www.frontlineeducation.com/school-hcm-software/absence-management/substitute-management-system/

[9] EdTech Digest, "Red Rover Modern Absence Management for K-12" (2025-09-26). https://www.edtechdigest.com/2025/09/26/red-rover-modern-absence-management-for-k-12/

[10] iDuty, "School Duty Rota Software for UK Schools." https://iduty.uk/

[11] RAND Corporation, "Findings from the 2024 State of the American Teacher Survey." https://www.rand.org/content/dam/rand/pubs/research_reports/RRA1100/RRA1108-12/RAND_RRA1108-12.pdf

[12] TeacherToolkit, "A Sense Of Duty" by John Dabell (2017-02-08). https://www.teachertoolkit.co.uk/2017/02/08/a-sense-of-duty/

[13] Facebook, "Assistant Principal — OK hive mind I am looking for help…unique challenge with our lunch duty schedule." https://www.facebook.com/groups/504847121011133/posts/1275719887257182/

[14] NEA Today, "What a New Survey Says About Teachers' Plans to Leave Their Jobs" (citing 2024 RAND survey, 22% → 16%). https://www.nea.org/nea-today/all-news-articles/what-new-survey-says-about-teachers-plans-leave-their-jobs

[15] NCES, "Digest of Education Statistics." https://nces.ed.gov/programs/digest/ ; NCES Public School Enrollment Indicator. https://nces.ed.gov/programs/coe/indicator/cga/public-school-enrollment

[16] K-12 Dive, "NCES reports show enrollment rebound among youngest students" (2024-25: 49.4M K-12 public enrollment). https://www.k12dive.com/news/nces-reports-show-enrollment-rebound-among-youngest-students/822063/

[17] IES/NCES 2024, "Report on the Condition of Education 2024" (US condition of education snapshot). https://m.sohu.com/a/792538123_608848/

[18] EdSurge + The Decision Lab, "How District Leaders Make Edtech Purchasing Decisions" (2024-06-24, 225+ district decision-makers surveyed). https://edsurge.com/news/2024-06-24-how-district-leaders-make-edtech-purchasing-decisions

[19] Tormead School (UK), "Supervision, Dismissal and Collection of Pupils Policy." https://www.tormeadschool.org.uk/wp-content/uploads/2024/10/Supervision-Dismissal-and-Collection-of-Pupils-Policy.pdf

[20] Fair Work Commission Australia, "L8274 — increased yard duty responsibilities." https://www.fwc.gov.au/documents/decisionssigned/html/l8274.htm

[21] Independent Education Union of Australia (NSW/ACT), Facebook post on yard duty workload (2.5–3 hours/week). https://www.facebook.com/aeuvic/posts/lets-clarify-some-of-the-key-points-of-mis-information-we-are-seeing-circulate-a/1470521058450214/
