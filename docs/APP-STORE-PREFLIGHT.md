# EduSupervise — App Store Pre-Flight Checklist

Generated 2026-07-13 against VPS HEAD `7f2dd93` on origin/main.

## 1. Apple-side requirements (you do these)

| # | Task | Where | Notes |
|---|---|---|---|
| 1.1 | Apple Developer Program active | developer.apple.com | Required to upload to App Store Connect |
| 1.2 | Bundle ID registered | developer.apple.com → Identifiers | `ca.ashbi.edusupervise` (matches `capacitor.config.ts`, pbxproj, APNS_BUNDLE_ID env) |
| 1.3 | Provisioning profile | developer.apple.com → Profiles | Generated automatically once you sign with your team in Xcode |
| 1.4 | App Store Connect entry created | appstoreconnect.apple.com | Create new app with Bundle ID `ca.ashbi.edusupervise` |
| 1.5 | APNs `.p8` auth key | appstoreconnect.apple.com → Keys | "Apple Push Notifications authentication key" — download ONCE (Apple never shows it again). Note the 10-char Key ID and your 10-char Team ID |
| 1.6 | Xcode signing team | Xcode → Signing & Capabilities | Select your Apple Developer team. The "Push Notifications" capability must be enabled (this creates the `.entitlements` file with `aps-environment`). The provisioning profile Apple generates will have APNs enabled. |
| 1.7 | Provision the `.p8` | scp + env edit | `scp ~/Downloads/AuthKey_XXXXX.p8 coolify:/root/apns-keys/` (after `mkdir -p /root/apns-keys && chmod 700`). Edit `/root/edusupervise-secrets/.env` to set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`. Same in `/opt/edusupervise/docker/.env`. `APNS_BUNDLE_ID=ca.ashbi.edusupervise` and `APNS_ENV=production` are pre-staged. |
| 1.8 | Rebuild web container | ssh | `cd /opt/edusupervise && docker compose -f docker/docker-compose.yml -p docker up -d --build web` |
| 1.9 | Archive + distribute | Xcode → Product → Archive → Distribute App | Choose "App Store Connect" → upload. Build number must be unique per upload. |
| 1.10 | Submit for review | App Store Connect → the build → "Submit for Review" | After completing App Privacy + Age Rating + demo account. Review typically 1-3 days. |

## 2. App Store Connect metadata (copy from `docs/APP-STORE-CONNECT.md`)

| Field | Value | Status |
|---|---|---|
| App name | EduSupervise | ✓ in metadata doc |
| Subtitle | "Duty scheduling for schools" | ✓ 27 chars (under 30) |
| Category | Education (primary), Productivity (secondary) | ✓ |
| Privacy Policy URL | `https://edusupervise.ashbi.ca/privacy` | ✓ live, verified |
| Support URL | `https://edusupervise.ashbi.ca/support` | ✓ live, verified |
| Marketing URL | `https://edusupervise.ashbi.ca` (optional) | ✓ |
| Description | (from `docs/APP-STORE-CONNECT.md` §3) | ✓ ~1900 chars |
| Keywords | (from §4) | ✓ 77 chars (under 100) |
| Promotional Text | (from §5) | ✓ 142 chars (under 170) |
| What's New | (from §8, or auto-generated from `/changelog`) | ✓ |
| Pricing | Free | ✓ |
| Availability | All territories | ✓ |
| Age Rating | 4+ (no objectionable content) | ✓ |

## 3. Screenshots required

| Device class | Required dimensions | Count | Status |
|---|---|---|---|
| 6.7" iPhone (15 Pro Max) | 1290 × 2796 px | 3-8 | TODO (you capture) |
| 6.5" iPhone (11 Pro Max) | 1242 × 2688 px | 3-8 | TODO |
| 12.9" iPad Pro | 2048 × 2732 px (portrait or landscape) | 3-8 | TODO (required — you claim iPad support via `UISupportedInterfaceOrientations~ipad`) |
| 5.5" iPhone (8 Plus) | 1242 × 2208 px | optional | — |

Capture command (Xcode simulator):
```bash
# Pick a simulator, then:
xcrun simctl io booted screenshot /tmp/iphone-6.7.png
# For iPad:
xcrun simctl io booted screenshot /tmp/ipad-12.9.png
```

See `docs/APP-STORE-CONNECT.md` §8 for full capture workflow.

## 4. App Privacy Questionnaire (App Store Connect → App Privacy)

Apple's "data collection" disclosure. For each data type the app collects, you declare whether it's used for tracking, linked to user identity, and the purpose. Be honest — Apple reviews against the actual app behavior.

### 4a. Collected, NOT used for tracking, linked to user identity

