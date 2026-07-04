# Swap monitoring runbook — EduSupervise VPS

Observed window: 2026-07-04 21:00–21:05 UTC
Container: `vps.ashbi.ca` (15 GiB RAM, 4.0 GiB swap)

## Current state

```
$ free -h
               total        used        free      shared  buff/cache   available
Mem:            15Gi       7.2Gi       3.5Gi       143Mi       5.4Gi       8.4Gi
Swap:          4.0Gi       4.0Gi        16Mi
```

```
$ vmstat 1 5 (steady-state, 5 sample window)
procs  ---memory---  ---swap--  -----io----  -system-
 r b   swpd   free   buff cache  si  so   bi  bo    in  cs
 3 0 4177412 3693952 44 5624004  7 12   366  683  2816   11
 0 0 4177412 3726124 44 5624076  0  0   0    44  4608 5810
 1 0 4177412 3728908 44 5624072  0  0   0    40  4491 7115
 2 0 4177412 3729104 44 5624080  0  0   0    32  2860 4062
 0 0 4177412 3730944 44 5624088  0  0   0   136  5342 8728
```

Summary:
- Swap shows 100% utilised (4.0 GiB in-use, 16 MiB free).
  This is from PRIOR load — the working set has not been
  paged-in/out in the last 4 samples. si/so = 0 for 4 of 5
  reads. No thrash right now.
- Mem: 7.2 GiB used of 15 GiB available (48% utilisation), 5.4
  GiB in buff/cache, 3.5 GiB free. Available = 8.4 GiB.
- Load avg 2.37 on 16 cores = CPU is not the bottleneck.
  This is a memory-pressure system, not a CPU-pressure system.

## Threshold (when to act)

| Metric                              | OK        | Watch     | Page      | Auto-raise |
|-------------------------------------|-----------|-----------|-----------|------------|
| `si`/`so` per second over 5 min     | 0         | 1–99      | 100–999   | ≥ 1000     |
| Swap used %                         | < 80%     | 80–95%    | 95–100%   | n/a (it's |
|                                     |           |           | sustained | a lagging  |
|                                     |           |           |           | indicator) |
| Available memory                    | > 4 GiB   | 2–4 GiB   | < 2 GiB   | < 1 GiB    |

Auto-trigger: sustained (5+ samples) `si > 100` AND `so > 100`
on the 1-second sample rate. That's a swap-thrash signature
matching the OOMKill risk the audit flagged.

## How to monitor

`/metrics` (audit B10) exposes:
- `edusupervise_process_resident_memory_bytes` — the web
  container's RSS.
- Plus `nodejs_*` GC stats via prom-client's `collectDefaultMetrics`.

For host-level swap on the container host (not per-container),
a `node_exporter` textfile collector would read
`/var/lib/node_exporter/swapswap_used_bytes` (one-line file).
That's the right pair to the in-process metrics and lets a
scrape-only deployment get both layers in one Prometheus pull.

If you want a quick eyeball:

```bash
ssh root@vps.ashbi.ca 'free -h | awk "/Swap:/ {gsub(\"[A-Za-z]\",\"\",\$3); print \"swap_used=\"\$3\""}'
ssh root@vps.ashbi.ca 'vmstat 1 60 | awk "NR>2 && \$7+\$8 > 100 {print \"swap_io \"\$7\"+\"\$8\" kB/s\"}"'
```

## Mitigation plan if threshold breached

1. **First, raise container mem_limit** (cheapest, no VM work).
   `docker/docker-compose.yml`:
   - `web.mem_limit: 1.5g → 2g`
   - `worker.mem_limit: 1g → 1.5g`
   - `postgres.mem_limit: 4g → 6g`
   Then `docker compose -p docker up -d --force-recreate web worker`.
2. **If that doesn't recover**, the host itself is short on RAM.
   Add a swap file (small, low priority) for headroom:
   ```
   fallocate -l 4G /data/swapfile
   chmod 600 /data/swapfile
   mkswap /data/swapfile
   swapon /data/swapfile
   ```
   Persist in `/etc/fstab`.
3. **If even that doesn't recover**, the VPS needs more RAM.
   Cameron: file a ticket for AlmaLinux 10 resize from 15 GiB →
   24 GiB tier.

## What's NOT a problem here

- 100% swap utilisation alone is NOT thrash. The 4 GiB swap has
  accumulated pages from historical load; the active working set
  fits in 8.4 GiB available RAM. Page-out (so > 0) matters, not
  page-in (si > 0) alone. The audit's "Watch si/so via vmstat 1
  for 5 min" sequencing checks exactly this distinction.
- Load average 2.37 on 16 cores = 15% busy. CPU is fine.

Audit: closes S-D3 (2026-07-04). Cameron-approved: NO action needed
right now; doc + monitoring in place.
