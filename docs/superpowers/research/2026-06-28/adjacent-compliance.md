# Compliance + Training Tracking for K-12 School Staff — Research Slice

A scan of the day-to-day world of required staff credentials, mandated
trainings, and PD hour counts that American public schools have to track
against state and district rules. Built for the EduSupervise roadmap — the
question is what to ship, not whether the problem is real. (It is.)

## 1. The regulation landscape, state by state

Every state layers its own stack of required trainings onto the federal floor
(FERPA, Title IX, OSHA bloodborne pathogens). California piles on the most —
CPR for every credentialed teacher, mandated reporter on hire and updated
periodically, plus a one-time child-care provider reporter training that
references AB 1207 [1][2]. New York mandates "two hours of training from a
NYSED-approved provider within 30 days of employment" for all teachers,
administrators, and bus drivers on child abuse identification — and just
passed an amendment under N.Y. Soc. Serv. Law § 413(5) that requires an
updated training curriculum by November 17, 2026 [3][4]. Pennsylvania ties
professional development to licensure renewal under Act 48 (180 contact hours
or six collegiate credits per five-year cycle), with PDE's PERMS system
acting as the official ledger [5]. Florida layers on a suicid​e-prevention
requirement (two hours of youth-suicide awareness training every three years
for instructional personnel) and requires 120 in-service points for
recertification, with carve-outs for reading/literacy endorsements and
education-leader PD [6][7]. Texas routes bloodborne-pathogen compliance
through the Department of State Health Services, requiring exposure-control
plans plus annual training for any staff member with reasonably anticipated
contact [8].

The map of requirement type × cadence is wide and noisy:

- **CPR / First Aid**: 2-year renewal cycles common (American Heart
  Association, Red Cross, HSI). CA requires it for all credentialed teachers
  [9]. Texas does not currently mandate it for all teachers [10]. Some
  states (Louisiana) require student-facing CPR instruction but not staff
  certs [11].
- **Mandated reporter (child abuse)**: All 50 states require it; cadence
  varies from once-on-hire to annual. NY, CA, and PA have all updated
  curricula recently (NY 2024–2026, PA Act 126, CA AB 1207).
- **Bloodborne pathogens (BBP)**: Anchored to OSHA 29 CFR 1910.1030.
  Annual retraining is standard for staff designated as having "reasonably
  anticipated" exposure — custodians, nurses, PE teachers, special-ed staff
  handling student body fluids [12].
- **Suicide prevention**: 22 states plus DC currently mandate training for
  school personnel; another 17 mandate training but do not require annual
  cadence. Only a subset require the recert every year [13][14].
- **Anti-bullying prevention**: CT requires annual training for all school
  employees (not just certified staff) under Public Act 11-232; Boston
  Public Schools mandates it for all staff including lunch monitors and bus
  drivers [15][16].
- **Human trafficking**: Florida has led the country in mandating child
  trafficking-prevention education (K-12 student curriculum) and SB 444
  (2025) extends training to school personnel [17][18].
- **FERPA**: Federal requirement. Many districts require an annual
  refresher for any staff with record access [19].
- **Title IX**: Annual training required of all employees per the 2020
  federal Title IX rule; some states (e.g., CA) layer on
  sexual-harassment-prevention training under Cal. Gov. Code § 12950.1.
- **State teaching-cert renewal**: Most states are on a 5-year PD cycle
  (IL, FL, PA, MI); CA uses a 5-year preliminary credential with
  renewal supported up to one year before expiry [20][21].
- **District-mandated PD hours**: Typically 20–30 hours per year on top of
  state-required training. Districts with collective bargaining agreements
  often hard-code this in the contract.

Bottom line: a single teacher in any mid-sized district is juggling 6–12
distinct credentials, each with its own cadence, issuer, and expiry.
That information lives nowhere clean.

## 2. What the current workflow looks like

