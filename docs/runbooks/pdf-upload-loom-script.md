# EduSupervise PDF Upload — Loom Walkthrough Script

**Audience:** Teachers and school admins seeing the PDF ingestion feature for the first time.
**Length target:** 90 seconds (2-3 minutes max).
**Tone:** Calm, confident, 12th-grade English. No jargon unless explained.
**Format:** Screen recording with voiceover. No face required.

---

## Pre-recording setup

1. Open https://edusupervise.ashbi.ca and sign in to a solo teacher account (or use the demo signup).
2. Have a real 5-day duty rotation PDF ready on the desktop — Jason's screenshot is a good reference for the format (Day 1-4 columns, teacher names per cell, some "EA" rows, some empty cells).
3. Open browser DevTools → Network tab so you can show the upload/parse timing if you want (optional, cuts ~10s).

---

## Script

### Opening (0:00-0:10)

> "Drop your school's 5-day duty rotation into EduSupervise and we'll pull out the schedule for you. Here's how."

### Step 1 — Upload (0:10-0:25)

Show the user clicking "Upload your duty schedule" on the onboarding wizard, then dragging in the PDF (or using file picker).

> "Click upload, drop in your duty rotation PDF. The board-published kind works — or anything with a table of names and days."

### Step 2 — Parse (0:25-0:40)

Show the upload progress / spinner. Highlight the parse time in the response (sub-second).

> "It parses in about 400 milliseconds. No uploading to a third-party AI — we read the tables locally so your staff data stays in your school."

### Step 3 — Review (0:40-1:05)

Show the review card with editable cells. Point out: Day 1 column has Attwood, Day 2 McVey, etc. Highlight the "EA" cells and the empty cells preserved.

> "Here's your schedule in review form. Every cell is editable — click any name to fix a misspelling, change a teacher, or mark someone as an EA instead of a teacher. Empty cells stay empty; we don't auto-fill."

### Step 4 — Confirm (1:05-1:20)

Show the user clicking "Save and continue".

> "Hit save and your duties are live. You'll get a reminder 15 minutes before each one — change that anytime in Settings."

### Closing (1:20-1:30)

Show the /app/today screen with the imported duties.

> "That's it. Your schedule is in the app. From here, you can swap duties, broadcast for coverage when you're out, and your reminders just work."

---

## Optional callouts (if recording runs long)

- "Educational Assistants are a first-class role — pick that on signup if you're an EA."
- "Solo teachers skip the school admin setup. One teacher, one school, no extra accounts."
- "All data lives in your school's tenant. We never cross-share between schools."

---

## What NOT to say

- ❌ "AI-powered" — this is table extraction, not AI vision.
- ❌ "Enterprise-grade" — not a value prop for solo teachers.
- ❌ "Disrupting" / "leverage" / "holistic" — banned per writing style.
- ❌ "All you have to do is..." — implies simplicity that may not match the user's PDF format.

---

## Recording checklist

- [ ] Test PDF parses cleanly (use the synthetic one in `/tmp/jason-test-rotation.pdf` if no real PDF)
- [ ] No real student names in the recording
- [ ] Sub-2-second parse time visible in DevTools
- [ ] Confirm the upload round-trip works (review → confirm → /app/today shows duties)
- [ ] Voiceover audio clear; no background noise
- [ ] Final screen shows the imported duties on /app/today

---

## Distribution

- Send to Jason as a private Loom link (no public YouTube)
- Embed on cameronashley.ca case study once Phase 3 is stable
- Pin to Upwork profile as "Work sample" when pitching solo-teacher automation projects