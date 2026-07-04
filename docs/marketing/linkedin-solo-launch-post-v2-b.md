A Toronto teacher pulled me aside on July 4.

He'd been beta-testing EduSupervise and sent me two screenshots of his actual duty roster. His note: "start with Teacher lead personal scheduler and moving on an expanding from there."

That one sentence changed the roadmap.

The data model was admin-shaped. It assumed a school has many teachers. EAs didn't exist as a role. Group duties were 1:1. Every time I looked at his real schedule, I saw gaps.

I shipped three things this week to fix the model and meet him where he is.

**1. Solo teacher path.**
Any teacher can sign up and run their own duty rotation. No school admin needed.
205 teachers signed up in the first 30 days.

**2. Educational Assistants as a first-class user type.**
They show up, cover, leave. No "mark complete" gate.
I had them as a flag on the teacher type for the first three months. Everyone was confused. Made them a separate role last week.

**3. PDF drop.**
Drop your board's 5-day rotation PDF in. The system parses it in under 500 milliseconds using pdfplumber's table extraction. No AI vision hallucination. Edit any cell before saving.

Built solo in Toronto. The product is at https://edusupervise.ashbi.ca.

If you're a teacher, an EA, or you know one, drop a comment with what eats the most time in your school's supervision rotation. I'll send you the rundown of how we built through the rough parts.

#edusupervise #k12teachers #schooladmin #edchat

---

**First-comment hook:**

For those of you running your duty rotation from a board PDF, a shared Google Doc, or a printed spreadsheet, what's the most painful part: building the rotation, picking up swaps when someone calls in sick, or finding your own slot?