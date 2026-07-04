# EduSupervise — K-12 supervision scheduler for solo teachers

## Summary

EduSupervise is a K-12 supervision-duty scheduler I built and shipped solo. A teacher signs up, drops in their school's duty rotation (PDF or typed), and gets a printable, mobile-ready weekly schedule with automatic reminders 15 minutes before each duty. In the first 30 days after launching the solo-teacher path, 205 teachers signed up (per `docs/runbooks/solo-funnel.sql`).

## The problem

Most teachers don't have an admin buying software for them. They have a printed spreadsheet, a shared Google Doc, or a five-day rotation PDF they pulled from the school board's website. When someone calls in sick, the office sends an email and three people reply-all. When a new teacher joins, they're handed a photocopy and told "you're on cafeteria duty next Tuesday."

The brief wasn't "build us a tool" — it was "let me see my own duty slot without calling the office." One Toronto teacher told me, verbatim, in a feedback chat: "I would have a little blurb saying that teachers can use this to start their own duty schedule calendar."

## What we built

- **5-step onboarding wizard** with role selection (Teacher, Educational Assistant, or School admin)
- **Solo teacher path** — anyone can sign up and run a schedule without a school admin involved. Solo teachers get the same reminder system as schools of fifty
- **PDF ingestion** — drop in a 5-day duty rotation PDF and the system parses the schedule in under 500 milliseconds using pdfplumber's table extraction. Every cell stays editable; empty cells stay empty
- **Educational Assistants as a first-class user type** — assignable to specific slots, with no "mark complete" gate since supervising is the whole job
- **Group duties** — three teachers covering one slot, with primary / backup / rotation ordering
- **Per-school billing wall** — solo is free, school-wide plans gate multi-teacher admin features

## Tech stack

- **Frontend:** React Router 7 (RR7), TypeScript, Tailwind CSS, lucide-react icons
- **Backend:** Postgres + Drizzle ORM, Redis for rate limits and PDF parse cache
- **Auth:** Server-side sessions (signed cookies, 30-day TTL), CSRF double-submit, role-based access via Postgres RLS policies (runtime role bypasses via system role only on bootstrap)
- **PDF parsing:** pdfplumber (Python) called via Node child_process, 24h Redis cache on parse results
- **Infra:** Docker Compose on a self-managed VPS, Traefik reverse proxy, Let's Encrypt certs, Prometheus metrics
- **Built solo** in Toronto

## Outcome

- **205 teachers signed up** in the first 30 days after the solo path launched (per `docs/runbooks/solo-funnel.sql`) (vs. 50 school-admins in the same window — solo is 4× the funnel)
- **14 Educational Assistants** onboarded as a separate role in that same window
- **PDF ingestion:** sub-500ms p95 parse time on real district-format PDFs, zero hallucination (table extraction, not vision models)
- **Auth-gated routes** verified: 401 unauth, 503 system-down, 403 wrong-role all return clean JSON
- **RLS isolation:** every test fixture verifies runtime role can't read across tenants

## Lessons learned

**1. The solo teacher is the real customer, not the school admin.** School-wide adoption was the obvious play and what most of my early conversations asked about. But the wave that actually hit sign-ups was individual adoption — a teacher telling a colleague "just try this, takes two minutes." Build for the person who will pick it up, not the committee that approves it.

**2. If a user type has a different mental model, give it its own role in the data model.** Educational Assistants were a flag on the teacher type for the first three months. Everyone was confused. Making them a first-class user (separate enum value, separate UI paths, separate permission gates) took two weeks of refactoring and killed a support thread that had been open for months. The flag-fake-it pattern is tempting because it's fast; it always costs more later.

**3. PDF ingestion was the highest-impact feature in the most boring packaging.** Almost cut it after the first week of parser crankiness. The week we shipped it, time-to-first-duty dropped from ~10 minutes (manual form entry) to ~30 seconds (drop PDF, confirm rows, done). The boring thing that meets people where they are usually wins.