# Postmortem: Calendar import BLOCKING — holiday_code CHECK constraint mismatch

**Date:** 2026-07-05
**Severity:** BLOCKING (would have caused mid-transaction 500s in production)
**Caught by:** app-ship-prep verifier (session mvs_498818874f5b439ebb78debd3277d2e1)
**Fixed by:** Migration 0014 (commit `6554a9e`)

## TL;DR

Migration 0013 added `holiday_code TEXT` to `cycle_calendar` with a CHECK
constraint allowing 8 human-readable slugs (`holiday`, `recess`, `pd_day`,
`exam`, `half_day`, `weather`, `in_service`, `break`). But the PDF
calendar parser emits 5 one-letter codes from the YRDSB template
(`B`, `E`, `ES`, `M`, `0`). The TS wrapper whitelisted only the one-letter
codes. Result: the first non-instructional row in any admin commit would
have collided with the CHECK, the upsert loop would throw, and the admin
would have seen a 500 with no audit row written.

The bug was caught via `psql \d cycle_calendar` BEFORE the feature hit
production. Total exposure: zero customer-facing 500s.

## Timeline

| Time (ET)    | Event                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| 03:02        | DB overnight agent shipped migration 0013 + 8-slug CHECK                |
| 03:42        | DB agent file shipped; integration started                             |
| ~08:30       | Tech lead committed 11 integration commits to main, declared "done"    |
| ~08:40       | Tech lead pushed to origin/main                                         |
| ~08:45       | Verifier session spun up via cron watchdog                              |
| ~08:50       | Verifier reported BLOCKING via psql CHECK inspection                    |
| ~08:55       | Tech lead wrote migration 0014 (DROP + re-ADD with parser's 5 codes)    |
| ~09:09       | Migration 0014 applied + verified live (5 codes accept, 8 reject)       |
| ~09:25       | Verifier final SHIP verdict after 3 rounds (incl. 2 MED fixes)          |

Total time-to-detect: ~5 minutes (verifier caught it within 1 psql query)
Total time-to-fix: ~35 minutes

## Root cause

Each overnight agent (PM, DevOps, DB, frontend) ships with full context
of its own work but **zero context of siblings**. When 2+ agents converge
on a shared artifact (DB schema, API contract, file format), their
assumptions about what others ship can drift silently.

In this case:
- **DB agent** shipped a CHECK with 8 slugs (their interpretation of
  "what a calendar would have").
- **DevOps agent** shipped a parser emitting 5 one-letter codes
  (the YRDSB template uses one-letter codes; the python script
  hard-codes them).
- **TS wrapper** whitelisted only the one-letter codes (matched the
  python parser).
- **Integration tech lead** (mavis root session) committed all 3
  agents' work without re-grepping the live DB to confirm the
  schema matched what the parser would emit.

## What went right

- **Cron watchdog spawned the verifier** without waiting for human input.
- **Verifier used psql directly** to inspect the live CHECK constraint,
  not just the migration file.
- **Migration 0014 is online-safe + idempotent** (DROP IF EXISTS +
  DO block) so re-running 0013 on top is a no-op. This meant the fix
  was a 2-minute apply.
- **Audit-row fix (MED-2)** made the partial-cursor reconstructable
  from audit_log alone — `calendar_import.commit_failed` rows now
  carry `attemptedDays + writtenCount + failedDate`.

## What went wrong

- **Tech lead didn't diff migration against running DB before declaring
  integration shipped.** This was the integration-checkpoint failure.
- **DB agent's final report DID flag open question #1 about the holiday
  code vocabulary** (8 starter codes vs. needing to match the parser).
  Tech lead missed it during the integration review.
- **No automated check exists** that compares migration file CHECK
  constraints against what the parser emits. The drift only surfaces
  on first data insertion.

## Prevention (drift-check recipe, now in agent memory)

When integrating deliverables from 2+ overnight agents that converge
on a shared artifact, the tech lead MUST spend 60 seconds per agent:

1. Read each agent's REPORT.md final message
   (`mavis communication messages --from <sid> --limit 5`).
2. Extract concrete claims: column names, type contracts, env var
   names, endpoint paths, file paths, vocabulary sets.
3. For DB-touching claims: `git show <migration-file>` +
   `docker exec <pg> psql -c "\d <table>"` + spot-check via INSERT.
4. For code-touching claims: grep for the symbol across the integration
   commits, confirm one source of truth.
5. For env-var claims: `docker inspect <container>` vs `.env.example`.

Cost: 60 seconds per agent. Catches drift like this BEFORE the
verifier does.

## Detection recipe for future similar bugs

```bash
# 1. Find CHECK constraints on the table
docker exec <pg> psql -U <user> -d <db> -c \
  "SELECT conname, pg_get_constraintdef(c.oid) \
   FROM pg_constraint c \
   WHERE conrelid = '<table>'::regclass AND contype = 'c'"

# 2. Find what the parser actually emits (sample recent run)
docker exec <worker> cat /tmp/recent_parse.json | jq '.days[0:5]'

# 3. Diff: every emitted value must be in the CHECK's allowed set
docker exec <pg> psql -U <user> -d <db> -c \
  "INSERT INTO <table> (...) VALUES (<sample from parser>)"
# ^ this should succeed if there's no drift
```

## Related issues fixed in the same round

- **HIGH** (commit `5779011`): commit route had no try/catch around
  upsert — partial commit + no audit row was possible. Now wrapped.
- **MED-1** (commit `bc32e48`): validateShape didn't read `o.note`
  from python dict. Future parser revisions carrying annotations
  would have been silently dropped.
- **MED-2** (commit `2912cfe`): `attemptedDays` in the commit_failed
  audit row didn't include `writtenCount`. Operators couldn't tell
  the partial cursor from audit alone. Fixed via CalendarUpsertError
  class carrying writtenCount.

## Lesson

Every multi-agent overnight prep workflow Cameron runs (edusupervise,
joesheating, ai-billing-audit, lead-gen cadences, etc.) starts with
the 60-second drift-check recipe by default. It's not optional.

Cameron verbatim after this bug:
> "when integrating across multiple overnight agents, always re-grep
> each agent REPORT.md against the live DB state before declaring
> integration shipped. Cheap 60-second habit, catches drift like this."

## References

- Agent memory entry: `~/.mavis/agents/mavis/memory/MEMORY.md`
  → "Overnight-agent integration drift check (2026-07-05)"
- Verifier session: `mvs_498818874f5b439ebb78debd3277d2e1`
- Migration 0014: `packages/db/migrations/0014_cycle_calendar_holiday_code_set.sql`
- Calendar import spec: `docs/superpowers/specs/2026-07-05-pdf-calendar-import.md`