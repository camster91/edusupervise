# Calendar Import — Deployment Plan

Short deploy plan for adding the calendar-import feature to
`edusupervise.ashbi.ca`. Calibrate against the Phase 2 (2026-07-04)
duty-roster parser deploy — same Python script pattern, same
`pdfplumber==0.11.4` install.

---

## TL;DR

1. **No Dockerfile change needed.** Phase 2 already installed
   `python3` + `pdfplumber==0.11.4` in the web runtime image. The
   calendar extractor uses both, so it's covered.
2. Stage uploads at `/app/uploads/<job-id>.pdf` (same tmpfs + bind
   mount as the duty parser).
3. Roll back via `git checkout HEAD~1 -- apps/web/server/pdf_calendar_extract.py`
   if calendar import breaks duty-roster import (they share
   `pdfplumber` — resource contention is the only realistic risk).

---

## 1. Dockerfile change — verification, not modification

**Status: NO CHANGE REQUIRED.**

The web container's runtime image already has the dependencies this
script needs. From `docker/Dockerfile.web`, lines 33-37 (Phase 2):

```dockerfile
RUN apk add --no-cache python3 py3-pip \
    && pip3 install --no-cache-dir --break-system-packages 'pdfplumber==0.11.4'
```

This installs both Python 3.12 and `pdfplumber==0.11.4` (with
`pdfminer.six` as a transitive dep). The calendar extractor
`import`s both — nothing else needed.

### Why we don't add anything new

- **No Pillow / OpenCV.** pdfplumber's `extract_tables()` works without
  Pillow. Adding it would pull Alpine libjpeg-dev headers we don't
  want to babysit (Phase 2 doc comment explains why).
- **No system fonts, no extra Python packages.** Same minimal
  surface as the duty parser; if it works for duty, it works for
  calendar.
- **No volume mount changes.** Same `/data/uploads:/app/uploads`
  bind mount serves both.

### Verification step (do this once before deploy)

```bash
# Confirm the image already has both deps without rebuilding.
docker compose exec web python3 -c "
import pdfplumber, sys
print('python:', sys.version.split()[0])
print('pdfplumber:', pdfplumber.__version__)
"
# expect: python: 3.12.x ; pdfplumber: 0.11.4
```

If for any reason the version has drifted (e.g. someone bumped
pdfplumber and broke the duty parser), **fix the duty parser first**
before shipping calendar import. Both scripts depend on the same
`pdfplumber` pin.

---

## 2. Temp paths and disk flow

The Python script is invoked by the Node wrapper via `execFile`. It
reads a single PDF path from `argv[1]` and emits JSON to stdout. It
does **not** write any temp files. The Node wrapper handles staging.

### Staging pattern (mirror duty parser)

```
[upload lands in /app/uploads/<uuid>.pdf via Traefik + uploads.server.ts]
        |
        v
[Node wrapper (calendar-parser.server.ts) execFile's pdf_calendar_extract.py]
        |
        +-- argv[1]: /app/uploads/<uuid>.pdf
        +-- env PDF_PARSE_TIMEOUT_MS: 8000 (or 4000 for tighter bound)
        +-- env SCHOOL_YEAR_START: optional override
        |
        v
[Python script writes JSON to stdout, reads nothing else]
        |
        v
[Node wrapper parses stdout, persists days to Postgres]
        |
        v
[cleanup: rm /app/uploads/<uuid>.pdf]
```

### tmpfs and bind mounts

From `docker/docker-compose.yml` (web service):

```yaml
tmpfs:
  - /tmp
  - /var/tmp
volumes:
  - /data/uploads:/app/uploads
```

The script doesn't write to `/tmp` or `/var/tmp` directly (it's a
pure pipe — argv in, stdout out). The Node wrapper can stage the
uploaded PDF anywhere; the convention is `/app/uploads/<job-id>.pdf`
which is the bind-mounted host path at `/data/uploads/`.

### Why we don't add a calendar-specific tmpfs

The duty parser uses the same tmpfs + uploads bind mount with no
problems. Calendar import adds no new I/O patterns — same single-file
read, same stdout pipe. Sharing the existing paths keeps the surface
small.

---

## 3. Rollback plan

Calendar import is additive — it ships a new Python file and (in
Phase 4) a new Node wrapper. Neither touches existing duty-roster
code paths. The realistic failure modes are:

### Failure mode A: Container can't start

The web container might fail to start if the Node bundle fails to
load a new import. Rollback:

```bash
cd /opt/edusupervise
git log --oneline -5 apps/web/server/  # find last good SHA
git checkout <last-good-sha> -- apps/web/server/calendar-parser.server.ts
docker compose build web
docker compose up -d web
docker compose ps  # verify Up + healthy
curl -I https://edusupervise.ashbi.ca/api/health  # expect 200
```

### Failure mode B: pdfplumber contention under load

If both duty-roster imports and calendar imports hit the same
container simultaneously, pdfplumber's pdfminer.six is single-threaded
per process (GIL-bound in CPython). Symptom: parse time spikes on
both features. Mitigations:

- **Short term**: bump `PDF_PARSE_TIMEOUT_MS` to 12000 to absorb
  contention; consider rate-limiting imports via Redis lock.
- **Medium term**: move both Python scripts to a dedicated
  `pdf-worker` container (would need its own service in compose).

### Failure mode C: Script bug, calendar import crashes

The Node wrapper should catch the script's non-zero exit and surface
a clean error to the UI. If instead the script crashes the wrapper:

```bash
# Revert just the calendar script (duty parser untouched).
cd /opt/edusupervise
git checkout HEAD~1 -- apps/web/server/pdf_calendar_extract.py
# If the Node wrapper also needs reverting:
git checkout HEAD~1 -- apps/web/server/calendar-parser.server.ts
docker compose build web
docker compose up -d web
```

The duty parser still works because it depends only on `pdfplumber`,
which we're not changing. Worst case: one feature (calendar) is broken
while the other (duty roster) keeps shipping.

### One-command full rollback

If something catastrophic happens at the deploy layer (compose
config, env, etc.):

```bash
cd /opt/edusupervise
git fetch origin main
git reset --hard origin/main    # WARNING: destructive — only if you
                                # trust the previous main tip. Cameron
                                # sign-off required.
docker compose down
docker compose up -d
docker compose ps
```

(Use the standard `git checkout` + `docker compose` pattern in
`ashbi-infra` skill — that recipe is the canonical rollback.)

---

## 4. Pre-deploy checklist

- [ ] **Snapshot taken**: `cp -a /opt/edusupervise/apps/web/server/ /root/.calendar-prep-snap-<date>/`
- [ ] **Image deps verified**: `docker compose exec web python3 -c "import pdfplumber; print(pdfplumber.__version__)"` → `0.11.4`
- [ ] **Script deployed**: `/opt/edusupervise/apps/web/server/pdf_calendar_extract.py` present
- [ ] **Fixture parsed cleanly**: `python3 pdf_calendar_extract.py docs/fixtures/2025-2026-5Day-Cycle-Calendar.pdf` → exit 0, 215 days
- [ ] **Duty parser still works**: upload a sample duty-roster PDF, confirm cycle days parse correctly (regression check)
- [ ] **Health endpoint green**: `curl -I https://edusupervise.ashbi.ca/api/health` → 200
- [ ] **Rollback command documented**: above
- [ ] **No pre-existing issues touched**: workout / jwhabits / armor / ai-billing-audit / splashtown-host-guard remain in their tracked state

## 5. Post-deploy verification

```bash
# 1. Container health.
docker compose ps
# expect: web (Up, healthy), worker (Up, healthy), cron (Up)

# 2. App health.
curl -sI https://edusupervise.ashbi.ca/api/health | head -1
# expect: HTTP/1.1 200 OK

# 3. Trigger a calendar import via the UI (test school).
#    Verify: 215 days ingested, summary matches the runbook.

# 4. Confirm duty-roster import still works.
#    Re-import a known duty roster; verify the parsed cycle days match.

# 5. Tail web logs for 60s.
docker compose logs --tail=100 -f web
# expect: no stack traces, no "pdfplumber" errors
```

## 6. Pre-existing issues to flag (do NOT auto-fix)

These are tracked in `~/.mavis/agents/mavis/memory/cameron-projects.md`
and intentionally out of scope:

- `api.workout.ashbi.ca` 502 (workout-addon.yml duplicates routes)
- `www.workout.ashbi.ca` 404
- `jwhabits.ashbi.ca` cert PEM malformed
- `armor.ashbi.ca` self-signed cert
- `splashtown-host-guard.sh` mode 644 (cron permission-denied)
- `ai-billing-audit.ashbi.ca` returns 401 (auth-required)

Calendar import touches none of these. If the deploy surfaces any of
them, **stop, flag to Cameron, do not auto-fix.**