The current workflow is a spreadsheet that someone in HR "owns." A
Blackbaud user-community thread titled "Faculty Records: Teaching
Certification Tracking" puts it bluntly: *"Our school tracks teaching
certifications yearly. Currently this is managed in an external
spreadsheet"* [22]. A teacher PD-tracking how-to article from 2gnoMe
warns that *"without a reliable system to track these hours, teachers risk
letting their certifications lapse, and your school could face
compliance issues"* [23]. A state-by-state vendor guide (Kalpa Solutions)
puts the same observation more bluntly: districts are running
five-to-ten different trackers for five-to-ten different mandates because
no platform unifies them [24].

The de facto stack today looks like:

1. **HR spreadsheet** (often a single Excel/Google Sheet, sometimes a
   SharePoint list) for credential inventory and expiry tracking.
2. **Vendor portals** for the mandatory training itself — Vector
   Solutions / SafeSchools, PublicSchoolWORKS, Frontline Professional
   Growth, Tyler Edulink Comply (PA), Mandated Reporter CA/NY state sites,
   etc. — each issuing its own completion certificate and storing its own
   data [25][26][27].
3. **Email or paper certificates** for CPR / First Aid / BBP that come
   outside any system. HR scans them and attaches them to the employee
   record.
4. **District SIS (Skyward, PowerSchool, Infinite Campus)** for personnel
   info but not training details.
5. **SharePoint / shared drive / binder** for audit-prep documentation,
   often keyed to the previous auditor's request.

This is operational debt. Every renewal reminder is a manual task. Every
new-hire checklist is a checklist that lives in someone's head.

## 3. Top pain points

**"Whose CPR cert is expiring next month?"** The most common workflow
question, and the one that gets answered wrong most often. The HR
spreadsheet has the answer but it lives in row 47, column F, and nobody
checks it until a school nurse calls in a panic.

**"Did every teacher complete anti-bullying training this year?"** Annual
training deliveries are usually confirmed via completion-list exports
from a vendor portal (SafeSchools, Vector, etc.), dumped to a CSV,
re-keyed into a tracker. The Bucks County, PA investigation into the
Davis Law loophole explicitly found that *"no state agency verifies"*
required training completion [28]. Schools get a passing grade because
they made the training available, not because every staff member actually
finished it.

**Audit prep (state or district wants proof).** When the auditor asks
"show me every teacher who was current on mandated reporter on date X,"
the honest answer today is usually "give me a week." The data lives in
three systems, none of which can answer the time-travel question. The
Connecticut Association of Boards of Education publishes a "Mandatory
Trainings for Public School Personnel in Connecticut" cheat-sheet because
the underlying system-of-record simply doesn't exist in usable form [29].

**New-hire onboarding checklist.** 30–60 day checklists that mix
federal/state/district requirements are typically a printed PDF stapled
to the new hire's orientation folder. Completion is signed off by hand,
filed in the employee's HR folder, and never looked at again until the
audit. Frontline's own "buyers guide" chapter on compliance explicitly
calls out the manual onboarding checklist as the costliest single
workflow gap [30].

**Reminder fatigue.** Vendors (SafeSchools, Vector, PublicSchoolWORKS)
default to "send a reminder to everyone once a month about everything"
because personalization is hard. Once that becomes background noise,
every alert is ignored — and the alert that matters (Mr. Smith's CPR
expires in 7 days) gets the same treatment as the one that doesn't.

**Substitute coverage gaps.** When a long-term sub covers Mr. Smith and
the original teacher goes on leave, who is responsible for tracking CPR
expiry on the sub? Today: nobody. The compliance tracking question
collapses the moment a substitute enters the picture, and most districts
have no clean way to flag it.

## 4. Software landscape

The market is consolidating fast. Three acquisitions in the last three
years have reshaped the field:

- **Vector Solutions** acquired **TeachPoint** (educator evaluation + PD)
  and **SafeSchools** (K-12 staff compliance training). They now sell the
  bundle that touches almost every box on the state-by-state list [31][32].
- **Raptor Technologies** acquired **PublicSchoolWORKS** in 2024 (paid
  training + compliance management); Raptor sits in 60%+ of US K-12
  districts via its visitor-management product, so this acquisition puts
  compliance training at the front door of most school front offices
  [33][34].

Other notable vendors:

