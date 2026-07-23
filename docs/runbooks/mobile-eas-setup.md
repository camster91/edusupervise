# Mobile EAS Build — First-Time Setup

Step-by-step for Cameron. Goal: get a green EAS Build for iOS TestFlight
+ Android internal track, wired up to CI. Read once, follow top to bottom,
expect 1-2 days total (Apple approval is the slowest step).

**Do steps 1 + 2 today in parallel** — Apple account approval blocks iOS,
but the Play Console + EAS account can move forward immediately. You can
ship Android v1 first if iOS is still pending (see spec §10 R1).

---

## TL;DR (one screen of truth)

1. Apple Developer account — sign up at developer.apple.com ($99/yr, 24-48h
   approval wait).
2. Google Play Console — sign up at play.google.com/console ($25 one-time,
   instant).
3. Expo / EAS account — sign up at expo.dev (free, instant).
4. Link EAS to the `edusupervise-mobile` project (`apps/mobile/`).
5. Configure 3 GitHub secrets + 2 EAS secrets (listed in §4).
6. First build: `eas build --platform ios --profile development` from
   `apps/mobile/`. Expect 1-3 fix-up cycles (see §6).
7. Push a tag to trigger the production pipeline end-to-end.

---

## 1. Apple Developer account (P0 blocker for iOS)

**Cost:** $99 USD/year, charged to a personal or business Apple ID.
**Lead time:** 24-48 hours for Apple to approve a new account.
**URL:** https://developer.apple.com/account

1. Sign in with the Apple ID you want to own the team.
2. Enroll in the Apple Developer Program (individual or organization —
   pick organization if EduSupervise will ever sell to schools under
   that entity; you can migrate later but it is paperwork).
3. Wait for the approval email. If Apple asks for verification
   documents (D-U-N-S number for organizations), respond same day —
   silence extends the wait.
4. Once approved, grab your **Team ID** (10-character alphanumeric
   string, e.g. `A1B2C3D4E5`):
   - https://developer.apple.com/account → Membership → Team ID.
   - Save it — you will paste it into EAS + GitHub secrets (§4).
5. **App Store Connect** (separate login, uses the same Apple ID):
   - https://appstoreconnect.apple.com
   - My Apps → `+` → New App → name "EduSupervise", bundle ID
     `ca.ashbi.edusupervise` (must match the value in
     `apps/mobile/app.json`).
   - After creation, copy the **App Store Connect App ID** (10-digit
     number) from the App Information page. This becomes `ASC_APP_ID`.

> **Why this is slow:** Apple review is human. Start this on Day 0 of the
> sprint or the iOS side slips by 3 days (spec §10 R1).

---

## 2. Google Play Console (free, fast)

**Cost:** $25 USD one-time registration fee.
**URL:** https://play.google.com/console

1. Sign in with the Google account that owns `edusupervise.ashbi.ca`
   (or a dedicated `android@edusupervise.ashbi.ca` if you want to
   keep the deploy account separate).
2. Create app: name "EduSupervise", default language English (US).
3. Internal testing track: Testing → Internal testing → Create new
   release. Up to **100 testers** by email — add yourself and 2-3
   school admins.
4. **Service account** (required for `eas submit` from CI):
   - Setup → API access → Create new service account.
   - Follow the Google Cloud Console link → create a service account
     with the **Service Account User** role.
   - Click the service account → Keys → Add key → Create new key
     (JSON). Download the JSON — this is the only copy. Do not
     commit it.
   - Back in Play Console: Grant access → find the service account
     email → grant **Release manager** permission.

> Store the service account JSON in a password manager (1Password vault
> for EduSupervise). The runbook copies it into EAS as a file secret
> in §4.

---

## 3. Expo / EAS account (free, instant)

**URL:** https://expo.dev

1. Sign up with the GitHub account that owns the repo. This is what
   links EAS Builds to your GitHub Actions later.
2. **Personal access token** (used by CI):
   - https://expo.dev/settings/access-tokens → Create token.
   - Scope: leave default ("All currently accessible projects" +
     "Read").
   - Copy the token immediately — it shows once.
   - Save it as the `EXPO_TOKEN` GitHub secret (§4).
