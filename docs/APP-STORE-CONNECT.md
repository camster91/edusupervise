# App Store Connect — EduSupervise submission metadata

This document holds the **copy-paste ready** text for the App Store
Connect listing of `EduSupervise` (bundle ID `ca.ashbi.edusupervise`).
The build instructions are in `BUILD.md`; this is just the metadata.

## Where to paste

1. **App Store Connect → My Apps → EduSupervise → the version**
2. Each section below corresponds to a field in the form.

---

## 1. App Information (version-less, set once)

### Name
**EduSupervise**

(Apple allows 30 chars. This is the canonical name. Don't add
"EduSupervise: ..." or anything — App Store search prefers short
names.)

### Subtitle (30 chars)
**Duty scheduling for schools**

(Used in App Store search results and at the top of the product
page. Localization: this is the English string. If you localize,
add the same line in fr-CA, es, etc.)

### Privacy Policy URL
**`https://edusupervise.ashbi.ca/privacy`**

(Required. Cameron needs to host a privacy policy at this URL on
the production site — `apps/web/app/routes/privacy.tsx` or similar.
Content: what data we collect, why, retention, third parties
(Mailgun, Stripe-web for billing, etc.), contact info.)

### Privacy Choices URL
**`https://edusupervise.ashbi.ca/privacy#choices`**

