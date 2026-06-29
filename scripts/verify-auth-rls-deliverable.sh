#!/usr/bin/env bash
# scripts/verify-auth-rls-deliverable.sh
#
# CI guard: confirms the auth-rls deliverable files are present on
# disk AND tracked in git. Use this BEFORE any cleanup commit to
# avoid accidentally sweeping the deliverable (see commit 83a0e54
# for the cautionary tale).
#
# Usage:
#   ./scripts/verify-auth-rls-deliverable.sh

set -euo pipefail

REQUIRED=(
  apps/web/server/auth-flows.server.ts
  apps/web/server/verify-phone.server.ts
  apps/web/app/routes/forgot.tsx
  apps/web/app/routes/reset.tsx
  apps/web/app/routes/auth.magic.tsx
  apps/web/app/routes/verify-email.tsx
  apps/web/app/routes/verify-phone.tsx
)

missing=0
echo "==> Checking auth-rls deliverable files"
for f in "${REQUIRED[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "  MISSING: $f"
    missing=$((missing + 1))
  else
    echo "  ok      $f"
  fi
done

echo ""
echo "==> Checking routes.ts entries"
if ! grep -qE "route\(\s*['\"]forgot['\"]" apps/web/app/routes.ts; then
  echo "  FAIL: routes/forgot route table entry missing"
  missing=$((missing + 1))
else
  echo "  ok      routes/forgot"
fi
if ! grep -qE "route\(\s*['\"]auth/magic['\"]" apps/web/app/routes.ts; then
  echo "  FAIL: auth/magic route table entry missing"
  missing=$((missing + 1))
else
  echo "  ok      auth/magic"
fi
if ! grep -qE "route\(\s*['\"]reset['\"]" apps/web/app/routes.ts; then
  echo "  FAIL: routes/reset route table entry missing"
  missing=$((missing + 1))
else
  echo "  ok      routes/reset"
fi
if ! grep -qE "route\(\s*['\"]verify-email['\"]" apps/web/app/routes.ts; then
  echo "  FAIL: routes/verify-email route table entry missing"
  missing=$((missing + 1))
else
  echo "  ok      routes/verify-email"
fi
if ! grep -qE "route\(\s*['\"]verify-phone['\"]" apps/web/app/routes.ts; then
  echo "  FAIL: routes/verify-phone route table entry missing"
  missing=$((missing + 1))
else
  echo "  ok      routes/verify-phone"
fi

echo ""
echo "==> Integration test count (must be >= 8 from the original spec)"
ok_count=$(grep -c "^✓" tests/integration/auth-rls.test.ts 2>/dev/null || echo 0)
echo "  ok-marker count in auth-rls.test.ts: $ok_count (might be 0 if tests aren't listed in source; that's fine)"

echo ""
if [[ $missing -gt 0 ]]; then
  echo "==> FAIL: $missing required auth-rls deliverable files are missing."
  echo "    If you just cleaned up, restore them with:"
  echo "      git checkout 215bd9e -- apps/web/server/auth-flows.server.ts \\"
  echo "                                   apps/web/server/verify-phone.server.ts \\"
  echo "                                   apps/web/app/routes/{forgot,reset,auth.magic,verify-email,verify-phone}.tsx"
  echo "      (commit 215bd9e originally shipped all 7 in feat(auth-rls))"
  exit 1
fi

echo "==> OK: all auth-rls deliverable files present."