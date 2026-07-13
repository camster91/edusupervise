# Building & shipping EduSupervise to iOS (Capacitor)

This document covers the **Mac-side** steps to take a freshly-cloned repo
with the iOS scaffold (this commit) and turn it into a TestFlight build,
then a live App Store listing.

The scaffold (Capacitor config, Info.plist, app icons, splash, .gitignore)
is fully wired in this repo. What's missing is anything that requires
Apple tooling — Xcode project signing, App Store Connect metadata, the
APNs `.p8` auth key, and `pod install` (CocoaPods).

---

## 1. Prerequisites (one-time)

| Tool | Where | Notes |
|---|---|---|
| **Full Xcode** (not just CommandLineTools) | App Store → "Xcode" | `xcodebuild` alone is not enough — you need the IDE, iOS SDK, simulators, codesign. ~15GB. |
| **CocoaPods** | `sudo gem install cocoapods` | Needed by `cap sync` and Xcode build to resolve `@capacitor/*` pods. |
| **Apple Developer Program** ($99/yr) | https://developer.apple.com/programs/ | Bundle IDs + code signing + TestFlight + App Store Connect. |
| **App Store Connect entry** | https://appstoreconnect.apple.com | Create the app record manually (name, bundle ID, primary locale). |
| **APNs auth key (`.p8`)** | App Store Connect → Certificates, Identifiers & Profiles → Keys | Needed for push notifications (Phase 2). Generate once, keep safe. |

Confirm with:

```bash
xcodebuild -version            # should print Xcode 16.x or newer
pod --version                  # should print 1.15.x or newer
xcrun simctl list devices booted  # should NOT error with "simctl not found"
```

---

## 2. Build the web app (one-time per release)

The iOS shell loads `https://edusupervise.ashbi.ca` at runtime, so the
web app on the VPS is the source of truth. But for offline / TestFlight
review you should also build the bundle locally so `cap sync` has
something to copy into `ios/App/App/public/`.

```bash
pnpm install
pnpm --filter @edusupervise/db --filter @edusupervise/schemas build
pnpm --filter @edusupervise/web build       # outputs apps/web/build/client
```

This step is **only required** if you ever set `server.url` to undefined
in `capacitor.config.ts`. With `server.url` set (current config), the
VPS-hosted web app is what users see — the local build is just a
fallback asset bundle.

---

## 3. Sync Capacitor + install pods

```bash
npx cap sync ios                 # copies web assets, updates plugins, runs pod install
```

If `pod install` errors, fix with:

```bash
cd ios/App && pod install --repo-update && cd ../..
```

---

## 4. Open the Xcode project

```bash
open ios/App/App.xcworkspace     # ALWAYS .xcworkspace, never .xcodeproj
```

Xcode opens. In the project navigator:
1. Select the **App** target.
2. **Signing & Capabilities** tab → check **Automatically manage signing**.
3. Pick your **Team** (Apple Developer Program).
4. The Bundle ID should already be `ca.ashbi.edusupervise`. If Xcode
   says "Bundle identifier is not available", it conflicts with another
   app under your Team — pick a different ID and update
   `capacitor.config.ts#appId` to match.

---

## 5. Build to a simulator (smoke test)

Pick any iPhone simulator (e.g. iPhone 15 Pro) → ⌘R.

Expected:
- App launches, shows the blue "EduSupervise" splash, then loads
  `https://edusupervise.ashbi.ca` in the WKWebView.
- Try logging in. Session cookies persist across app restarts (because
  the WKWebView shares the system cookie store).
- Try uploading a calendar PDF (the route you fixed today). It should
  succeed without a CSRF 403.

If anything 500s in the WKWebView, look at `xcrun simctl spawn booted log stream --level debug`
to see network logs.

---

## 6. Build for TestFlight

In Xcode:
1. Select **Any iOS Device (arm64)** as the destination.
2. **Product → Archive**.
3. Once the archive finishes, the Organizer window opens.
4. **Distribute App → App Store Connect → Upload**.
5. Wait ~10-30 min for processing. App Store Connect → TestFlight tab
   should show the build ready for internal testing.

