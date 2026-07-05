# Migration 0013 — Journal Update Patch

**Why this is a patch, not a full `_journal.json`:** the local checkout only has entries 0000-0006, but the live VPS has 0000-0012. I don't have authoritative content for 0007-0012 from this branch, so I'll ship the 0013 entry as a mergeable block rather than fabricate the missing entries.

**Apply one of two ways — pick whichever fits your deploy script:**

---

## Option A — `jq` append (recommended)

```bash
# from the edusupervise repo root, on the VPS or your sync target
cd packages/db/migrations

# 1) Stage the new SQL
ls 0013_cycle_calendar_columns.sql  # confirm it's present

# 2) Append the new entry to meta/_journal.json
TMP=$(mktemp)
jq '.entries += [{
  "idx": 13,
  "version": "7",
  "when": 1783239969440,
  "tag": "0013_cycle_calendar_columns",
  "breakpoints": true
}]' meta/_journal.json > "$TMP" && mv "$TMP" meta/_journal.json

# 3) Verify
jq '.entries[-1]' meta/_journal.json
# expect:
# {
#   "idx": 13,
#   "version": "7",
#   "when": 1783239969440,
#   "tag": "0013_cycle_calendar_columns",
#   "breakpoints": true
# }

# 4) Verify idx sequence is contiguous
jq '[.entries[].idx]' meta/_journal.json
# expect: [0,1,2,3,4,5,6,7,8,9,10,11,12,13]
```

`when = 1783239969440` was generated at 2026-07-05 04:26:09 EDT (America/Toronto). The value is informational only — drizzle-kit does not sort migrations by `when`, it sorts by `idx`. If you regenerate the file later and want the timestamp to match the actual write moment, run `python3 -c "import time; print(int(time.time() * 1000))` and substitute.

---

## Option B — Manual paste

Open `packages/db/migrations/meta/_journal.json` and append this object to the `entries` array (after the idx:12 entry, before the closing `]`):

```json
    ,
    {
      "idx": 13,
      "version": "7",
      "when": 1783239969440,
      "tag": "0013_cycle_calendar_columns",
      "breakpoints": true
    }
```

Validate with `jq '.entries | length' meta/_journal.json` — expect `14` (idx 0..13 inclusive).

---

## New entry (copy-paste ready)

```json
{
  "idx": 13,
  "version": "7",
  "when": 1783239969440,
  "tag": "0013_cycle_calendar_columns",
  "breakpoints": true
}
```

---

## Sanity-check before commit

```bash
# 1) all idx values are unique + contiguous 0..13
jq '[.entries[].idx] | . == (range(0; length))' meta/_journal.json
# expect: true

# 2) every SQL file in the migrations dir has a matching journal tag
jq -r '.entries[].tag' meta/_journal.json | sort > /tmp/journal_tags.txt
ls -1 *.sql | sed 's/\.sql$//' | sort > /tmp/disk_tags.txt
diff /tmp/journal_tags.txt /tmp/disk_tags.txt
# expect: no output (the two lists should be identical)
```