| Data type | Purpose | Why we collect it |
|---|---|---|
| Email Address | App Functionality, Account Management | Sign-in (no password) via magic link to email. The email IS the user's identity. |
| Name (or display name) | App Functionality, Personalization | Admins see teacher's display name in the duty roster. |
| Photos (profile photo) | Optional, App Functionality | Optional teacher profile photo uploaded by the user themselves. Stored in our Postgres, not shared. |
| User Content (calendar data, duty assignments) | App Functionality | Core feature — the entire product is the duty calendar. Stored encrypted at rest in Postgres. |
| User IDs (school_id, user_id) | App Functionality, Analytics | Multi-tenant isolation (RLS). Used for in-app analytics to compute school-scoped metrics. |

### 4b. NOT collected

| Category | Why not |
|---|---|
| Location | No location features. We don't track where users are. |
| Contacts | We don't access the address book. |
| Health & Fitness | No health data. |
| Financial Info | Billing happens on the web (Stripe). No payment info stored in the iOS app. The iOS app does NOT collect or display payment info. |
| Browsing History | We don't track which websites users visit. |
| Search History | The only search is the in-app duty/calendar search, which is not recorded as a separate "search history" dataset. |
| Sensitive Info | No health, biometric, racial, political, religious, sexual orientation data. |
| Purchases | No in-app purchases. iOS app is free; subscription is via web. (App Store rule 3.1.1 — we link out for billing to avoid Apple IAP cut.) |
| Tracking | The app does not track users across other apps or websites. No advertising SDKs. |

### 4c. Device data

| Data type | Collected? | Purpose |
|---|---|---|
| User ID (device fingerprint) | Yes (APNs push token) | Send push notifications. Stored in `push_subscriptions` table; deleted when user uninstalls. |
| Device ID | No | We don't collect IDFA or any persistent device identifier. APNs tokens are device-specific and unlinkable to other apps. |
| Product Interaction (app crash logs) | No | No Sentry / Crashlytics / similar wired. If you want crash reporting, add it pre-launch and update this section. |
| Other Diagnostic Data | No | Same — no third-party diagnostic SDKs. |

## 5. Account deletion (App Store guideline 5.1.1(v))

Required for any app that creates user accounts. Currently we have **no in-app deletion path**. Two options:

### Option A: Add an in-app "Delete my account" surface (recommended) — **SHIPPED 2026-07-13**

User flow: `/account/delete` → email form → 30-day soft delete → hard delete. The 30-day buffer respects accidental clicks and gives users a recovery window.

Shipped components (all in commit history by 2026-07-13):
- `GET/POST /account/delete` — email form, calls `requestAccountDeletion(email)` (server function in `apps/web/server/account-deletion.server.ts`)
- `GET /account/delete/confirm?token=...` — token consumer, calls `confirmAccountDeletion(rawToken)`
- Server function `cancelAccountDeletion(userId)` — clears `pending_deletion_at` (the Settings → Account → Cancel deletion route is a v1.1 follow-up; the server function is shipped now)
- `POST /api/admin/purge-account-deletions` — X-Cron-Secret auth, called by the daily cron
- Schema migration `0016_account_deletion` — adds `users.pending_deletion_at` + the `account_deletion_tokens` table (RLS+FORCE, defense in depth)
- Schema migration `0017_cascade_created_by` — flips NO ACTION FKs on `duties.created_by` / `coverage_events.created_by` / `duty_assignments.created_by` / `duty_assignments.assigned_by_user_id` / `audit_log.user_id` to CASCADE so the single `DELETE FROM users` cleans up everything atomically
- Cron entry `/etc/cron.d/edusupervise-deletion-purge` at `30 4 * * *`, calling `/root/edusupervise-secrets/daily-account-deletion-purge.sh`
- `audit_log` entries: `action='account_deletion_confirmed' | 'account_deletion_cancelled' | 'account_deletion_purged'`. We don't write a `requested` event (the request step is unauthenticated; we don't audit anonymous email submissions to avoid spam).

For the `school_admin` role: hard-delete cascades to `duties` / `coverage_events` / `duty_assignments` (they go away with the user). If the school has no other admins after the hard-delete, the school record is left intact but no one can manage it; the next admin signup for that school_id will be a fresh onboarding. (Open question: transfer ownership before hard-delete — out of scope for the App Store submission but worth designing in v1.1.)

Set the "Account Deletion URL" in App Store Connect to `https://edusupervise.ashbi.ca/account/delete` (the request form, not the confirm URL — the URL must work for a logged-out user).

See `docs/CRON-ACCOUNT-DELETION.md` for the full operational details.

## 6. Age rating questionnaire (App Store Connect → Age Rating)

For EduSupervise, answer:

| Question | Answer |
|---|---|
| Cartoon or Fantasy Violence | None |
| Realistic Violence | None |
| Sexual Content or Nudity | None |
| Profanity or Crude Humor | None |
| Alcohol, Tobacco, or Drug References | None |
| Mature / Suggestive Themes | None |
| Horror / Fear Themes | None |
| Medical / Treatment Information | None |
| Gambling | None |
| **Resulting rating** | **4+** (no objectionable content in any category) |

## 7. Demo account for App Review