Add yourself (and any internal testers) to TestFlight in App Store
Connect → Users and Access. Test the app on a real iPhone.

---

## 7. App Store submission

App Store Connect → My Apps → EduSupervise → the version:

1. **Version**: e.g. `1.0.0` (must match `MARKETING_VERSION` in Xcode build settings)
2. **Build**: pick the TestFlight build from step 6
3. **App information**:
   - Name: EduSupervise
   - Subtitle: "Duty scheduling for K-12 schools"
   - Category: Education
   - Content rights: own everything
4. **Pricing**: free
5. **App Privacy**: link to privacy policy URL (you'll need to publish one)
6. **Screenshots** (required):
   - 6.7" iPhone (iPhone 15 Pro Max): at least 3
   - 6.5" iPhone (iPhone 11 Pro Max): at least 3
   - 12.9" iPad Pro: at least 3 (if iPad supported)
   - Use `xcrun simctl io booted screenshot` after staging the app
7. **Description / keywords / support URL / marketing URL**: fill in
8. **Build**: pick the build
9. **Export compliance**: declare "no exempt encryption"
10. **Submit for review**

Apple's review typically takes 24-48 hours.

---

## 8. Iterating after App Store approval

When you ship a new web build, the iOS app picks it up automatically
(because `server.url` points to the live domain). No TestFlight re-submit
needed for web-only changes.

When you ship a new **native** change (Info.plist, icons, push plugin,
etc.):
1. Update `capacitor.config.ts` or iOS files
2. Bump `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in Xcode
3. Re-archive → TestFlight → App Store submission

---

## 9. Push notifications (Phase 2 — code shipped, .p8 key pending)

**Current state.** Both push channels are wired and the dispatcher
fans out in parallel:

- **Web Push** (browser / Safari PWA): VAPID keys generated and
  loaded into the web container. `apps/web/server/push.server.ts`
  sends via the `web-push` library; the service worker
  (`apps/web/public/sw.js`) handles the push event + notification
  click.
- **APNs** (iOS app): hand-rolled `apps/web/server/apns.server.ts`
  using `node:http2` + ES256 JWT signed with the .p8 auth key. iOS
  registers the device token via `ios/App/App/AppDelegate.swift`
  `registerForRemoteNotifications()` and forwards to the server
  through the Capacitor push plugin.

The dispatcher is real and tested (11/11 Vitest cases in
`apps/web/server/push.server.test.ts`). It returns graceful
no-ops (`reason: 'auth-failed'`) until the .p8 is wired — no
crashes, no broken rows.

**What's blocking live iOS delivery.** Cameron needs to provision
the APNs auth key in App Store Connect and paste it into
`/root/edusupervise-secrets/.env`. Five env vars total
(`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_KEY_P8`,
`APNS_ENV`) — first two are 10-char IDs from App Store Connect,
third is the iOS bundle ID (already set to `ca.ashbi.edusupervise`),
fourth is the PEM contents of the .p8, fifth defaults to
`production`.

### 9.1 Generate the .p8 in App Store Connect (10 min)

1. Open https://appstoreconnect.apple.com → **Users and Access** →
   **Keys** tab → **App Store Connect API** or **Apple Push
   Notifications authentication keys (Sandbox & Production)** →
   click the **+** button.
2. Name it `edusupervise-prod` (descriptive — you can't see the
   name again after generation).
3. Leave the access checkbox ON (you need it for push auth).
4. Click **Generate**. Download the `.p8` file. **Apple only
   shows the download button once** — save it somewhere safe
   (1Password, encrypted volume, your password manager).
5. Note the **Key ID** (10 chars, top-right of the key row) and
   your **Team ID** (10 chars, top-right of the membership page
   — https://developer.apple.com/account → Membership details).

### 9.2 Land the .p8 on the VPS

```bash
# On your Mac:
scp ~/Downloads/AuthKey_ABCDE12345.p8 root@vps.ashbi.ca:/root/apns-keys/

# On the VPS — mkdir + chmod 700 BEFORE scp so the destination exists
# with the right perms. sshd auto-creates the parent dir but with
# default mode 755; explicit mkdir + chmod 700 makes the intent obvious
# and avoids surprise permissions for non-sshd-experienced operators:
mkdir -p /root/apns-keys
chmod 700 /root/apns-keys
# Now set the .p8 to owner-only read+write:
chmod 600 /root/apns-keys/AuthKey_*.p8
ls -la /root/apns-keys/
```

The file goes to `/root/apns-keys/` (offline backup — never read
by the app at runtime; the app reads the PEM contents from the
env file instead, so a restart-with-fresh-env doesn't need the
.p8 file present).

### 9.3 Wire the env vars

```bash
ssh root@vps.ashbi.ca
vim /root/edusupervise-secrets/.env
```

Replace the five empty `APNS_*` lines at the bottom with real
values. The PEM contents go on one line, escaped with `\n` where
there are line breaks in the actual file:

```
APNS_KEY_ID=ABCDE12345
APNS_TEAM_ID=1234567890
APNS_BUNDLE_ID=ca.ashbi.edusupervise
APNS_KEY_P8="-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg...\n-----END PRIVATE KEY-----"
APNS_ENV=production
```

(The PEM is long — ~300 chars. Multi-line pasted PEMs also work;
the dispatcher uses `process.env.APNS_KEY_P8.replace(/\\n/g, '\n')`
to handle both shapes.)

### 9.4 Rebuild and verify

```bash
ssh root@vps.ashbi.ca 'cd /opt/edusupervise && \
  docker compose -f docker/docker-compose.yml -p docker up -d --build web'
ssh root@vps.ashbi.ca 'docker exec docker-web-1 printenv | grep APNS_'
```

You should see all 5 vars populated. Then send a test push from
the iOS app and watch the web container logs:

```bash
ssh root@vps.ashbi.ca 'docker logs -f docker-web-1 | grep -i apns'
```

Look for `apns.send: ok` instead of `apns.send: auth-failed`. If
you see `apns.send: gone` or `apns.send: invalid-token` after a
real device registers, the dispatcher deletes the stale row
automatically — that's the row-pruning behavior the QA swarm
verified.

### 9.5 Sandbox vs production

`APNS_ENV=sandbox` is for testing against `api.sandbox.push.apple.com`
(local simulator builds, debug-signed TestFlight). Flip to
`production` for App Store + signed TestFlight builds. Apple
production tokens are NOT accepted by the sandbox endpoint and
vice versa — keep this in sync with how the iOS app is signed.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pod install` complains about Ruby version | macOS system Ruby is too old | `brew install ruby && gem install cocoapods` |
| `Bundle identifier is not available` in Xcode | ID conflict on your Apple Team | Pick a different reverse-DNS, update `capacitor.config.ts#appId` |
| App Store Connect says "Missing compliance" | You didn't declare export compliance | In App Store Connect, answer "No exempt encryption" in the version page |
| Splash is white | Splash.imageset not loading | Confirm `Splash.imageset/Contents.json` references the `splash-2732x2732*.png` files |
| WKWebView shows blank white | Server-side error blocking initial render | Open Safari, navigate to `https://edusupervise.ashbi.ca` directly — if that works, the iOS app will too |
| Apple rejects as "minimal value" | "Just a web wrapper" risk | Push notifications + native splash + camera/PDF access via webkit are usually enough; add `@capacitor/push-notifications` early to anchor native value |

## 10. App Store Pre-Flight Checklist

See `docs/APP-STORE-PREFLIGHT.md` for the complete pre-submission checklist:
App Privacy questionnaire answers, account deletion strategy, age rating
questionnaire, demo account credentials, App Review notes for the human
reviewer, screenshot dimensions, and a quick-launch checklist for the day
of submission.

The pre-flight doc was written alongside the 5 visual BLOCKER fixes
(commits cddeb5f..969d3f2) and the 5-commit HIG-token sweep
(3f9069e..7f2dd93).
