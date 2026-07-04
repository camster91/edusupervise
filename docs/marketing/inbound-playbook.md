# Inbound Lead Management Playbook — Solo Launch GTM

> Audience: Cameron. Use when replies start landing in `cameron@ashbi.ca` from the
> Solo Launch cold-email batch, the LinkedIn post, and the refreshed Upwork
> profile. All replies are drafts until Cameron hits send.

---

## 0. Scope — read this first

This playbook covers inbound replies to Cameron's Solo Launch GTM campaign. The
reply inbox is `cameron@ashbi.ca` (ASHBI Gmail connection on the Maton CLI).

Three lead shapes will arrive:

| Shape | Where it comes from | Who handles it |
| --- | --- | --- |
| **Cameron client leads** — WordPress, Shopify, Figma-to-WP work | Cold emails, LinkedIn DMs, Upwork profile views | This playbook |
| **EduSupervise product signups** — teachers, EAs, school admins | Self-serve at `/signup?mode=solo` on `edusupervise.ashbi.ca` | Self-serve, not this inbox |
| **Vendor / PR / partnership pitches** — generic "let's collaborate" | Cold outreach that doesn't fit Cameron | Log + ignore |

**Critical redirect:** if a `.edu` reply asks about EduSupervise as a product,
point them at `/signup?mode=solo` (free, self-serve, under 10 minutes) and close
the thread. Do not engage EduSupervise product questions as client work.

---

## 1. Daily inbox monitoring checklist

Run **once each morning, before 10am ET**, while the cold batch is in flight.
Friday sends → first replies land Monday-Wednesday.

```bash
# 1. Count unread — should match yesterday's count +/- new overnight
maton google-mail message list --query "is:unread" --hydrate -L 50

# 2. Read each new unread message in full
maton google-mail message get <msg-id> --headers

# 3. Pull anything already in the campaign thread window
maton google-mail message list --query "newer_than:7d -in:trash" --hydrate -L 50

# 4. Check the Promotions + Social + Spam tabs — Upwork and LinkedIn
#    auto-replies often land in Promotions and miss the Primary tab
maton google-mail message list --query "category:promotions newer_than:2d" --hydrate -L 20
maton google-mail message list --query "in:spam newer_than:2d" --hydrate -L 20

# 5. Confirm Maton connection health (cheap insurance mid-reply)
maton google-mail whoami

# 6. Bulk view of any contacts already created this week
maton hubspot contact search \
  --filter hs_lead_status:EQ:NEW --limit 50 \
  --properties email,firstname,lastname,lead_score,last_reply_date

# 7. Stamp the original_thread_id on any contacts created today so future
#    replies stay linked to the same HubSpot record (one contact per thread,
#    not one per message). Do this BEFORE replying to avoid orphaned threads.
maton hubspot contact update <contact-id> \
  --properties original_thread_id=<gmail-thread-id>,last_reply_date=$(date +%Y-%m-%d)
```

Time budget: **15 minutes** if zero new replies, **30-45 minutes** if 5+. Bump
to twice-daily checks (morning + 3pm ET) the moment a HOT lead lands.

---

## 2. Lead scoring rubric

Score every inbound reply. One score per thread. Update on every new reply in
the thread.

### 🔥 HOT — reply within 2 hours, Cameron copies himself on the response

All three present:

- Budget mentioned ("we have $X budgeted", "approved spend is Y")
- Timeline mentioned ("need this live by March", "ASAP")
- Decision-maker identified ("I'm the founder", "I sign the checks", "my partner and I")

Or any one of:

- Asked for a specific deliverable with a hard deadline
- Replied within 1 hour of your cold email
- Sent a Loom, screenshot, or Figma link unprompted

### 🟡 WARM — reply within 24 hours, use templates in Section 3

Any one of:

- Asked for pricing without budget or timeline
- Asked for portfolio samples
- Asked a technical question
- Said "interesting, tell me more"
- Said "not now but maybe Q3" (still WARM enough for one follow-up)

### ⬜ COLD — log + slow-drip queue, no rush

Any one of:

- Polite no-thanks
- Out-of-office auto-reply
- Asked a question that reads as fishing for free advice (no project context)
- Generic "send me your rates" with no project context
- Vendor / PR pitch

