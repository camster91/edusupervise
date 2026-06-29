# Adjacent School-Staff Scheduling: Beyond Duty Rosters

*Research slice for the EduSupervise project. Same primitives as teacher duty scheduling — rotation, conflict detection, reminders, swap requests — applied across the wider staff-scheduling surface area: PD, meetings, chaperones, event coverage, resource bookings.*

## 1. Why this slice exists

EduSupervise's core job is teacher duty scheduling: assigning teachers to cafeteria, hallway, bus, and detention rotations without double-booking. The school office is doing the exact same chore at least six other times a week, with different labels. If we treat "duty rotation" as one feature and "everything else" as not our problem, we ship a single-purpose tool into a workflow that is full of related scheduling pain. If we treat them as a family of problems on a shared primitive, we can stretch our surface area without rebuilding.

This report maps the wider problem space: what schools schedule, how they do it today, where it breaks, and which of those problems can ride on the duty-scheduler primitive we already have.

## 2. The surface area: what schools schedule beyond duty rosters

Across a normal K–12 year, the front office juggles at least the following recurring staff-scheduling problems:

- **Staff meeting rotation** — who presents, who runs tech, who takes notes at each weekly or monthly faculty meeting [1].
- **PD session attendance** — which teacher goes to which session, especially when a district offers parallel tracks (e.g., "Literacy K–2" vs "Math 6–8") on the same in-service day [2][3].
- **In-service / institute day schedules** — full-day agendas that combine plenary sessions with breakout rotations, often requiring rooms, presenters, and substitute coverage simultaneously.
- **Field trip chaperone scheduling** — pulling the right ratio of teachers and credentialed adults for each trip, with attendance-clearance and Raptor-pass dependencies [4][5].
- **After-school club / activity supervision** — assigning an advisor to each club, intramural, or tutoring block; some clubs also need rotating chaperones for off-campus events [6][7].
- **Athletic event coverage** — staffing score tables, ticket booths, and supervision for home games; often paired with the same concessions / gate-duty problem from facility scheduling [7].
- **Open house / conference night staffing** — running an evening where every teacher holds 10-minute slots and dozens of parents book in [8][9].
- **Standardized test proctoring** — assigning two proctors per testing room from a pool that cannot include the teacher of those students [10].
- **Sub coverage of special roles** — librarian, counselor, nurse, special-ed coordinator; absence here can't be covered by a generic sub and the librarian or counselor is often the first to be "pulled" [11][12].
- **Resource scheduling** — booking the AV cart, the laptop cart, the gym, the makerspace, the school vehicles; same single-resource, multi-consumer primitive [13][14].

These are not separate markets. They share the same constraint vocabulary: a person, a time window, a location, a role, and a non-conflict rule.

## 3. What "today" looks like

The dominant pattern in 2026 is a stack of disconnected tools:

- **Google Sheets** with manual coloring — for duty rosters, PD attendance, master schedules. Powerful but conflict-blind; the integrity of the workbook depends on whoever last edited it [15].
- **SignUpGenius** (and its main rival, **SignUp.com**) for parent volunteer spots, party supply bring-ups, field-trip chaperone sign-ups, and concessions slots. Free tier is widely used; both vendors market school plans (SignUp.com's Campus Plan, $199/year/school; SignUpGenius's teacher-per-seat model that "can exceed $1,000 per school per year") [16][17].
- **PickUp Patrol** for daily dismissal changes — the dominant product in K–5 for parent pickup-line logistics; not a teacher-scheduling tool but the canonical example of a single-purpose school-admin SaaS that escaped the spreadsheet [18].
- **Pick-a-time tools for parent-teacher conferences** — Calendly, Doodle, PickUp Patrol itself, and dedicated products like ParentInterview / TeacherReacher / PTCFast / OPTIS, often layered on Google Calendar appointment slots [8][9].
- **Paper sign-ups and the whiteboard** — still common for "first come, first served" lunch duty, Friday bus duty, library slots. Survives because it has zero friction and zero accountability, both virtues and vices.
- **District SIS / LMS** — PowerSchool, Infinite Campus, Canvas, or Schoology; some of them now ship timetabling and proctoring modules (PowerSchool Schoolnet for state testing windows [10]; Canvas for cohort management), but the timetabling side is generally "assign a teacher to a section," not "staff this one-off event."
- **Sub-coverage tools** — Frontline, Aesop, Veracross Cover Management, and aSc Substitutions for day-to-day absences [19][20]. These are mature products but scoped narrowly to one problem.

