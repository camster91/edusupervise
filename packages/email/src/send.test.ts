/**
 * Tests for @edusupervise/email.
 *
 * Covers:
 *  - mock impl: returns correct shape, logs to pino stdout, appends JSON line
 *    to the configured mock log file.
 *  - resend impl: throws "RESEND_API_KEY required" / "RESEND_FROM_EMAIL required"
 *    when env is unset.
 *  - resend impl: when the SDK is mocked at the test level, the wrapper
 *    forwards the right shape and returns the real providerId.
 *  - DutyReminder template: renders without throwing; subject format matches;
 *    body contains the expected fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';

import {
  sendEmail,
  currentProvider,
  __testing__ as emailTesting,
} from './index.js';
import { renderDutyReminder } from './templates/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake Resend SDK class that records calls. */
function buildFakeResend(sendImpl: ReturnType<typeof vi.fn>) {
  return {
    Resend: class FakeResend {
      emails = { send: sendImpl };
    },
  };
}

describe('email adapter — mock', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'mock';
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    rmSync(emailTesting.MOCK_LOG_PATH, { force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock('resend');
  });

  it('default provider is mock when EMAIL_PROVIDER is unset', () => {
    delete process.env.EMAIL_PROVIDER;
    expect(currentProvider()).toBe('mock');
  });

  it('sendEmail returns mock-<uuid> shape and status=sent', async () => {
    const result = await sendEmail({
      to: '[email protected]',
      subject: 'Test',
      body: 'Hello world',
    });
    expect(result.status).toBe('sent');
    expect(result.providerId).toMatch(/^mock-[0-9a-f-]{36}$/);
  });

  it('appends a JSON log line with to/subject/body', async () => {
    await sendEmail({
      to: '[email protected]',
      subject: 'Audit row',
      body: 'Body content',
    });
    const content = readFileSync(emailTesting.MOCK_LOG_PATH, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.to).toBe('[email protected]');
    expect(entry.subject).toBe('Audit row');
    expect(entry.body).toBe('Body content');
    expect(entry.providerId).toMatch(/^mock-[0-9a-f-]{36}$/);
    expect(entry.timestamp).toBeTruthy();
  });

  it('appends to the MOCK_LOG_PATH derived from EMAIL_MOCK_LOG_PATH', async () => {
    // Self-contained: call sendEmail, then read the same path the adapter
    // resolved at module load (so we exercise the env->module-value path).
    await sendEmail({
      to: '[email protected]',
      subject: 'Path check',
      body: 'body',
    });
    const content = readFileSync(emailTesting.MOCK_LOG_PATH, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).subject).toBe('Path check');
  });

  it('throws on missing required fields', async () => {
    await expect(
      sendEmail({ to: '', subject: 'x', body: 'y' }),
    ).rejects.toThrow(/`to` is required/);
    await expect(
      sendEmail({ to: '[email protected]', subject: '', body: 'y' }),
    ).rejects.toThrow(/`subject` is required/);
    await expect(
      sendEmail({ to: '[email protected]', subject: 'x', body: '' }),
    ).rejects.toThrow(/`body` or `html` is required/);
  });

  it('throws on unknown EMAIL_PROVIDER', async () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    await expect(
      sendEmail({ to: '[email protected]', subject: 'x', body: 'y' }),
    ).rejects.toThrow(/Unknown EMAIL_PROVIDER/);
  });
});

