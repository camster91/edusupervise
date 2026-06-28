/**
 * SMS provider adapter.
 *
 * Routes sendSms() to either the mock implementation (default) or the real
 * Twilio SDK based on the SMS_PROVIDER env var.
 *
 * - mock:   logs { to, body } to stdout (pino) and appends a JSON line to
 *           /data/mocks/sms.log. Returns { providerId: 'mock-<uuid>',
 *           status: 'sent' }.
 * - twilio: uses the twilio Node SDK. Requires TWILIO_ACCOUNT_SID,
 *           TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER. Without them, fails fast.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pino } from 'pino';

const logger = pino({
  name: '@edusupervise/sms',
  level: process.env.LOG_LEVEL ?? 'info',
});

export type SmsProvider = 'mock' | 'twilio';

export interface SendSmsInput {
  to: string;
  body: string;
}

export interface SendSmsResult {
  providerId: string;
  status: 'sent' | 'queued';
}

const MOCK_LOG_PATH =
  process.env.SMS_MOCK_LOG_PATH ?? '/data/mocks/sms.log';

async function appendMockLog(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(MOCK_LOG_PATH), { recursive: true });
    await appendFile(MOCK_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    logger.error({ err, path: MOCK_LOG_PATH }, 'failed to append to mock sms log');
  }
}

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------

async function sendMock(input: SendSmsInput): Promise<SendSmsResult> {
  const providerId = `mock-${randomUUID()}`;
  const entry = {
    providerId,
    timestamp: new Date().toISOString(),
    to: input.to,
    body: input.body,
  };
  logger.info({ providerId, to: input.to }, 'mock sms sent');
  await appendMockLog(entry);
  return { providerId, status: 'sent' };
}

// ---------------------------------------------------------------------------
// Twilio implementation
// ---------------------------------------------------------------------------

interface TwilioMessageInstance {
  sid: string;
  status: string;
}
interface TwilioMessagesResource {
  create(args: {
    body: string;
    to: string;
    from: string;
  }): Promise<TwilioMessageInstance>;
}
interface TwilioClient {
  messages: TwilioMessagesResource;
}

let _twilio: TwilioClient | null = null;

async function getTwilioClient(): Promise<TwilioClient> {
  if (_twilio) return _twilio;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid) throw new Error('TWILIO_ACCOUNT_SID required when SMS_PROVIDER=twilio');
  if (!token) throw new Error('TWILIO_AUTH_TOKEN required when SMS_PROVIDER=twilio');

  // Dynamic import keeps twilio out of the cold path for the mock impl.
  const mod = (await import('twilio')) as unknown as {
    default: (sid: string, token: string) => TwilioClient;
  };
  _twilio = mod.default(sid, token);
  return _twilio;
}

function getFromNumber(): string {
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) throw new Error('TWILIO_FROM_NUMBER required when SMS_PROVIDER=twilio');
  return from;
}

async function sendTwilio(input: SendSmsInput): Promise<SendSmsResult> {
  const client = await getTwilioClient();
  const from = getFromNumber();
  const message = await client.messages.create({
    body: input.body,
    to: input.to,
    from,
  });
  return { providerId: message.sid, status: 'sent' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function resolveProvider(): SmsProvider {
  const raw = (process.env.SMS_PROVIDER ?? 'mock').toLowerCase();
  if (raw === 'mock' || raw === 'twilio') return raw;
  throw new Error(
    `Unknown SMS_PROVIDER: ${process.env.SMS_PROVIDER} (expected 'mock' or 'twilio')`,
  );
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  if (!input.to) throw new Error('sendSms: `to` is required');
  if (!input.body) throw new Error('sendSms: `body` is required');

  const provider = resolveProvider();
  return provider === 'mock' ? sendMock(input) : sendTwilio(input);
}

export function currentProvider(): SmsProvider {
  return resolveProvider();
}

export const __testing__ = { MOCK_LOG_PATH };