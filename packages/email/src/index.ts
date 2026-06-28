/**
 * Email provider adapter.
 *
 * Routes sendEmail() to either the mock implementation (default) or the real
 * Resend SDK based on the EMAIL_PROVIDER env var. Both impls return the same
 * shape: { providerId: string, status: 'sent' | 'queued' }.
 *
 * - mock:    logs { to, subject, body } to stdout (pino structured log) AND
 *            appends a JSON line to /data/mocks/emails.log. Returns
 *            { providerId: 'mock-<uuid>', status: 'sent' }.
 * - resend:  uses the Resend Node SDK to send via the Resend HTTP API.
 *            Requires RESEND_API_KEY. Without it, fails fast with a clear error
 *            so misconfigured prod deploys surface immediately.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resend } from 'resend';
import { pino } from 'pino';

const logger = pino({
  name: '@edusupervise/email',
  level: process.env.LOG_LEVEL ?? 'info',
});

export type EmailProvider = 'mock' | 'resend';

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  /** Optional pre-rendered HTML body. If omitted, the caller should have rendered
   * a template themselves. The mock impl just logs; the real impl forwards. */
  html?: string;
  /** Optional reply-to address (real impl only). */
  replyTo?: string;
}

export interface SendEmailResult {
  providerId: string;
  status: 'sent' | 'queued';
}

// ---------------------------------------------------------------------------
// Mock log file location
// ---------------------------------------------------------------------------

const MOCK_LOG_PATH =
  process.env.EMAIL_MOCK_LOG_PATH ?? '/data/mocks/emails.log';

/**
 * Append a single JSON line to the mock email log. Creates the parent dir on
 * first write so a fresh dev environment works without manual setup.
 */
async function appendMockLog(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(MOCK_LOG_PATH), { recursive: true });
    await appendFile(MOCK_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    // Mock log failure is non-fatal — log to stderr but do not break the call.
    logger.error({ err, path: MOCK_LOG_PATH }, 'failed to append to mock email log');
  }
}

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------

async function sendMock(input: SendEmailInput): Promise<SendEmailResult> {
  const providerId = `mock-${randomUUID()}`;
  const entry = {
    providerId,
    timestamp: new Date().toISOString(),
    to: input.to,
    subject: input.subject,
    body: input.body,
    html: input.html ?? null,
  };

  logger.info({ providerId, to: input.to, subject: input.subject }, 'mock email sent');
  await appendMockLog(entry);

  return { providerId, status: 'sent' };
}

// ---------------------------------------------------------------------------
// Resend implementation
// ---------------------------------------------------------------------------

let _resend: Resend | null = null;
function getResendClient(): Resend {
  if (_resend) return _resend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY required when EMAIL_PROVIDER=resend');
  }
  _resend = new Resend(apiKey);
  return _resend;
}

function getFromEmail(): string {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error('RESEND_FROM_EMAIL required when EMAIL_PROVIDER=resend');
  }
  return from;
}

interface ResendSendResult {
  id: string;
}
interface ResendError {
  message?: string;
  name?: string;
}
interface ResendSendResponse {
  data: ResendSendResult | null;
  error: ResendError | null;
}

async function sendResend(input: SendEmailInput): Promise<SendEmailResult> {
  const client = getResendClient();
  const from = getFromEmail();

  const response = (await client.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    text: input.body,
    html: input.html,
    replyTo: input.replyTo,
  })) as unknown as ResendSendResponse;

  if (response.error || !response.data) {
    const message = response.error?.message ?? 'unknown Resend error';
    throw new Error(`Resend send failed: ${message}`);
  }

  return { providerId: response.data.id, status: 'sent' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function resolveProvider(): EmailProvider {
  const raw = (process.env.EMAIL_PROVIDER ?? 'mock').toLowerCase();
  if (raw === 'mock' || raw === 'resend') return raw;
  // Unknown provider is a hard error — better than silently sending via mock in prod.
  throw new Error(
    `Unknown EMAIL_PROVIDER: ${process.env.EMAIL_PROVIDER} (expected 'mock' or 'resend')`,
  );
}

/**
 * Send an email via the configured provider (mock or resend).
 *
 * - Mock: returns immediately with a mock providerId; logs + appends to file.
 * - Resend: hits the Resend API; throws on transport failure.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!input.to) throw new Error('sendEmail: `to` is required');
  if (!input.subject) throw new Error('sendEmail: `subject` is required');
  if (!input.body && !input.html) {
    throw new Error('sendEmail: either `body` or `html` is required');
  }

  const provider = resolveProvider();
  return provider === 'mock' ? sendMock(input) : sendResend(input);
}

/**
 * Exposed for tests + observability: which provider will the next sendEmail()
 * call use, given current env.
 */
export function currentProvider(): EmailProvider {
  return resolveProvider();
}

// Re-export mock log path so the test can pin expectations.
export const __testing__ = { MOCK_LOG_PATH };

// Resolve package root so relative template imports work from compiled dist.
const packageRoot = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.cwd(), 'packages/email/src');
  }
})();

export const packageRootPath = packageRoot;