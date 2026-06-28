/**
 * Vitest setup — see ../packages/email/vitest.setup.ts for the rationale.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'edusupervise-mocks-'));
process.env.SMS_MOCK_LOG_PATH = join(base, 'sms.log');
process.env.SMS_PROVIDER = 'mock';
(globalThis as unknown as { __MOCK_DIR__: string }).__MOCK_DIR__ = base;