(Optional. Skip if you don't have an explicit "data choices" page.)

### Category
**Education** (primary)
**Productivity** (secondary)

(App Store allows exactly one primary + one secondary. Education
matches ICP; Productivity covers the "daily tool" use case.)

---

## 2. Version Information (per release)

### Version
**1.0.0**

(`MARKETING_VERSION` in Xcode build settings. Bump per release:
1.0.0 → 1.1.0 → 2.0.0.)

### Copyright
**© 2026 Ashbi Inc.**

(App Store displays this under the version number. Use whatever
business-name Cameron registers under — `Ashbi Inc.` is the working
name from `cameronashley.ca`.)

### What's New in This Version (4,000 char limit)
```
EduSupervise 1.0.0 — first App Store release.

Schools can now install EduSupervise as a real iOS app — schedule
supervision duties, push duty reminders to teachers' phones, and
send targeted parent alerts when coverage changes. Sign in once
and your school stays signed in across launches.

Built for K-12 schools in Canada. Multi-language support coming.
```

(Roughly 400 chars. Keep it readable — the audience is school
admins reading this on their phone while checking if the app is
right.)

### Promotional Text (170 char limit)
```
Built for K-12 schools. Scheduling, reminders, and coverage — all in
your pocket. Try the free demo or sign in with your school's join
code.
```

(Apple shows this BEFORE the user taps "view more" on the product
page. Lead with the value, not the feature list.)

---

## 3. Description (4,000 char limit — paste as-is)

```
EduSupervise schedules the supervision duties that keep K-12 schools
running — bus dismissal, recess, lunch, before-school coverage — and
reminds the right teacher at the right time.

WHO IT'S FOR

- School admins who manage the duty roster and want to stop sending
  the same "you're on coverage Friday" Slack message every week.
- Teachers who'd rather get a single push at 7:45am than dig through
  email at first period.
- Substitute coordinators assigning last-minute coverage without
  building a spreadsheet from scratch.

WHAT IT DOES

- Build a recurring duty roster in minutes. Set up once, rotate
  across weeks, swap teachers with a tap.
- Push duty reminders to teachers' phones. The right person gets
  the right nudge at the right time — no all-school broadcasts.
- One-tap coverage calls. When a teacher calls in sick, broadcast
  the open slot to qualified substitutes and accept the first
  volunteer.
- Targeted parent alerts. Tell just the affected families when a
  dismissal time shifts — not the whole school.
- Demo school included. Tap "Try the demo" to see exactly what a
  scheduled day looks like, with 5 sample teachers and 4 duties
  pre-loaded.

WHY TEACHERS PREFER IT

- The app remembers your school's rotations. Stop scrolling PDFs.
- Push notifications are scoped. You only get pinged for YOUR duty,
  never for someone else's slip.
- The coverage flow is one tap. Accept a shift, find a substitute,
  confirm the swap — five seconds, not five emails.
- It works on a phone. Designed for the gym parking lot, not the
  front office desktop.

FOR ADMINS

- Audit log every state change. Know who swapped coverage and when.
- Multi-tenant from day one. Each school has its own roster,
  privacy boundaries, and audit trail.
- Tier 1 (this release) covers solo + small schools. Tier 2 brings
  district-level multi-school management.

PRIVACY

We only collect what we need to schedule duties: teacher names,
email, and notification preferences. Audit logs are retained per
plan tier (30 days free, 90 days paid). We don't sell, share, or
profile. Full policy: https://edusupervise.ashbi.ca/privacy

QUESTIONS

support@edusupervise.ashbi.ca
```

**Word count**: ~310 / 4000. Apple allows up to 4000; under 1000
reads better on phones.

---

## 4. Keywords (100 char limit, comma-separated)
```
school,teacher,duty,supervision,coverage,substitute,reminder,k12,bell,safety
```

(Exactly 100 chars incl. commas. Apple weighs keywords heavily —
pick the words a school admin searching the App Store would actually
type. Avoid generic terms like "app". Apple strips the name of the
app and the developer, so don't repeat those.)

---

## 5. URLs

| Field | URL |
|---|---|
| Support URL | `https://edusupervise.ashbi.ca/support` |
| Marketing URL | `https://edusupervise.ashbi.ca` |
| Privacy Policy URL | `https://edusupervise.ashbi.ca/privacy` |

(Cameron needs to host `/support` and `/privacy` on the prod site
BEFORE submitting. These get indexed by Apple's reviewer bots.)

---

## 6. Pricing

- **Price tier**: Free (no IAP)
- **Availability**: All territories
- **Pre-order**: No
- **Distribution method**: App Store

(The current iOS app is READ-ONLY — billing happens in Safari on
`edusupervise.ashbi.ca`. This is intentional to avoid App Store
rule 3.1.1 (15-30% commission on IAP). The free tier stays free on
the App Store; paid plans live on the web.)

---

## 7. App Privacy

App Store Connect asks for a privacy questionnaire per data type.
Fill these in per the Apple template at submission:

| Data | Linked to user | Used for tracking | Collected |
|---|---|---|---|
| Email | Yes | No | Yes (login) |
| Name | Yes | No | Yes (profile) |
| Phone | Yes | No | Yes (optional, for SMS reminders) |
| User ID | Yes | No | Yes (session) |
| Usage data | No | No | Yes (analytics, you choose) |
| Diagnostics | No | No | Optional |

(Don't lie. Apple reviews privacy claims and rejects false
declarations. If you don't collect phone numbers, mark "No". If you
do, link to your privacy policy's data collection section.)

---

## 8. Screenshots

Required: at least 3 per device family. Apple's specs:

| Device | Resolution | Pixel size |
|---|---|---|
| iPhone 6.7" (iPhone 15 Pro Max) | 1290 × 2796 px | 3x |
| iPhone 6.5" (iPhone 11 Pro Max) | 1242 × 2688 px | 3x (legacy) |
| iPad 12.9" (3rd gen+) | 2048 × 2732 px | 2x |

**Capture command on Cameron's Mac** (once the iOS app is built
and running in the simulator):
```bash
# Boot a 6.7" simulator
xcrun simctl boot "iPhone 15 Pro Max"

# Install the EduSupervise .app
xcrun simctl install booted /path/to/EduSupervise.app

# Open the app
xcrun simctl launch booted ca.ashbi.edusupervise

# Walk through the demo flow to get a few good shots:
# 1) login page (with the new Apple-HIG blue accent)
# 2) /app/today (the duties-on-the-board view)
# 3) /app/coverage or /app/duties/new (the "accept a shift" tap path)

# Capture each screen
xcrun simctl io booted screenshot ~/Desktop/screenshot-01-login.png
xcrun simctl io booted screenshot ~/Desktop/screenshot-02-today.png
xcrun simctl io booted screenshot ~/Desktop/screenshot-03-coverage.png
```

Resizing in macOS Preview → export as 1290×2796 PNG → upload to
App Store Connect.

**Suggested shot list** (in order they appear in the App Store
gallery):
1. **Sign-in / branding** (sets the tone)
2. **Today view** (the home screen — busy, multiple duties visible)
3. **Duty detail** (dismissal detail with the assigned teacher + parents)
4. **Coverage alert in action** (push notification UI or the broadcast picker)
5. **Profile / school switching** (the multi-tenant surface)

5 shots is the sweet spot. Apple's UI shows 1-3 in collapsed view
then expands on tap.

---

## 9. TestFlight → App Store submission checklist

After BUILD.md §6 (TestFlight build) succeeds:

- [ ] All 5 screenshots uploaded (6.7" iPhone + 6.5" iPhone + 12.9" iPad)
- [ ] App name / subtitle / keywords in 1-4 above pasted
- [ ] Description in §3 pasted
- [ ] Privacy policy URL resolves and has reasonable content
- [ ] Support URL resolves to a real page (or `mailto:` link)
- [ ] Marketing URL resolves
- [ ] App Privacy questionnaire completed (per §7 above)
- [ ] Age rating: 4+ (no objectionable content)
- [ ] Export compliance: "No exempt encryption" (HTTPS only)
- [ ] Pricing: Free
- [ ] Build selected (the TestFlight build from BUILD.md §6)
- [ ] Submit for review

Apple's review is typically 24-48 hours. If rejected (most common
reason for first-timers: "minimal native value"), reframe the
marketing — push notifications + camera/PDF via webkit are usually
enough to anchor "native value" against the wrap-webview criticism.

---

## 10. Localization (later)

For Phase 2, ship English-only. When ready for fr-CA:
- Duplicate the strings above in French
- Translate the description with the same 12th-grade-English tone
  (Cameron's preference)
- Drop fr-CA screenshots (Apple accepts separate screenshots per
  locale)

Out of scope for this release.