The pattern: every category has at least one purpose-built tool, and none of them talk to each other. The teacher ends up living in five apps and three spreadsheets, and the school office retains a master calendar in someone's head.

## 4. Top 3–5 pain points (the ones that hurt operationally)

**4.1 Double-bookings across systems, not within them.** Duty rostering tools are good at "Mr. Smith is on cafeteria duty at 11:30." They are useless when the in-service day schedule quietly puts Mr. Smith in "Literacy K–2" at 11:30, because the in-service day is in a different sheet, owned by a different person, on a different day. Nobody catches the conflict until Mr. Smith doesn't show up for cafeteria duty. This is the single largest silent-failure mode in school staff scheduling [21][22].

**4.2 Who owns the conflict?** When two schedules disagree — duty roster, PD spreadsheet, master schedule, the attendance sheet — there is rarely one person who sees all four. The principal delegates. The curriculum coordinator owns PD. The athletic director owns game coverage. The office manager owns sub coverage. The teacher is the integration layer, and integration layers get blamed.

**4.3 Seniority + first-choice conflicts with simple rotation.** Many union contracts explicitly grant "first choice" of extra-duty assignments on a seniority basis [23][24]. Even when seniority isn't contractual, fairness is social currency: Friday-bus-duty and after-school club advising tend to land on the same people year after year because nobody tracks who had what last. Without a fairness ledger, a "round robin" feature is politically un-shippable [25][26].

**4.4 Sub-pull domino effect.** When the school librarian is out, substitutes are scarce; admin pulls the building sub into the library, which pulls a teacher into the teacher's classroom. Teacher librarians explicitly describe this as an ongoing problem [11]. The chain reaction is invisible until it falls over.

**4.5 Last-minute swap chaos.** Duty swaps are mostly handled by two teachers texting each other and the office hoping to notice. PickUp Patrol's "dismissal change tomorrow" flow is the rare exception where the office actually has live visibility [18]. For duty swaps, sub coverage, and PD-slot swaps, the office has neither a record nor a notification path.

## 5. The "shift bidding" pattern in a union context

Shift bidding — let workers self-select preferred shifts within constraints — is standard in healthcare and hospitality rostering [22][25]. The Shyft workforce-management literature frames it as "fairness perception surveys + schedule stability metrics" plus a tie-breaker on seniority or tenure [22]. In Peru, a round-robin + genetic-algorithm hybrid for nurse scheduling reportedly cut execution time by 99.7% and improved fairness by 30% [26].

Translation for K–12: a "bid" would be a teacher saying "I'd prefer Tuesday lunch duty over Friday bus duty this term." That is generally safe — teachers know their own prep periods. It runs into trouble when:

- The collective bargaining agreement specifies that extra-duty assignments are "available to staff on a district seniority basis" [27], and the most-senior teacher has the first refusal, not the first-come-first-served winner.
- A duty is genuinely mandatory ("all first-year teachers take Tuesday detention") and is not a preference.
- The "undesirable" duty is being routed to new teachers as a tradition, even when no contract clause says so, and a software-driven fairness algorithm would surface that pattern as inequity and invite a grievance.

The workable pattern is therefore **constrained preference with seniority override**: let teachers declare rank-ordered preferences within a window; resolve ties by contractually-defined priority (department seniority, years-in-building, role); let admin override any final assignment. The bidding subsystem has to be auditable — every assignment must come with a one-line "why this teacher."

## 6. Fairness algorithms: what the literature offers

The personnel-scheduling literature is older than the web and mostly targeted at nurses. The basics carry over:

- **Round-robin** — strict rotation, simplest to explain, ignores preferences and qualifications. Tends to assign the same duty to whichever teacher happens to be next in the cycle when the constraint set changes.
- **Max-min fairness** — minimize the maximum burden across all staff; preserves preferences by picking the most-preferred feasible assignment that does not increase the max [22].
- **Least-recently-assigned** — penalize assignments based on time-since-last; smoothed with a recency-decay function (so a teacher who had Friday-bus-duty 6 months ago is "owed" more than one who had it 11 months ago).
- **Weighted load balancing** — every duty slot has a "weight" (Friday bus duty weight = 2, Tuesday lunch = 1, club advisor = 4); maximize the spread of each teacher's weighted load around a target.
- **Hybrid round-robin + GA / ILP** — practical mixed-integer-programming and evolutionary-algorithm approaches that have shipped at hospitals for decades and are the gold standard [25][26].