3. **Create the EAS project** (one-time, after `apps/mobile/package.json`
   lands from slice A):
   ```bash
   cd apps/mobile
   npx eas-cli login                    # browser-based OAuth
   npx eas-cli init                     # creates project on EAS, links it
   ```
   The `init` command writes a `projectId` into `app.json` — commit
   that. The same `projectId` is what you reference in EAS secrets.

4. **Fallback if `eas init` cannot run interactively (Path B).** If
   you are fully headless / behind a non-interactive CI and cannot
   run `eas init` yourself, do this instead:
   1. In https://expo.dev, click **+ Create new project**, name it
      "EduSupervise" (matching the slug in `app.json#expo.slug`).
   2. Copy the project UUID from the project URL.
   3. Add it as the `EAS_PROJECT_ID` GitHub secret (see §4.1) AND
      paste it into `apps/mobile/app.json#extra.eas.projectId`. Both
      must match — EAS CLI prefers the env var, falls back to
      `app.json`.
   4. Skip steps 3.1 and 3.2 above (`eas login` / `eas init`) — the
      workflow now finds the project via the env var + app.json combo.
   5. **Do not** skip the `eas init` step unless you have to. Path A
      keeps `app.json` deterministic (the project ID is committed
      alongside the code), so anyone cloning the repo can run
      `eas build` locally without extra setup. Path B requires the
      GH secret to exist for every checkout (a portable clone will
      not build).

---

## 4. Secrets to configure (the only careful part)

Two layers: **GitHub secrets** (for the CI workflow) and **EAS
secrets** (for build + submit on the EAS cloud). Keep them in sync.

### 4.1 GitHub repository secrets

Repo → Settings → Secrets and variables → Actions → New repository
secret. Required for Path A (default):

| Secret name | Source | What it is |
|-------------|--------|------------|
| `EXPO_TOKEN` | https://expo.dev/settings/access-tokens | Expo personal access token from §3.2 |
| `EAS_BUILD_APPLE_TEAM_ID` | https://developer.apple.com/account | 10-char Apple Team ID from §1.4 |
| `ASC_APP_ID` | https://appstoreconnect.apple.com | 10-digit App Store Connect App ID from §1.5 |
| (Play JSON) | n/a | **Not** a GitHub secret — uploaded as an EAS file secret in §4.2 |

Plus this one **only if** you go with Path B (see §3.4):

| Secret name | Source | What it is |
|-------------|--------|------------|
| `EAS_PROJECT_ID` | EAS dashboard | The EAS project UUID. Normally EAS CLI reads this from `app.json#extra.eas.projectId` (written by `eas init` in §3.3). Setting it as a GH secret + env var override is Path B's fallback. |

### 4.2 EAS project secrets

From the repo root (or `apps/mobile/`, EAS will resolve either way):

```bash
# ASC numeric ID (string secret)
eas env:create \
  --name ASC_APP_ID \
  --value "1234567890" \
  --environment production \
  --visibility project \
  --type string

# Google Play service account JSON (file secret — paste path to your
# downloaded .json)
eas env:create \
  --name GOOGLE_SERVICE_ACCOUNT_KEY_PATH \
  --value /path/to/play-service-account.json \
  --environment production \
  --visibility project \
  --type file

# Optional: override the API base URL per environment.
# Default in eas.json already points to prod; only set this if you
# want preview to hit staging.
eas env:create \
  --name EXPO_PUBLIC_API_BASE_URL \
  --value "https://edusupervise.ashbi.ca" \
  --environment preview \
  --visibility project \
  --type string
```

The EAS cloud will materialize the file secret to a path on the
build machine; `eas.json` references it via `${env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH}`.

> **Why both layers?** EAS secrets are tied to the EAS project (one
> per app) and are not portable to other CI. GitHub secrets are the
> single source of truth for the workflow. The EAS secrets here are
> only needed for `eas submit` at submit-time; the build itself reads
> them from `eas.json`'s env interpolation.

---

## 5. First build — verification

After all secrets are in place, run from `apps/mobile/`:

```bash
# 1. config dry-run (no build, no upload)
npx eas-cli config --non-interactive

# 2. dev client build (TestFlight / internal track NOT touched)
npx eas-cli build --platform ios --profile development --non-interactive
npx eas-cli build --platform android --profile development --non-interactive

# 3. preview build (TestFlight / Play internal — the real release-ready
#    binary, no store submit)
npx eas-cli build --platform ios --profile preview --non-interactive
npx eas-cli build --platform android --profile preview --non-interactive

# 4. promote a successful preview to production
#    Only after you have dogfooded it on TestFlight + Play internal.
git tag v0.1.0
git push --tags
```

