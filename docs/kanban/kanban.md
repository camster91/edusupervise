# EduSupervise Kanban — generated 2026-07-23T12:37:17Z

**Last audit:** 2026-07-22 (full-codebase review + rebase-in-progress follow-up)

**Conventions:**
- severity: 🔴 critical · 🟠 high · 🟡 medium · 🟢 low
- category: 🔀 rebase · 🚢 ship · ⚙️ ops · 🛡️ security · ✨ code-quality · 🧪 test · 🔧 devops
- agent: `parent` = me + Cam in this chat · `subagent` = dispatchable · `human-needed` = your call
- **state.json is the source of truth** — kanban.md is regenerated from it

## Counts
- Total tracked: **18**
- critical=2 · high=5 · medium=7 · low=4
- todo=5 · in-progress=2 · in-review=0 · backlog=4 · done=7 · dropped=0

## TODO (5)

- 🟢 **LOW** ⚙️ `migrate-2` — Update deploy/install.sh owner_password comment block to reference postgres_password.txt (already done? verify)
    agent: `parent`
- 🟠 **HIGH** ⚙️ `verify-prod-1` — Smoke prod: login flow, schedule reminder end-to-end, push subscribe, CSRF rejected cross-origin
    agent: `human-needed` · needs: migrate-1
- 🟡 **MEDIUM** ⚙️ `verify-prod-2` — Verify Traefik headers on prod: curl -I https://edusupervise.ashbi.ca — expect HSTS, X-Frame-Options, Permissions-Policy
    agent: `human-needed` · needs: migrate-1
- 🟡 **MEDIUM** ⚙️ `verify-prod-3` — Trigger a backup, then check mode: stat -c %a /data/backups/*.dump → 600
    agent: `human-needed` · needs: migrate-1
- 🟢 **LOW** ✨ `deferred-1` — P2-13: move __testing__ exports off the public surface in @edusupervise/{billing-adapter,email,sms}
    agent: `subagent`
    _breaking API for sibling tests — needs human sign-off_

## IN-PROGRESS (2)

- 🔴 **CRITICAL** 🚢 `ship-1` — Run all gates: typecheck / test / lint / build / audit / git diff --check
    agent: `parent` · needs: rebase-1, rebase-2, rebase-3, rebase-4, rebase-5
- 🟠 **HIGH** ⚙️ `migrate-1` — Apply migration 0017_audit_log_immutable on production Postgres (enables RLS + trigger)
    agent: `human-needed` · needs: ship-3

## BACKLOG (4)

- 🟡 **MEDIUM** 🛡️ `deferred-2` — P2-1: full XSS escalation fix (CSP nonce + Sec-Fetch-Site tightening for ALL routes, not just mutating ones)
    agent: `subagent`
    _current fix closes the push-token-hijack chain; CSP refactor is a separate sprint_
- 🟡 **MEDIUM** 🧪 `deferred-3` — Mobile push integration test against real Expo Push sandbox (slice-C D5)
    agent: `subagent`
    _current Vitest covers the helper shape only; real Expo round-trip needs EXPO_TOKEN_
- 🟢 **LOW** 🔧 `deferred-4` — Fresh-DB bootstrap CI parity test (run db/init/* + migrations/* against empty Postgres volume, compare constraints/types)
    agent: `subagent`
- 🟢 **LOW** ⚙️ `deferred-5` — Merge origin/main — close the 0-commit drift before any subsequent audit batch
    agent: `human-needed`

## DONE (7)

- 🟠 **HIGH** 🔀 `rebase-1` — Resolve calendar-import.server.ts rebase conflict (3 blocks)
    agent: `parent` · blocks: verify, commit, push, deploy
- 🟠 **HIGH** 🔀 `rebase-2` — Resolve _journal.json rebase conflict (main added 0015_push_subscriptions_apns, we added 0015_mobile_push_subscriptions + 0016 + 0017)
    agent: `parent` · blocks: verify, commit, push, deploy
- 🟡 **MEDIUM** 🔀 `rebase-3` — git diff --check + run pnpm install --frozen-lockfile (regen lock if needed)
    agent: `parent` · blocks: verify
- 🟡 **MEDIUM** 🔀 `rebase-4` — Verify pnpm install regenerates pnpm-lock.yaml against merged package.json (root + apps/web + anything else affected)
    agent: `parent` · blocks: verify
- 🟡 **MEDIUM** 🔀 `rebase-5` — Resolve apps/web/app/routes/api.admin.calendar.commit.ts has Unmerged status even though markers are gone — likely needs git add
    agent: `parent` · blocks: verify
- 🔴 **CRITICAL** 🚢 `ship-2` — Local commit on audit/edusupervise-review-fixes (no push until explicit go)
    agent: `parent` · needs: ship-1
- 🟠 **HIGH** 🚢 `ship-3` — Optional: push to origin if user says go (memory rule: external side-effects require explicit go)
    agent: `human-needed` · needs: ship-2

## Workflow

- **Update state.json first** when moving an issue between statuses.
- The Markdown view is regenerated from state.json by `docs/kanban/render.py`.
- Conflict-marker resolution = work the parent does in the chat right now.
- `subagent` rows are batchable with `delegate_task` (background).
- `human-needed` rows require an explicit decision from Cam in chat.