---

## 3. Reply templates

All templates are drafts. Cameron reviews, edits if needed, then sends via Maton.
**No auto-send.** Every `message reply` and `message send` requires Cameron's
explicit approval per Maton's policy.

The reply pattern (threading headers auto-added):

```bash
# Draft (Cameron reviews in Gmail, then sends)
maton google-mail message reply <msg-id> \
  --body "$(cat reply.txt)" --draft

# After Cameron approves, drop --draft and run it for real
maton google-mail message reply <msg-id> \
  --body "$(cat reply.txt)"

# New outbound (not a reply — for follow-ups after a no-response)
maton google-mail message send \
  --to <addr> --subject "..." --body "..."
```

### Template (a) — Interested, asks for pricing

**Trigger:** "What do you charge?" / "Send me a rate sheet" / "What's your hourly?"

```
Subject: Re: <original>

Hey <first name>,

Happy to give you a number. Two questions first, since the answer depends on
what you actually need:

1. What's the page or store you're trying to ship, and roughly what's on it now?
2. Any plugins, theme, or design file you're starting from, or is this a blank slate?

Once I have those, I can send back a tight fixed-price quote — no hourly
surprises, no "let me check with the team."

Top Rated on Upwork, 80+ projects, $100K+ earned.

Happy to send over a one-pager with the rest of what I'd ask — no charge,
no follow-up if it isn't useful.

— Cameron
```

**Word count:** ~95.

### Template (b) — Interested, asks for a call

**Trigger:** "Can we hop on a call?" / "When are you free?" / "Book 15 min"

This is the friction one. Don't book the call yet. Trade the call for three
written answers, then offer the call as the second step. Most replies turn
into a written scope + quote within one round trip.

```
Subject: Re: <original>

Hey <first name>,

Calls eat time on both sides. Before we book one, can you reply with three
things in writing?

1. The page or store you're trying to ship, and roughly what's there now.
2. The deadline you're working backwards from.
3. The rough budget range you have approved.

If I have those, I can send you a written scope + fixed price in one round
trip — usually faster than a call. If you'd rather just talk, I'm happy to
set up 20 minutes Thursday or Friday afternoon ET.

Top Rated on Upwork, 80+ projects, $100K+ earned.

— Cameron
```

**Word count:** ~110.

**Why this works:** the lead either writes back the three things (fast path)
or asks for the call anyway (they were serious). Either way, tire-kickers
self-filter without you being rude.

### Template (c) — Wants a portfolio sample

**Trigger:** "Can you show me examples?" / "Have you done anything like this?"

Send 2-3 specific links, not a portfolio dump. Tie each one to something they
mentioned in their reply. Never send a sample that doesn't fit their stated
need — sending "the wrong" portfolio is the fastest way to lose a lead.

```
Subject: Re: <original>

Hey <first name>,

A few that map to what you described:

- <link 1> — <one sentence on what's relevant to them>
- <link 2> — <one sentence>
- <link 3> — <one sentence>

If you want the full set, my Upwork profile has the rest:
https://www.upwork.com/freelancers/cameronashley

Top Rated on Upwork, 80+ projects, $100K+ earned.

Happy to send over a short PDF with the case study + before/after metrics
for any one of those — no charge, no follow-up if it isn't useful.

— Cameron
```

**Word count:** ~85 (excluding link slugs).

**Fill rule:** if no relevant sample exists for their exact stack, send the
closest two plus the EduSupervise case study. EduSupervise doubles as proof
that Cameron ships his own products — it's a credibility signal, not a
service pitch.

### Template (d) — Says "not now, maybe later"

**Trigger:** "Not the right time" / "Maybe Q3" / "Circle back later" / "Not in the budget"

Don't push. Add them to the 90-day re-engagement list. Send one useful artifact,
not a "just checking in" email. One touchpoint — not a drip campaign.

```
Subject: Re: <original>

Hey <first name>,

No problem — I'll close out my notes here.

I wrote up a short thing on <one specific topic from their project — page
speed, Figma handoff, WooCommerce checkout, whatever they mentioned>:
<link>. Sending in case it's useful when the timing works.

If you want, I'll ping you once around <date 90 days out> with one note,
not a sales email. If you'd rather I don't, just say "no follow-up" and
I'll drop it.

Top Rated on Upwork, 80+ projects, $100K+ earned.

— Cameron
```