`eas build` runs asynchronously in Expo's cloud and prints a build
URL. Open that URL in a browser to track progress and download the
artifact when it finishes.

> **Do not run `--auto-submit` until a preview build has been
> installed and used by at least one tester.** Store submit is
> irreversible in some places (Apple in particular is slow to
> recall a bad build).

---

## 6. First-build troubleshooting (spec §10 R2)

Expect 1-3 failed iOS builds on the first day. Common causes and fixes:

| Symptom | Cause | Fix |
|---------|-------|-----|
| `No bundle identifier registered` | Bundle ID not yet created in App Store Connect | Create the app in App Store Connect first (§1.5), then retry |
| `Provisioning profile not found` | EAS could not auto-generate one | Run `eas credentials` to manually upload an Apple Distribution certificate, OR let EAS generate one (it usually does on first run) |
| `Your account does not have permission` | Apple Team ID is wrong, or Apple ID is not enrolled | Re-check Team ID in developer.apple.com/account; ensure the Apple ID you used to log into EAS is the team agent or has App Manager role |
| `Missing compliance info` (iOS) | App uses encryption but Info.plist does not declare it | Add `ITSAppUsesNonExemptEncryption: false` to `app.json`'s `ios.infoPlist` |
| `Asset validation failed` (Play) | Service account JSON missing or wrong permissions | Re-check §2.4 — the service account needs Release manager role in Play Console |
| `Build timed out after 30 min` | Network or Expo queueing issue | Retry; if it persists, check https://status.expo.dev |

For deeper issues, the EAS build log URL is the entry point — copy
the URL from the `eas build` output, open in browser, scroll to the
failed step. 90% of first-build failures are visible in the first
100 lines of the log.

> If the iOS build keeps failing, ship Android v1 first per the spec
> §10 R1 mitigation. Do not block the whole sprint on it.

---

## 7. OTA updates (bonus, not blocking v1)

EAS Managed supports over-the-air JS updates via `expo-updates`. When
wired in (post-v1):

```bash
# Push a JS-only bug fix to all preview users, no store review
eas update --branch preview --message "Fix duty card alignment"
```

For v1, this is **not** required. Ship the app-store release as the
v1 cut, then add `expo-updates` to `apps/mobile/package.json` and run
`eas update:configure` to wire it up. The EAS Build pipeline
(`.github/workflows/mobile-eas.yml`) does not need to change for
OTA.

---

## 8. Privacy nutrition labels (App Store Connect, post-build)

Per spec §12. Configure these in App Store Connect → My Apps →
EduSupervise → App Privacy:

- **Identifiers → User ID**
  - Purpose: App functionality
  - Linked to user: Yes
  - Used for tracking: No
  - Examples: The Expo push token. Used to deliver duty-reminder
    pushes to the correct device.

- **Contact Info → Email Address**
  - Purpose: App functionality
  - Linked to user: Yes
  - Used for tracking: No
  - Examples: The teacher's login email. Used for sign-in only; not
    shared.

**No** other categories apply. We do not collect:
- Location (no GPS, no IP geolocation beyond what the API stores for
  audit).
- Usage data or analytics.
- Diagnostics.
- Purchases (no in-app purchases; billing is web-only).
- Contacts, photos, files.

**Do not** check "Yes" on "Data Used to Track You" for any category.
There is no third-party SDK on the device, so this must remain off.

---

## 9. Reference

- Expo EAS Build docs: https://docs.expo.dev/build/introduction/
- EAS Submit docs: https://docs.expo.dev/submit/introduction/
- eas.json schema: https://docs.expo.dev/eas/json/
- Apple Developer Program: https://developer.apple.com/programs/enroll/
- Google Play Console: https://play.google.com/console
- Spec §9 (build/ship pipeline): `docs/superpowers/specs/2026-07-06-edusupervise-mobile-mvp.md:577-639`
- Spec §10 R1 + R2 (Apple account lead time, first-build failures): spec lines 645-665
- Spec §12 (privacy labels): spec lines 745-750
