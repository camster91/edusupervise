Subject: Re: app idea — solo teacher path is live

Hey Jason,

Quick follow-up. You said you wanted a way for teachers to start their own duty calendar without admin setup — that's live now.

Three things shipped this week on https://edusupervise.ashbi.ca:

**1. Solo teacher signup.** Hit /signup?mode=solo, pick "Teacher" (or "Educational assistant"), 5-step wizard, you're running your own schedule. No school admin needed, no join code.

**2. PDF drop.** Drop your board's 5-day rotation PDF in, it parses the schedule in about 250ms. Empty cells stay empty, group coverage rows like "Cyriac, Loganathan, Sheikh" get detected. You can edit any cell before saving.

**3. Educational Assistants.** Real user type now. They get assigned to specific slots, no "mark complete" gate — supervising is the whole job.

The AI-set-up-reminders bit isn't built yet — I want to do that properly with the actual school-board PDF formats from real districts, not a vision model that hallucinates. If you want to beta the PDF parser, your real board PDF would be the most useful test input I can get. Format we handle today is the Day 1-4 columns with teacher names per cell.

No follow-up needed if you're busy. If you try it and something's off, the easiest way to flag it is a screenshot — paste in the chat and I'll fix.

— Cameron