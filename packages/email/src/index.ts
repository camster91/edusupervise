/**
 * Email provider adapter.
 *
 * Routes sendEmail() to one of three backends based on EMAIL_PROVIDER:
 *   - mock:    logs + appends to /data/mocks/emails.log. Returns a fake ID.
 *   - resend:  Resend HTTP API (RESEND_API_KEY + RESEND_FROM_EMAIL).
 *   - mailgun: Mailgun HTTP API (MAILGUN_API_KEY + MAILGUN_DOMAIN +
 *              MAILGUN_FROM_EMAIL). Basic-auth over HTTPS.
 *
 * All three return the same shape: { providerId, status }.
 *
 * Why Mailgun: cheaper at low-volume tier, ashbi.ca domain already
 * verified there for the broader Ashbi stack. Reuses the same
 * `sendEmail()` interface as Resend so the worker's reminder
 * processor doesn't care which backend is wired.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resend } from 'resend';
import { pinoLike } from './logger.js';

const logger = pinoLike({
  name: '@edusupervise/email',
  level: process.env.LOG_LEVEL ?? 'info',
});

export type EmailProvider = 'mock' | 'resend' | 'mailgun';

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
// Mailgun implementation
// ---------------------------------------------------------------------------

interface MailgunSendResponse {
  id?: string;
  message?: string;
}

interface MailgunErrorResponse {
  message?: string;
}

/**
 * Mailgun's REST API uses HTTP Basic auth. Per their docs the username
 * is always `api` and the password is the private API key. The domain
 * is part of the URL path. We POST form-encoded data to
 * https://api.mailgun.net/v3/{domain}/messages and the response
 * includes `{ id: "<message-id>", message: "Queued. ..." }`.
 *
 * Uses the global `fetch` (Node 24 has it built-in) so we don't pull
 * in a HTTP client library.
 */
async function sendMailgun(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.MAILGUN_FROM_EMAIL;
  if (!apiKey) throw new Error('MAILGUN_API_KEY required when EMAIL_PROVIDER=mailgun');
  if (!domain) throw new Error('MAILGUN_DOMAIN required when EMAIL_PROVIDER=mailgun');
  if (!from) throw new Error('MAILGUN_FROM_EMAIL required when EMAIL_PROVIDER=mailgun');

  // Region: Mailgun US is api.mailgun.net; EU is api.eu.mailgun.net.
  // Pick based on MAILGUN_REGION env (default 'us').
  const region = (process.env.MAILGUN_REGION ?? 'us').toLowerCase();
  const base = region === 'eu'
    ? `https://api.eu.mailgun.net/v3/${domain}`
    : `https://api.mailgun.net/v3/${domain}`;

  const params = new URLSearchParams();
  params.set('from', from);
  params.set('to', input.to);
  params.set('subject', input.subject);
  if (input.body) params.set('text', input.body);
  if (input.html) params.set('html', input.html);
  if (input.replyTo) params.set('h:Reply-To', input.replyTo);

  const auth = Buffer.from(`api:${apiKey}`).toString('base64');

  let res: Response;
  try {
    res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Mailgun transport failed: ${msg}`);
  }

  const responseText = await res.text();
  let json: MailgunSendResponse | MailgunErrorResponse | null = null;
  try { json = JSON.parse(responseText); } catch { /* not JSON */ }

  if (!res.ok) {
    const errMsg = (json as MailgunErrorResponse | null)?.message ?? responseText.slice(0, 200);
    throw new Error(`Mailgun send failed (${res.status}): ${errMsg}`);
  }

  const providerId = (json as MailgunSendResponse | null)?.id ?? `mailgun-${randomUUID()}`;
  logger.info({ providerId, to: input.to, subject: input.subject, domain }, 'mailgun email sent');
  return { providerId, status: 'sent' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function resolveProvider(): EmailProvider {
  const raw = (process.env.EMAIL_PROVIDER ?? 'mock').toLowerCase();
  if (raw === 'mock' || raw === 'resend' || raw === 'mailgun') return raw;
  throw new Error(
    `Unknown EMAIL_PROVIDER: ${process.env.EMAIL_PROVIDER} (expected 'mock', 'resend', or 'mailgun')`,
  );
}

/**
 * Send an email via the configured provider.
 *
 * - Mock: returns immediately with a mock providerId; logs + appends to file.
 * - Resend: hits the Resend HTTP API.
 * - Mailgun: hits the Mailgun HTTP API.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!input.to) throw new Error('sendEmail: `to` is required');
  if (!input.subject) throw new Error('sendEmail: `subject` is required');
  if (!input.body && !input.html) {
    throw new Error('sendEmail: either `body` or `html` is required');
  }

  const provider = resolveProvider();
  if (provider === 'mock') return sendMock(input);
  if (provider === 'resend') return sendResend(input);
  return sendMailgun(input);
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