- **Frontline Education** — the dominant operations platform in K-12,
  with **Frontline Professional Growth** for PD tracking, **Frontline
  Absence Management** (formerly Aesop) for substitute coverage, and **HRMS**
  for credential/records management [35][36].
- **PowerSchool Employee Records + Talent** — the SIS vendor extending
  into HR, with a 1EdTech-certified employee records module [37][38].
- **SchoolDude** (now part of Brightly) — facilities/maintenance +
  compliance (SafeSchools roots).
- **KickUp** — focused specifically on PD outcomes and engagement, used
  by mid-to-large districts [39].
- **Tyler Edulink Comply** — PA-specific Act 48 / clearance / training
  tracker, deeply integrated with PDE PERMS [40].
- **Tyler SIS / Skyward / Infinite Campus** — credential storage within
  SIS, mostly passive record-keeping.
- **Learning Stream** — PD management (CEUs tracking) [41].
- **Kalpa Solutions** — emerging PD compliance platform [24].
- **PD Able** — free tier for small districts [42].

Market pattern: no one owns the **cross-vendor credential record of
truth**. Vector+TeachPoint+SafeSchools covers compliance training but
does not pull in the CPR card that a teacher got from the local YMCA.
Frontline has the SIS-style employee file but the training data inside
is mostly PD-led. PowerSchool has the personnel record but the
credential expiry logic is shallow.

## 5. The credential data model

A clean model looks like the W3C Verifiable Credentials and 1EdTech CLR
(Comprehensive Learner Record) patterns — but for staff, not students
[43][44]:

```
Teacher
  └── Credential (1..N)
        ├── type             ("CPR/AED", "Mandated Reporter (NY)", "BBP",
        │                     "Act 48 PD Hours", "Suicide Prevention (FL)")
        ├── state_code       (NULL = federal/district-wide)
        ├── issuer           (American Heart Association, NYSED, district)
        ├── credential_id    (the vendor's reference)
        ├── issue_date
        ├── expiry_date      (or NULL = no expiry)
        ├── renewal_cycle    (months, derived or explicit)
        ├── certificate_url  (PDF or JSON-LD)
        ├── document_blob    (S3 reference if PDF uploaded)
        ├── status           (current | expired | pending_renewal |
        │                     suspended | exempt_with_reason)
        ├── last_verified_at
        └── audit_log (1..N)
              ├── event        (issued | verified | renewed | expired | waived)
              ├── actor        (system | teacher | admin_user_id)
              └── timestamp
Teacher
  └── PDHourLedger (1..N)
        ├── category   (Act 48 / in-service / reading / leadership)
        ├── hours
        ├── source     (course_id, conference, self-reported)
        ├── approval   (auto | approved_by_user_id)
        └── date
```

The tricky bits: expiry is conditional on both date and context
(annual-from-hire vs annual-from-state-fiscal-year), some credentials
have no expiry but require touch-ups (annual BBP), and role-specific
exemptions need to be expressible without breaking reporting
("Mr. Smith does not work with students, so CPR not required").

## 6. The near-expiry notification pattern

The industry-standard cadence — borrowed from TLS certificate management
and adopted in Salesforce and DigiCert — is **90 / 60 / 30 / 7 / 0 / -7
days** [45][46]. For teacher credentials, that translates to:

- **T-60 days**: Email to the teacher + their direct supervisor (dept
  chair, principal). Not urgent, just a heads-up.
- **T-30 days**: Email + in-app banner. Add the HR/compliance officer.
- **T-14 days** (where it matters more, e.g., CPR): SMS to the teacher
  + email to the principal's admin assistant.
- **T-7 days**: Email + SMS + in-app badge. The "this is now urgent"
  escalation.
- **T-0 (expired)**: Auto-flag on the staff member's HR record;
  critically (CPR, mandated reporter) the system should be able to
  block the teacher from being scheduled into a duty that requires
  the credential (e.g., recess supervision with a student who has an
  EpiPen allergy).
- **T+7 (grace) for soft-only categories** (BBP, FERPA refresher):
  marketing-level nudge; doesn't block duty assignment.