Apple's human reviewer needs working credentials to test the admin flow. Use:

- **Email:** `deploy.test@example.com`
- **Password:** `Test1234!` (school_admin role, password reset in earlier session — feel free to rotate this before submission and update this file)
- **School:** Sunrise Elementary (pre-populated with sample teachers, duties, calendar)
- **Capabilities exposed in the demo account:** full admin (school_admin role). Can sign in, see the dashboard, manage teachers, create duties, view calendar, manage coverage requests, change settings.

If you want to change the demo password before submission, run on the VPS:
```bash
ssh coolify 'cd /opt/edusupervise && docker exec docker-web-1 node -e "import(\"./build/server/server.js\").then(...)"'
```
(Or via the Postgres `users.pass_hash` field directly with a fresh bcrypt hash.)

## 8. App Review notes (for the human reviewer)

In App Store Connect → App Review Information → Notes, include:

```
Demo account credentials in the test info section.

What the app does: School duty scheduling for K-12 schools. Admins
upload a calendar (PDF or CSV), the app parses it and shows each
teacher's daily duty assignments. Push notifications fire for duty
reminders.

What to test: Sign in with the demo account. From the dashboard, the
key flows are: (1) Admin Calendar → upload a PDF (sample in
/admin/calendar), (2) Today → view your duty assignments, (3)
Settings → manage school + billing.

The iOS app loads the web app at https://edusupervise.ashbi.ca via
a Capacitor WKWebView wrapper. The same account works on web and iOS.
Push notifications are wired via Web Push (browser) and APNs (iOS).

Billing: Per App Store guideline 3.1.1, all subscription management
happens in Safari on the same domain (https://edusupervise.ashbi.ca/
app/settings/billing), not in the iOS app. The iOS app is read-only
for subscription management. This avoids Apple IAP commission.
```

## 9. Pre-submission technical checks

| Check | Status | Note |
|---|---|---|
| Bundle ID matches across all configs | ✓ | `ca.ashbi.edusupervise` in `capacitor.config.ts`, pbxproj, `APNS_BUNDLE_ID` env |
| `ITSAppUsesNonExemptEncryption=false` set | ✓ | Info.plist line 51 |
| URL scheme registered | ✓ | `edusupervise://` in Info.plist `CFBundleURLTypes` |
| iOS splash dimensions correct | ✓ | Fixed in `ff9a8d6` (single 2732×2732 image) |
| iOS icon dimensions correct | ✓ | All 15 sizes in `AppIcon.appiconset` match the Contents.json slots |
| `armv7` removed from `UIRequiredDeviceCapabilities` | ✓ | `UIRequiredDeviceCapabilities` is not present in Info.plist at all — Capacitor 7+ dropped it from the default template. Nothing to remove. |
| Push entitlement (`aps-environment`) | ✓ | `App.entitlements` exists with `aps-environment` driven by `$(APS_ENVIRONMENT)` build var (Debug=development, Release=production). Wired into pbxproj in `ab376e6` and `7b13744`. |
| `UIBackgroundModes: remote-notification` | ✓ | Added in `7b13744` for background push delivery |
| Build version numbers | ✓ | `MARKETING_VERSION = 1.0`, `CURRENT_PROJECT_VERSION = 1`. First submission. |
| Code signing identity | TODO | Set in Xcode → Signing & Capabilities after install. Select team = Cameron's Apple Developer team. |
| App Privacy answers | TODO | Use section 4 above as a starting point, customize, then answer in App Store Connect |
| Demo account | TODO | Confirm `deploy.test@example.com` / `Test1234!` works, or rotate |

## 10. Post-submission

After Apple approves (1-3 days):
- **Day 1:** Watch for crash reports in App Store Connect → Analytics → Metrics.
- **Week 1:** Monitor first-user feedback via App Store reviews. Set up an auto-responder via Maton Gmail.
- **Week 2:** Add the in-app account deletion (Option A from §5).
- **Month 1:** Begin v1.1 with whatever the first round of feedback dictates.

## Quick-launch checklist (for the day of submission)

```
[ ] .p8 scp'd to /root/apns-keys/, env vars set
[ ] web container rebuilt
[ ] full Xcode install on Mac
[ ] open ios/App/App.xcworkspace in Xcode
[ ] Signing & Capabilities → + Push Notifications
[ ] Signing & Capabilities → team = your team
[ ] Build to real iPhone — verify APNs registration NSLog appears
[ ] Click "Fire test push" on /admin/calendar — verify system notification
[ ] Archive → Distribute → App Store Connect
[ ] App Store Connect → App Privacy — paste section 4
[ ] Age Rating — 4+ (no objectionable content)
[ ] Demo account — paste section 7
[ ] App Review notes — paste section 8
[ ] Screenshots — section 3 dimensions captured
[ ] Account deletion URL — https://edusupervise.ashbi.ca/account/delete (Option A shipped; full 30-day soft + hard-delete flow live)
[ ] Submit for Review
```

