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

## 9. Push notifications (Phase 2 — not yet wired)

Currently `apps/web/server/push.server.ts` is a stub. Phase 2 will:
1. Add `@capacitor/push-notifications` plugin (already installed via
   `@capacitor/ios` core)
2. Server-side: APNs JWT client using the `.p8` auth key from step 1
3. Web-side: real Web Push implementation using VAPID keys
4. iOS-side: register APNs device token, forward to server
5. Server-side: dispatch to whichever subscriptions the user has

When that's wired, the deep-link URL scheme `edusupervise://duty/<id>`
(configured in Info.plist) becomes the bridge — taps on a push
notification open the app at the specific duty page.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pod install` complains about Ruby version | macOS system Ruby is too old | `brew install ruby && gem install cocoapods` |
| `Bundle identifier is not available` in Xcode | ID conflict on your Apple Team | Pick a different reverse-DNS, update `capacitor.config.ts#appId` |
| App Store Connect says "Missing compliance" | You didn't declare export compliance | In App Store Connect, answer "No exempt encryption" in the version page |
| Splash is white | Splash.imageset not loading | Confirm `Splash.imageset/Contents.json` references the `splash-2732x2732*.png` files |
| WKWebView shows blank white | Server-side error blocking initial render | Open Safari, navigate to `https://edusupervise.ashbi.ca` directly — if that works, the iOS app will too |
| Apple rejects as "minimal value" | "Just a web wrapper" risk | Push notifications + native splash + camera/PDF access via webkit are usually enough; add `@capacitor/push-notifications` early to anchor native value |