For K–12 specifically, the right algorithm is a small set of human-readable heuristics layered on top of a clean assignment ledger:

1. A **no-constraint violations** pass — every assignment must satisfy prep-period, contract-hour, and seniority rules.
2. A **fairness** pass — among feasible assignments, pick the one that minimizes the variance of weighted-burden across staff.
3. A **preference** pass — break remaining ties by declared preference, then by inverse-recent-assignment, then by seniority as a last resort.

The output must be explainable in plain English, because the principal will be asked "why did Mr. Smith get this?" and the answer needs to be human-readable. "Because he hasn't had it since September and it scored lowest on the fairness variance after we honored his preference" is a defensible answer.

## 7. Resource scheduling: AV cart, laptop cart, gym

The same single-resource, multi-consumer problem shows up at a smaller scale and different unit: AV cart, laptop cart, gym, library, makerspace, school vans. Schools solve this with:

- **Color-coded Google Calendar resource calendars** — one resource per calendar, color-coded per consumer group, no automatic conflict detection beyond Calendar's own double-booking warning [14].
- **Dedicated tools like Schedulet** — explicitly built for school computer labs, laptop carts, and media centers; the marketing copy is "the simplest way for teachers to reserve computer labs, laptop carts, presentation centers, the media center" [13].
- **Teamup / shared-calendar tools** — multi-user shared calendars with role-based booking for AV/media teams [14].

The pain is the same: a teacher shows up to classroom 204 to find the cart is gone because another teacher booked it first and didn't tell anyone. The fix is also the same: a single shared calendar where the booking is the single source of truth, with reminders the day-of and a check-in / check-out step.

## 8. Conflict detection: the real and common constraints

Across the categories above, the same seven hard and soft constraints recur:

1. **Single-assignment per time-window** — a teacher cannot be on cafeteria duty and in a PD session at the same time.
2. **Prep-period protection** — many contracts require that teachers not be assigned any non-instructional duty during their prep period.
3. **No consecutive onerous duties** — no double-booking the same teacher at the back-to-back end of the day + the opening of the next.
4. **Rotation interval** — "no teacher has the same duty two weeks in a row" is a common contractual soft rule.
5. **Role qualifications** — the librarian can proctor the library test; the PE teacher can supervise athletic events; the school nurse is required for medication administration.
6. **Contract-hour ceilings** — and many states cap total non-instructional minutes per week.
7. **Seniority first-choice** — at certain extra-duty pay slots, the most-senior teacher gets first refusal [23][24][27].

These are real, frequent, and rarely all enforced by the same tool. Conflict detection is not a feature; it is the product.

## 9. Top 5 actionable opportunities for EduSupervise

These are ranked by how cleanly they ride the existing duty-scheduler primitive.

### Opportunity 1 — PD / meeting rotation module (fleshed out)

**The opportunity:** Repurpose the duty scheduler to generate PD-day rotations — assigning teachers to parallel PD sessions (Literacy K–2, Math 6–8, SEL Practices, etc.) across multiple time slots in an in-service day, with the same conflict-detection and rotation-fairness engines as the duty roster.

**Why now:** Districts already run in-service days through a Google Sheet, an email thread, and a paper backup. None of them detect that the reading specialist is double-booked in two PD sessions because two different coordinators edited two different tabs. Existing conference / event tools (Sched, Scheduly) treat PD as a public-facing event registration [2]; they don't model "this teacher is unavailable because they're assigned to the new-hire orientation track."