Channels matter. SMS gets >90% read rates inside 5 minutes vs. email
opens of ~25%. But SMS at school-district scale costs real money
(Twilio rates plus carrier fees). The right default is email-first
escalation with SMS in the last 7 days.

## 7. The audit-trail story

When the state DOE asks *"show me every teacher who was current on
mandated reporter training on October 1, 2024,"* the answer today is
usually a spreadsheet that got re-saved over and lost its history. The
honest "good" answer is:

1. A time-versioned credential store (event sourcing) that lets you
   query state as of any past date.
2. A signed audit-trail log of every status change, with actor, source
   vendor, and attestation.
3. A self-service report builder that lets compliance officers answer
   standard questions in <5 minutes without engineering help.
4. A "document warehouse" where the original PDF/JSON-LD
   certificate is preserved against the credential record, with
   integrity hash.

The Philadelphia Inquirer's reporting on PA's mandated-reporter
verification gap is a cautionary tale for what happens when this
story is missing [28].

## 8. Do duty-scheduling tools do compliance?

In general, no. Frontline's *absence management* system (Aesop) does not
track credential expiry on substitutes; it tracks sub eligibility based
on district-defined criteria (often just "active in sub pool"). EduSupervise
itself has no credential awareness today. This is a clean greenfield
opportunity for a school-ops platform that already has the staff
directory and the duty map.

The closest existing overlap is Frontline's bundle (Aesop + Professional
Growth + HRMS), and even there the credential expiry logic is a thin
wrapper around PD course completion, not a general-purpose credential
engine. **Vector Solutions + PowerSchool + Frontline** together cover
~70% of large-district procurement but no single platform owns the
cross-vendor record of truth.

---

## Top 5 actionable opportunities for EduSupervise

### Opportunity 1 — Credentials module (the core ask)

