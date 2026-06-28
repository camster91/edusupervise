/**
 * Tests for @edusupervise/sms.
 *
 * Covers:
 *  - mock impl: returns correct shape, appends to the mock log file.
 *  - twilio impl: throws clear env-missing errors.
 *  - twilio impl: when the SDK is mocked at the test level, the wrapper
 *    forwards and returns the real providerId.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';

import { sendSms, currentProvider, __testing__ as smsTesting } from './index.js';

describe('sms adapter — mock', () => {
  beforeEach(() => {
    process.env.SMS_PROVIDER = 'mock';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    rmSync(smsTesting.MOCK_LOG_PATH, { force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock('twilio');
  });

  it('default provider is mock when SMS_PROVIDER is unset', () => {
    delete process.env.SMS_PROVIDER;
    expect(currentProvider()).toBe('mock');
  });

  it('sendSms returns mock-<uuid> shape and status=sent', async () => {
    const result = await sendSms({ to: '+14165551234', body: 'Hello' });
    expect(result.status).toBe('sent');
    expect(result.providerId).toMatch(/^mock-[0-9a-f-]{36}$/);
  });

  it('appends a JSON log line with to/body', async () => {
    await sendSms({ to: '+14165551234', body: 'Body line' });
    const content = readFileSync(smsTesting.MOCK_LOG_PATH, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.to).toBe('+14165551234');
    expect(entry.body).toBe('Body line');
    expect(entry.providerId).toMatch(/^mock-[0-9a-f-]{36}$/);
    expect(entry.timestamp).toBeTruthy();
  });

  it('appends to the SMS_MOCK_LOG_PATH derived file', async () => {
    await sendSms({ to: '+14165551234', body: 'Path check body' });
    const content = readFileSync(smsTesting.MOCK_LOG_PATH, 'utf8');
    expect(content).toContain('Path check body');
  });

  it('throws on missing required fields', async () => {
    await expect(sendSms({ to: '', body: 'x' })).rejects.toThrow(/`to` is required/);
    await expect(sendSms({ to: '+1', body: '' })).rejects.toThrow(/`body` is required/);
  });

  it('throws on unknown SMS_PROVIDER', async () => {
    process.env.SMS_PROVIDER = 'messagebird';
    await expect(sendSms({ to: '+1', body: 'x' })).rejects.toThrow(/Unknown SMS_PROVIDER/);
  });
});

describe('sms adapter — twilio (env-driven failures)', () => {
  beforeEach(() => {
    process.env.SMS_PROVIDER = 'twilio';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
  });

  afterEach(() => {
    process.env.SMS_PROVIDER = 'mock';
    vi.restoreAllMocks();
    vi.unmock('twilio');
  });

  it('throws clear "TWILIO_ACCOUNT_SID required" when SID missing', async () => {
    await expect(sendSms({ to: '+1', body: 'x' })).rejects.toThrow(
      /TWILIO_ACCOUNT_SID required/,
    );
  });

  it('throws clear "TWILIO_AUTH_TOKEN required" when token missing', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACxxxx';
    await expect(sendSms({ to: '+1', body: 'x' })).rejects.toThrow(
      /TWILIO_AUTH_TOKEN required/,
    );
  });

  it('throws clear "TWILIO_FROM_NUMBER required" when from missing', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACxxxx';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    await expect(sendSms({ to: '+1', body: 'x' })).rejects.toThrow(
      /TWILIO_FROM_NUMBER required/,
    );
  });

  it('uses the Twilio SDK when fully configured', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACxxxx';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_FROM_NUMBER = '+14165550000';

    const fakeCreate = vi.fn().mockResolvedValue({
      sid: 'SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      status: 'queued',
    });
    const fakeDefault = vi.fn().mockReturnValue({
      messages: { create: fakeCreate },
    });
    vi.doMock('twilio', () => ({ default: fakeDefault }));

    vi.resetModules();
    const mod = await import(`./index.js`);
    const result = await mod.sendSms({
      to: '+14165551111',
      body: 'real test',
    });

    expect(result.providerId).toBe('SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(result.status).toBe('sent');
    expect(fakeDefault).toHaveBeenCalledWith('ACxxxx', 'token');
    expect(fakeCreate).toHaveBeenCalledWith({
      body: 'real test',
      to: '+14165551111',
      from: '+14165550000',
    });
  });
});