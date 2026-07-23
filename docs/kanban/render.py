#!/usr/bin/env python3
"""
docs/kanban/render.py — regenerate kanban.md from state.json

Run from the repo root:

    python3 docs/kanban/render.py

The state.json file is the source of truth (atomic write when status
moves); this script only re-renders the display layer. Following the
camster91-kanban pitfall #1: never edit kanban.md directly.

Per-state field shape: see docs/kanban/state.json (schema v1).
"""

from __future__ import annotations

import datetime
import json
from pathlib import Path

KANBAN_DIR = Path(__file__).parent
STATE_PATH = KANBAN_DIR / "state.json"
RENDER_PATH = KANBAN_DIR / "kanban.md"

SEVERITY_EMOJI = {
    "critical": "🔴",
    "high": "🟠",
    "medium": "🟡",
    "low": "🟢",
}
CATEGORY_EMOJI = {
    "rebase-conflict": "🔀",
    "ship": "🚢",
    "ops": "⚙️",
    "security": "🛡️",
    "code-quality": "✨",
    "test": "🧪",
    "devops": "🔧",
}
STATUS_ORDER = ["todo", "in-progress", "in-review", "backlog", "done", "dropped"]


def format_issue(it: dict) -> str:
    sev = SEVERITY_EMOJI.get(it["severity"], "·")
    cat = CATEGORY_EMOJI.get(it["category"], "·")
    agent = it["agent"]
    blocks = (
        f" · blocks: {', '.join(it.get('blocks', []))}"
        if it.get("blocks")
        else ""
    )
    deps = (
        f" · needs: {', '.join(it.get('depends_on', []))}"
        if it.get("depends_on")
        else ""
    )
    comment = f"\n    _{it['comment']}_" if it.get("comment") else ""
    return (
        f"- {sev} **{it['severity'].upper()}** {cat} `{it['key']}` — {it['title']}\n"
        f"    agent: `{agent}`{blocks}{deps}{comment}"
    )


def main() -> None:
    state = json.loads(STATE_PATH.read_text())
    issues = list(state["issues"].values())

    by_sev = {s: 0 for s in SEVERITY_EMOJI}
    by_status = {s: 0 for s in STATUS_ORDER}
    for it in issues:
        by_sev[it["severity"]] += 1
        by_status[it["status"]] += 1

    by_status_group: dict[str, list] = {s: [] for s in STATUS_ORDER}
    for it in issues:
        by_status_group.setdefault(it["status"], []).append(it)

    md = [
        f"# EduSupervise Kanban — generated {state['generatedAt']}",
        "",
        "**Last audit:** 2026-07-22 (full-codebase review + rebase-in-progress follow-up)",
        "",
        "**Conventions:**",
        "- severity: 🔴 critical · 🟠 high · 🟡 medium · 🟢 low",
        "- category: 🔀 rebase · 🚢 ship · ⚙️ ops · 🛡️ security · ✨ code-quality · 🧪 test · 🔧 devops",
        "- agent: `parent` = me + Cam in this chat · `subagent` = dispatchable · `human-needed` = your call",
        "- **state.json is the source of truth** — kanban.md is regenerated from it",
        "",
        "## Counts",
        f"- Total tracked: **{len(issues)}**",
        "- " + " · ".join(
            f"{s}={by_sev[s]}" for s in ["critical", "high", "medium", "low"]
        ),
        "- " + " · ".join(f"{s}={by_status[s]}" for s in STATUS_ORDER),
        "",
    ]

    for status in STATUS_ORDER:
        rows = by_status_group.get(status, [])
        if not rows:
            continue
        md.append(f"## {status.upper()} ({len(rows)})")
        md.append("")
        for it in rows:
            md.append(format_issue(it))
        md.append("")

    md.append("## Workflow")
    md.append("")
    md.append("- **Update state.json first** when moving an issue between statuses.")
    md.append("- The Markdown view is regenerated from state.json by `docs/kanban/render.py`.")
    md.append("- Conflict-marker resolution = work the parent does in the chat right now.")
    md.append("- `subagent` rows are batchable with `delegate_task` (background).")
    md.append("- `human-needed` rows require an explicit decision from Cam in chat.")
    md.append("")

    RENDER_PATH.write_text("\n".join(md))
    print(
        f"rendered {len(issues)} issues ({by_status['todo']} todo, "
        f"{by_status['in-progress']} in-progress, "
        f"{by_status['backlog']} backlog, {by_status['done']} done)"
    )


if __name__ == "__main__":
    main()