Ship a **Credentials module** native to EduSupervise. Per staff member,
support any number of credentials with state, type, issuer, issue date,
expiry date, document upload (PDF), and renewal cycle. Build the
**90/60/30/14/7/0/-7 email+SMS escalation ladder** out of the box.
Webhook ingest from SafeSchools, Vector, Frontline Professional Growth,
Mandated Reporter (CA/NY) so a teacher's completion in the vendor
portal auto-updates the EduSupervise record. **Generate an audit-grade
report** ("every teacher current on Mandated Reporter § 413(5) on
date X") in one click — the deliverable for compliance officers and
auditors. **Pricing wedge**: a single mid-sized district (50–200
teachers) currently spends $3–$8/teacher/year on a thin credential
tracker, $6–$15/teacher on training-content seats, and ~10 hrs/week of
HR admin time. A bundled credentials module for $4–$6/teacher/year
pays for itself in the first month and pulls EduSupervise into the HR
budget conversation.

### Opportunity 2 — Compliance-gated duty assignment

Extend the duty scheduler so any duty slot can declare **required
credentials** (e.g., recess slot with a diabetic student in section 3
requires "Diabetes awareness training current within 12 months").
If a teacher assigned to that slot is missing or expired on the
credential, **the schedule refuses to publish** until a substitute is
found who meets it. This is a single-feature wedge that no one else
has, because no one else has the staff directory, the duty map, AND
the credential store in one place.

### Opportunity 3 — Onboarding checklist generator

For a new hire, generate a **state-aware, role-aware onboarding
checklist** ("First-grade teacher in NY: Mandated Reporter within 30
days, DASA within 10 days, CPR within 90 days; district policy:
Anti-bullying prevention within 30 days"). The state templates are
publicly available (CT CABE, WI DPI, PA PDE PERMS) and only need to be
captured once. Once captured, the checklist auto-assigns itself, tracks
completion, and feeds into the Credentials module's audit log. This
turns EduSupervise into the system-of-record for HR onboarding in
addition to duty.

### Opportunity 4 — Substitute credential portability

Allow a substitute teacher to **carry their credential portfolio**
across districts via a public verification URL (think the W3C VC /
1EdTech CLR pattern). If a sub is credentialed in District A and
accepts a job in District B, District B's compliance officer can
fetch the verified credential and import it. This makes
EduSupervise the **trust layer** for the substitute-teacher
ecosystem — a huge network-effect play for a small SaaS.

### Opportunity 5 — Parent-visible "Who's supervising my kid today?"

Spin a **parent-facing module** out of the duty schedule + compliance
data. A parent can see: (a) who is supervising their child's bus,
recess, dismissal, (b) that the person is currently CPR-certified
(if applicable), (c) who the sub is if the regular person is out.
This is a downstream play from the Credentials module but it captures
the **classroom-to-caregiver trust narrative** that schools currently
fail at, and gives EduSupervise a per-parent revenue path
(premium-family-tier) that doesn't depend on district renewals alone.

---

## Sources

[1] Mandated Reporter Training for School Personnel — California Department of Social Services / Department of Education partnership site. http://educators.mandatedreporterca.com/

[2] Child Care Providers Mandated Reporter Training (AB 1207), California DSS. http://childcaretest.mandatedreporterca.com/

[3] "Child Abuse in an Educational Setting Training Requirements," New York State Education Department. https://www.nysed.gov/student-support-services/child-abuse-educational-setting-training-requirements

[4] "Mandated Reporter Training," NY OCFS (N.Y. Soc. Serv. Law § 413(5)). https://ocfs.ny.gov/programs/cps/mandated-reporter-training.php

[5] "Act 48 and PERMS," Pennsylvania Department of Education. https://www.pa.gov/agencies/education/programs-and-services/educators/continuing-education-and-professional-development/act-48-and-perms

[6] "Suicide Prevention," Florida Department of Education. https://www.fldoe.org/schools/k-12-public-schools/sss/suicide-prevent.stml

[7] "Florida Educator Certification Renewal Requirements," FL DOE. https://www.fldoe.org/teaching/certification/renewal-requirements/

[8] "Bloodborne Pathogen Control in Texas Schools," Texas DSHS. https://www.dshs.texas.gov/texas-school-health/skilled-procedures-texas-school-health/bloodborne-pathogen-control-texas

[9] "CPR Certification for Teachers in California," Coast2Coast First Aid. https://www.c2cfirstaidaquatics.com/us/cpr-certification-for-teachers-in-california/

[10] "Should school staff be paid for mandatory training…," Teachers Discussion (Facebook). https://www.facebook.com/groups/1376663339773678/posts/1958917484881591/

[11] "CPR Training Requirement for Louisiana High Schools," SchoolCPR. https://schoolcpr.com/requirements/louisiana/

[12] "Bloodborne Pathogen Training Requirements: FAQ," Maine School District. https://resources.finalsite.net/images/v1723243921/mesdk12orus/xljhvoeupmkzd8j14sde/BloodbornePathogensTrainingRequirements_FAQ.pdf

[13] "Suicide Prevention Training in Schools: Which States Require It?" Navigate360. https://navigate360.com/blog/which-states-require-suicide-prevention-training-in-schools/

[14] "Secondary Teachers' Perceptions of their Role in Suicide Prevention and Intervention," School Mental Health (Springer). https://link.springer.com/article/10.1007/s12310-015-9173-9

[15] "Mandatory Trainings for Public School Personnel in Connecticut," Connecticut Association of Boards of Education. https://www.cabe.org/uploaded/Webinar_Presentations_Handouts/DOC015.pdf

[16] "Trainings — Bullying Prevention Resources," Boston Public Schools. https://www.bostonpublicschools.org/students-families/bullying-prevention-resources/trainings

[17] "Florida First State in Nation to Teach K-12 Child Trafficking Prevention," FL DOE. https://www.fldoe.org/newsroom/latest-news/florida-first-state-in-nation-to-teach-k-12-child-trafficking-prevention.stml

[18] "Bill Analysis CS/SB 444," Florida Senate (2025). https://www.flsenate.gov/Session/Bill/2025/444/Analyses/2025s00444.aed.PDF

[19] "FERPA Compliance: Requirements, Violations, and Checklist," Vector Solutions. https://www.vectorsolutions.com/resources/blogs/ferpa-compliance-higher-education/

[20] "Multiple Subject Teaching Credential (CL-871)," California Commission on Teacher Credentialing. https://www.ctc.ca.gov/credentials/leaflets/cl-871/

[21] "Renew Your Document," California Commission on Teacher Credentialing. https://www.ctc.ca.gov/credentials/renew/

[22] "Faculty Records: Teaching Certification Tracking," Blackbaud Community. https://community.blackbaud.com/discussion/84873/faculty-records-teaching-certification-tracking

[23] "How to Track Teacher Professional Development Hours," 2gnoMe. https://home.2gno.me/post/track-teacher-pd-hours

[24] "5 Strategies for Professional Development Compliance," Kalpa Solutions. https://kalpasolutions.com/blog/professional-development-compliance/

[25] SafeSchools Training System (now Vector Solutions). https://www.vectorsolutions.com/about-us/acquisitions/safeschools/

[26] "K-12 Training Management Solution for School Staff — Vector LMS," Vector Solutions. https://www.vectorsolutions.com/solutions/vector-lms/k12-training-management/staff/

[27] "Staff Compliance Training," PublicSchoolWORKS (Raptor Technologies). https://corp.publicschoolworks.com/program/staff-compliance-training/

[28] "PA law includes loophole for mandated reporter training to spot abuse," Bucks County Courier Times / PhillyBurbs. https://www.phillyburbs.com/story/news/local/2025/04/28/child-abuse-reporting-mandatory-reporter-bucks-county-schools-jamison-davis-law-pa-education/77879284007/

[29] "Mandatory Trainings for Public School Personnel in Connecticut," CT CABE. https://www.cabe.org/uploaded/Webinar_Presentations_Handouts/DOC015.pdf

[30] "Chapter 4 – Compliance Builds Trust: The Hidden Cost of Manual…" Frontline Education K-12 Operations Buyers Guide. https://www.frontlineeducation.com/k12-operations-software-buyers-guide/k12-organization-compliance-mistake-costs/

[31] "SafeSchools Training – Now Vector Solutions," Vector Solutions. https://www.vectorsolutions.com/about-us/acquisitions/safeschools/

[32] "TeachPoint: A Vector Solutions Product," Vector Solutions. https://www.vectorsolutions.com/about-us/acquisitions/teachpoint/

[33] "Raptor Technologies Acquires PublicSchoolWORKS," PR Newswire / Thoma Bravo. https://www.prnewswire.com/news-releases/raptor-technologies-acquires-publicschoolworks-302153718.html

[34] "Integrated School Safety Software," Raptor Technologies. https://raptortech.com/

[35] "K12 Teacher Professional Growth and Development," Frontline Education. https://www.frontlineeducation.com/school-hcm-software/professional-growth/

[36] "Professional Learning Management — LMS for Teachers," Frontline Education. https://www.frontlineeducation.com/school-hcm-software/professional-growth/lms-for-teachers/

[37] "PowerSchool Employee Records," 1EdTech. https://site.imsglobal.org/certifications/powerschool-group-llc/powerschool-employee-records

[38] "Engaging onboarding and streamlined records management," PeopleAdmin (PowerSchool). https://peopleadmin.com/employee-records/

[39] KickUp. https://kickup.co/

[40] "PDE Compliance Tracking for Schools — Comply," Tyler Edulink. https://edulinksolutions.com/comply/

[41] "Professional Development Software for Learning Outcomes," Learning Stream. https://www.learningstream.com/professional-development/

[42] "PD able — Professional Development Software Made Easy." https://pdable.com/

[43] "REC Update Request for Verifiable Credentials Data Model v1.1," W3C. https://lists.w3.org/Archives/Public/public-transition-announce/2022Feb/0022.html

[44] "Digital Credentials," 1EdTech. https://www.1edtech.org/workstream/credentials

[45] "Certificate renewal notifications," DigiCert documentation. https://docs.digicert.com/en/certcentral/manage-account/certcentral-notifications/certificate-renewal-notifications.html

[46] "Limit Who Receives Notifications About Certificate Expiration," Salesforce Help. https://help.salesforce.com/s/articleView?id=release-notes.rn_security_pe_limit_cert_expire_emails.htm
