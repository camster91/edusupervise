/**
 * Vitest setup — runs once before any test file is loaded.
 *
 * We pin the email/sms mock log paths to a per-run temp directory so that
 * (a) tests don't try to write to /data/mocks (which may not exist in CI),
 * and (b) test runs don't accumulate state between runs.
 *
 * The mock adapter code reads process.env.{EMAIL,SMS}_MOCK_LOG_PATH at module
 * load time, so this MUST be set before any source module is imported.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'edusupervise-mocks-'));
process.env.EMAIL_MOCK_LOG_PATH = join(base, 'emails.log');
process.env.SMS_MOCK_LOG_PATH = join(base, 'sms.log');
process.env.EMAIL_PROVIDER = 'mock';
process.env.SMS_PROVIDER = 'mock';
process.env.BILLING_PROVIDER = 'mock';

// Stash for tests that want to assert on the path.
(globalThis as unknown as { __MOCK_DIR__: string }).__MOCK_DIR__ = base;