**What it would do:**
- **Schedule PD sessions as "duties."** Each session becomes a duty slot with a teacher-count requirement (e.g., 20 teachers per session), prerequisite qualifications (some require ELA endorsement), and a time window.
- **Accept teacher preferences.** Teachers pick a top-3 in priority order; the system allocates using the same max-min fairness engine as duty rostering, honoring seniority constraints on pay-bearing PD slots.
- **Detect cross-module conflicts.** A teacher already on cafeteria duty during period 3 cannot be simultaneously in a PD session that runs period 3. The duty module and the PD module share the same calendar.
- **Run "swap" workflow.** A teacher can request to swap their PD session with another teacher; admin approves; both teachers and the PD coordinator get the same notification trail as a duty swap.
- **Generate PD credit hours.** On completion, the session writes back into the teacher's professional-development log, satisfying the "track 20+ PD hours annually" requirement in many state certification regimes [3].

**Why it fits the existing primitive:** The PD module is structurally the same problem as duty rostering — assign N people to M slots across K time windows, with constraints and preferences, with a fairness tiebreak. The only new surface is PD-credit accounting and the optional "session attendance check-in" step.

**Revenue shape:** Districts will pay for this. PD scheduling today is run by the curriculum coordinator on their own time. A tool that owns the scheduling, the preference collection, and the credit-hour ledger is a clean wedge into a different budget line (curriculum / PD, not facilities / operations).

**Edge cases to plan for:** Parallel tracks that aren't equal size (don't force 20-per-session); sessions that recur across multiple in-service days (need a stable assignment for the year); mandatory vs elective sessions; makeup-credit when a teacher misses.

### Opportunity 2 — Sub coverage of special roles

Librarians, counselors, nurses, and special-ed coordinators can't be subbed by a generic sub. The current workaround — pulling a building sub into the library and thereby triggering a teacher-into-classroom cascade [11][12] — is universally hated. Ship a "special-role sub" module that surfaces qualified substitutes (retired librarians on the day-to-day roster, district-level floats, neighboring-school volunteers) and books them with the same shift-bidding primitive as duty rotation. The teacher in the classroom stops being the integration layer.

### Opportunity 3 — Resource booking (AV / laptop / gym / van)

A lightweight scheduling tier for the AV cart, laptop cart, gym, library, and school vehicles. Same primitive — person + resource + time window + conflict check — but the conflict graph is per-resource, not per-person. Schedulet is the only purpose-built competitor and serves the same niche small-market schools we already have [13]. Tie it into the existing notification engine ("Day-of reminder: 2nd-period classroom 204 has the AV cart").

### Opportunity 4 — Conference-night staffing

Parent-teacher conferences have a closed-form staffing problem: every teacher holds the same number of slots, every parent books one slot per teacher, and the office needs to see sign-ups live. Calendly, PickUp Patrol, ParentInterview, and PTCFast are the existing tools [8][9][18]; none of them speak duty scheduling. A "conference-night" add-on that imports the staff list and produces a clean multi-channel booking page, then books the teachers' pre- and post-conference prep duties in the same ledger, is a 2-week feature that earns goodwill.

### Opportunity 5 — Fairness ledger + report card

A separate but lightweight addition: surface a per-teacher fairness report at semester end. "Mr. Smith — 3 lunch duties, 1 Friday bus duty, 4 club advisors, weighted burden 14. School average 11. School max 18 (Ms. Patel)." The data is already in the duty scheduler; the report card is a single screen. This converts the duty scheduler from "the thing the office runs" into "the tool teachers trust," because the only thing teachers resent more than a bad duty assignment is a duty assignment they can't audit.

---

## Sources

[1] Apple Education Community, "Faculty Meeting Transformation," https://education.apple.com/story/250012789 (accessed 2026-06-28).

[2] Sched, "How Event Management Software Simplifies School PD Events," https://sched.com/blog/how-event-management-software-simplifies-professional-development-events-for-schools/ (accessed 2026-06-28).

[3] New Jersey Department of Education, optional Teacher PDP Template (cited via Docin mirror), https://www.docin.com/p-1725674941.html (accessed 2026-06-28).

[4] Baltimore County Public Schools, "BCPS Volunteers," https://www.bcps.org/cos/communications/face/b_c_p_s_volunteers (accessed 2026-06-28).

[5] Arlington Public Schools, "Volunteers & Chaperones," https://www.apsva.us/volunteers-partnerships/volunteer-in-a-school/ (accessed 2026-06-28).

[6] Chief Delphi forum thread, "Job Description for a Club Advisor," https://www.chiefdelphi.com/t/job-description-for-a-club-advisor/122550 (accessed 2026-06-28).