describe('email adapter — resend (env-driven failures)', () => {
  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    process.env.EMAIL_PROVIDER = 'resend';
  });

  afterEach(() => {
    process.env.EMAIL_PROVIDER = 'mock';
    vi.restoreAllMocks();
    vi.unmock('resend');
  });

  it('throws clear "RESEND_API_KEY required" when key is missing', async () => {
    await expect(
      sendEmail({
        to: '[email protected]',
        subject: 'x',
        body: 'y',
      }),
    ).rejects.toThrow(/RESEND_API_KEY required/);
  });

  it('throws clear "RESEND_FROM_EMAIL required" when key is set but from is missing', async () => {
    process.env.RESEND_API_KEY = 're_test_xxx';
    await expect(
      sendEmail({
        to: '[email protected]',
        subject: 'x',
        body: 'y',
      }),
    ).rejects.toThrow(/RESEND_FROM_EMAIL required/);
  });

  it('forwards to the Resend SDK when env is fully set', async () => {
    process.env.RESEND_API_KEY = 're_test_xxx';
    process.env.RESEND_FROM_EMAIL = '[email protected]';

    const fakeSend = vi.fn().mockResolvedValue({
      data: { id: 'resend_msg_abc123' },
      error: null,
    });
    vi.doMock('resend', () => buildFakeResend(fakeSend));

    // Dynamic re-import via vitest's resetModules+import so the doMock applies.
    vi.resetModules();
    const mod = await import(`./index.js`);
    const result = await mod.sendEmail({
      to: '[email protected]',
      subject: 'real',
      body: 'hello',
    });

    expect(result.providerId).toBe('resend_msg_abc123');
    expect(result.status).toBe('sent');
    expect(fakeSend).toHaveBeenCalledOnce();
    const arg = fakeSend.mock.calls[0]![0];
    expect(arg.from).toBe('[email protected]');
    expect(arg.to).toBe('[email protected]');
    expect(arg.subject).toBe('real');
    expect(arg.text).toBe('hello');
  });

  it('throws when Resend returns an error payload', async () => {
    process.env.RESEND_API_KEY = 're_test_xxx';
    process.env.RESEND_FROM_EMAIL = '[email protected]';

    const fakeSend = vi.fn().mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'bad email' },
    });
    vi.doMock('resend', () => buildFakeResend(fakeSend));

    vi.resetModules();
    const mod = await import(`./index.js`);
    await expect(
      mod.sendEmail({
        to: '[email protected]',
        subject: 'x',
        body: 'y',
      }),
    ).rejects.toThrow(/Resend send failed: bad email/);
  });
});

describe('DutyReminder template', () => {
  it('renders subject "Reminder: <location> at <time>"', async () => {
    const rendered = await renderDutyReminder({
      schoolName: 'Maple Elementary',
      dutyLocation: 'Main Entrance',
      dutyTimeLocal: '8:30 AM',
      schoolTimezone: 'America/Toronto',
      timeUntil: 'in 15 minutes',
      customMessage: null,
      recipientName: 'Alex',
    });
    expect(rendered.subject).toBe('Reminder: Main Entrance at 8:30 AM');
  });

  it('renders HTML containing duty location, school, time-until', async () => {
    const rendered = await renderDutyReminder({
      schoolName: 'Maple Elementary',
      dutyLocation: 'Playground',
      dutyTimeLocal: '3:15 PM',
      schoolTimezone: 'America/Toronto',
      timeUntil: 'in 30 minutes',
      customMessage: 'Bring the whistle',
      recipientName: 'Sam',
    });
    expect(rendered.html).toContain('Reminder: Playground at 3:15 PM');
    expect(rendered.html).toContain('Maple Elementary');
    expect(rendered.html).toContain('in 30 minutes');
    expect(rendered.html).toContain('Bring the whistle');
    expect(rendered.html).toContain('America/Toronto');
    expect(rendered.text).toContain('Bring the whistle');
  });

  it('omits custom-message section when not provided', async () => {
    const rendered = await renderDutyReminder({
      schoolName: 'Maple Elementary',
      dutyLocation: 'Cafeteria',
      dutyTimeLocal: '12:30 PM',
      schoolTimezone: 'America/Toronto',
      timeUntil: 'in 5 minutes',
    });
    expect(rendered.html).not.toContain('<strong>Note:</strong>');
    expect(rendered.text).not.toContain('Note:');
  });
});