**Word count:** ~95.

**Cadence:** set the 90-day reminder in HubSpot on the `re_engage_date` field
(Section 4). Do not send anything else in between. Two unanswered emails from
Cameron burns the lead.

### Template (e) — Polite no-thanks

**Trigger:** "Thanks but no thanks" / "We went with someone else" / "Not a fit"

One sentence acknowledging. One sentence leaving the door open. No groveling,
no "is there anything I could have done better" essay. No credentials line —
they don't need it.

```
Subject: Re: <original>

Hey <first name>,

Got it — appreciate you letting me know. If the new person doesn't work
out, my contact info's here whenever.

— Cameron
```

**Word count:** ~30.

**Why so short:** if they said no, more words from you makes them regret
replying. Drop everything except the door-open line.

---

## 4. CRM hygiene (HubSpot via Maton)

Cameron's choice: HubSpot Free tier. Connection on the ASHBI key. To find the
connection ID for any command:

```bash
maton connection list --jq '.connections[] | select(.app == "hubspot") | {id, status}'
```

### Log on every inbound reply

Within 30 minutes of reading the email, create or update the contact:

```bash
# New lead — create with the basics
maton hubspot contact create \
  --set email=<lead-email> \
  --set firstname=<first> \
  --set lastname=<last> \
  --set company=<company-or-individual> \
  --set lifecyclestage=lead \
  --set hs_lead_status=NEW \
  --set lead_source="Solo Launch Cold Email"

# Then update with the score + notes you wrote while reading the reply
maton hubspot contact update <contact-id> \
  --set lead_score="HOT" \
  --set last_reply_date="2026-07-04" \
  --set original_thread_id="<msg-id>" \
  --set next_action="Send template (a) by Friday" \
  --set project_type="WordPress" \
  --set lead_notes="Asked for hourly rate on Shopify homepage refresh. Budget not mentioned. Follow up with pricing template."
```

For replies from `.edu` addresses about EduSupervise: still log the contact,
but set `next_action="Redirect to /signup?mode=solo and close"`.

### Fields to populate on every contact

| HubSpot property | What to put | Required? |
| --- | --- | --- |
| `email` | The reply-to address | yes |
| `firstname` / `lastname` | From the signature | yes |
| `company` | From signature, LinkedIn, or reply context | yes |
| `lifecyclestage` | `lead` on first reply → `marketingqualifiedlead` after second reply → `salesqualifiedlead` when budget + timeline + decision-maker all confirmed | yes |
| `hs_lead_status` | `NEW` on first reply, `OPEN` after Cameron touches it, `IN_PROGRESS` during negotiation | yes |
| `lead_source` | `Solo Launch Cold Email` / `Solo Launch LinkedIn DM` / `Solo Launch Upwork` | yes |
| `lead_score` | `HOT` / `WARM` / `COLD` (custom property — create on first use) | yes |
| `last_reply_date` | ISO date from the email header | yes |
| `original_thread_id` | The Gmail message ID used for `maton google-mail message reply` | yes |
| `project_type` | `WordPress` / `Shopify` / `Figma-to-WP` / `Other` | optional |
| `lead_notes` | One-line summary of what they asked + what you sent | yes |
| `next_action` | e.g. `Send pricing template (a) by Friday` | yes |
| `re_engage_date` | For COLD leads: ISO date 90 days out | if COLD |

If `lead_score` doesn't exist yet as a custom property, create it via HubSpot's
admin UI once (Free tier allows up to 10 custom contact properties), or fall
back to stuffing it into `lead_notes` until it does.

### Bulk view at end of week (Friday afternoon)

```bash
# Pull every Solo Launch contact created or updated this week
maton hubspot contact search \
  --filter lead_source:CONTAINS_TOKEN:Solo Launch \
  --limit 100 \
  --properties email,firstname,lastname,lead_score,last_reply_date,next_action,re_engage_date

# Surface any lead with overdue next_action (filter on JSON client-side)
maton hubspot contact search \
  --filter lead_source:CONTAINS_TOKEN:Solo Launch \
  --limit 200 \
  --properties email,lead_score,next_action,last_reply_date \
  --jq '.results[] | select(.properties.next_action != null)'
```