[7] r/Teachers, "What do you all think of extracurricular activities that teachers sponsor?" https://www.reddit.com/r/Teachers/comments/oliu1d/what_do_you_all_think_of_extracurricular/ (accessed 2026-06-28).

[8] classwork.com, "5 Good Tools for Scheduling Follow-up Meetings After Parent-Teacher Conferences," https://classwork.com/5-good-tools-for-scheduling-follow-up/ (accessed 2026-06-28).

[9] parentinterview.com (Online Parent-Teacher Interview Scheduler), http://parentinterview.com/ (accessed 2026-06-28).

[10] PowerSchool, "Schoolnet: Scheduling Tests Quick Reference Card," https://support.powerschool.com/repository/schoolnet/isee/pdf/sn_qrc_assess_scheduling.pdf (accessed 2026-06-28).

[11] Teacher Librarian forum, "Pulling Library Staff to Sub for Other Teachers," https://www.teacherlibrarian.org/forum/topics/pulling-library-staff-to-sub-for-other-teachers (accessed 2026-06-28).

[12] r/NYCTeachers, "Sub teachers can be classified as librarians," https://www.reddit.com/r/NYCTeachers/comments/1fnspak/sub_teachers_can_be_classified_as_librarians/ (accessed 2026-06-28).

[13] Schedulet — Computer Lab and Resource Schedule for Schools, https://schedulet.com/ (accessed 2026-06-28).

[14] Teamup, "Guide: Manage Shared Computer Carts, Equipment, and Lab Space," https://calendar.teamup.com/kb/how-to-manage-shared-computer-carts-equipment-and-lab-space/ (accessed 2026-06-28).

[15] Apple Education Community, discussion thread on professional learning, https://education.apple.com/discussion/250014874 (accessed 2026-06-28). Also: ommka.com Kids Pick Up App school dismissal flow, http://www.ommka.com/ (accessed 2026-06-28).

[16] SignUpGenius, "Manage School Sign Ups & Events Online," https://www.signupgenius.com/how-to-use/schools (accessed 2026-06-28).

[17] SignUp.com, "Compare SignUp vs SignUp Genius," https://signup.com/signup-vs-signup-genius (accessed 2026-06-28).

[18] PickUp Patrol, https://www.pickuppatrol.net/ (accessed 2026-06-28).

[19] Veracross Community, "Cover Management Overview," https://community.veracross.com/s/article/Cover-Management-Overview (accessed 2026-06-28).

[20] aSc Timetables — substitution module description (Chinese mirror), http://www.xitongzhijia.net/soft/54920.html (accessed 2026-06-28).

[21] Shyft, "Preventing Double Booking: Proven Scheduling Strategies," https://www.myshyft.com/blog/preventing-double-booking/ (accessed 2026-06-28).

[22] Shyft, "Fair Shift Bidding Algorithms: Optimize Preference Management," https://www.myshyft.com/blog/fair-distribution-algorithms-2/ (cited via search snippet; live URL returned 403 at fetch time, 2026-06-28).

[23] National Council on Teacher Quality, Toledo Teachers Federation contract 2013–2016, https://teacherquality.nctq.org/dmsView/ToledoTFTcontract20132016 (accessed 2026-06-28).

[24] Allen Park Education Association contract, https://www.mackinac.org/archives/epi/contracts/82/82020_2013-08-31_APEA_E.pdf (accessed 2026-06-28).

[25] Rashwan, W. (TU Dublin), "An Integrated Framework for Staffing and Shift Scheduling in Hospitals," https://arrow.tudublin.ie/context/busdoc/article/1032/viewcontent/Wael_Rashwan_PhD.pdf (accessed 2026-06-28).

[26] ResearchGate, "Intelligent System Based on Round Robin and Genetic Algorithm for Managing Nurse Schedules in Health Centres in Peru," https://www.researchgate.net/publication/385842995_Intelligent_System_Based_on_Round_Robin_and_Genetic_Algorithm_for_Managing_Nurse_Schedules_in_Health_Centres_in_Peru (accessed 2026-06-28).

[27] Central Unified Teachers Association contract 2021–2024, https://resources.finalsite.net/images/v1750688814/centralunifiedorg/nlcwiskatkqucnenczdg/e52ea10d-a1fc-45b7-a2ab-b5e6ec7549f5.pdf (accessed 2026-06-28).
