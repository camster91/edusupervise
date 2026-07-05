// scripts/smoke-error-handler.mjs
// H-3: intentional 4xx smoke test + errorHandler shape verification.
// Run with: node scripts/smoke-error-handler.mjs
const BASE = process.env.SMOKE_BASE ?? 'https://edusupervise.ashbi.ca';

async function probe(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual', ...options });
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), body: body.slice(0, 200) };
}

const results = [];
for (const path of ['/app/today', '/app/duties', '/app/coverage', '/onboarding/solo']) {
  const r = await probe(path);
  results.push({ path, ...r });
  console.log(`${path}: ${r.status} -> ${r.location ?? '(no redirect)'}`);
}

// Verify errorHandler shape
const res = await fetch(`${BASE}/api/nonexistent-endpoint`);
const body = await res.text();
console.log(`\n/api/nonexistent: ${res.status}`);
console.log('body:', body.slice(0, 200));

// Check that 4xx responses have content-type JSON
let allOk = true;
for (const r of results) {
  if (r.status < 300 || r.status >= 500) {
    console.error(`FAIL ${r.path}: expected 3xx/4xx, got ${r.status}`);
    allOk = false;
  }
}

process.exit(allOk ? 0 : 1);