Spot-check the list every Friday. Anything with `next_action` overdue by 48+
hours gets flagged in a Slack/Telegram note to Cameron. Cameron decides whether
to send a follow-up or mark the lead dead.

---

## 5. Escalation — templates vs Cameron

### Templates handle it (draft → Cameron approves → Cameron hits send)

- COLD replies matching template (e) or (d)
- WARM replies matching template (a), (b), or (c) — pick the right template,
  fill in the blanks, save as draft with `--draft`, Cameron reviews in Gmail
  and sends
- Auto-replies / OOO — log as COLD, no reply needed
- Vendor / PR pitches — log + ignore
- Duplicates of a lead already in HubSpot — link to the existing contact and
  reply on the existing thread

### Cameron steps in directly (skip the templates)

- Any reply that mentions a past Upwork contract (legal / dispute / refund
  language)
- Anything naming another freelancer Cameron is working with or replacing
  ("since X couldn't deliver…")
- Requests for an NDA, MSA, or contract before pricing
- Anything with a budget over $25K — Cameron scopes personally
- Anything that smells off — too-good-to-be-true scope, vague company,
  generic "we're a fast-growing startup" with no name
- Reply from a `.edu` address where the ask is EduSupervise product
  (redirect to self-serve `/signup?mode=solo`, do not engage as client work)

### The 48-hour rule

If a HOT lead hasn't received a reply within 48 hours, **escalate to Cameron
immediately** via Slack/Telegram. Don't wait for the next morning's checklist
run. HOT leads decay fast.

If a WARM lead hasn't received a reply within 5 business days, update
`next_action` to `OVERDUE — push or close?` and surface in the Friday
review. Cameron decides whether to send one more touchpoint or close the
thread.

---

## 6. What NOT to do (Cameron's hard rules, applied to inbound)

- **No "thanks for reaching out!" opener.** They reached out because they
  have a project. Get to the project.
- **No flattery.** "Love what you're doing with X" reads as mass-template.
  Skip.
- **No "schedule a 15-min call" as the first CTA.** Trade for written scope
  first (template b).
- **No credentials paragraph.** One line max: "Top Rated on Upwork, 80+
  projects, $100K+ earned."
- **No follow-ups more than once per thread.** If a lead doesn't reply to
  your first follow-up, close the thread. Two unanswered emails = move on.
- **No auto-send.** All replies are drafts. Cameron reviews + clicks send.
- **No "Saw you launched X — congrats" opener.** Cut. Lead with the
  receipts or skip the opener.

---

## Appendix A — Quick-reference command cheatsheet

```bash
# Inbox triage
maton google-mail message list --query "is:unread" --hydrate -L 50
maton google-mail message get <msg-id> --headers
maton google-mail message list --query "newer_than:7d -in:trash" --hydrate -L 50

# Reply (draft then send)
maton google-mail message reply <msg-id> --body "$(cat reply.txt)" --draft
maton google-mail message reply <msg-id> --body "$(cat reply.txt)"

# New outbound follow-up
maton google-mail message send --to <addr> --subject "..." --body "..."

# CRM
maton hubspot contact create --set email=... --set firstname=...
maton hubspot contact update <id> --set lead_score=HOT --set next_action=...
maton hubspot contact search --filter lead_source:CONTAINS_TOKEN:Solo Launch --limit 100

# Health check
maton google-mail whoami
maton connection list --jq '.connections[] | select(.app == "hubspot") | .id'
```

---

## Appendix B — Per-campaign source tracking

When creating the lead, set `lead_source` to one of these exact strings so the
Friday bulk view (`--filter lead_source:CONTAINS_TOKEN:Solo Launch`) catches them
all:

| Source string | When to use |
| --- | --- |
| `Solo Launch Cold Email` | Reply to a direct cold email Cameron sent |
| `Solo Launch LinkedIn DM` | Reply to a LinkedIn DM from Cameron |
| `Solo Launch Upwork` | Reply via Upwork inbox (rare — Upwork holds its own inbox) |
| `Solo Launch Referral` | Reply says "X told me to reach out" |
| `Solo Launch Inbound` | Reply on its own, no campaign trigger (warm inbound) |