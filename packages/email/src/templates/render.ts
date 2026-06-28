/**
 * Render a DutyReminder email into subject + plain text + HTML.
 *
 * Used by both the mock and the real email adapters so the same template is
 * exercised in tests.
 *
 * Subject spec: "Reminder: <duty.location> at <time>"
 *
 * Why a template-literal implementation rather than the React component in
 * `DutyReminder.tsx`?
 * ----------------------------------------------------------------------
 * `@react-email/render` and `@react-email/components` are CommonJS. Vitest's
 * vite-based SSR loader imports them via ESM and the CJS-to-ESM interop is
 * flaky on Node 24 + vite 5 — React's `Suspense` named export ends up missing
 * inside `@react-email/components`'s internal `import { Suspense } from "react"`
 * statement, which throws a SyntaxError before any test runs. Building the
 * HTML from a plain string template avoids the entire React + react-email
 * runtime for the adapter code path. The React component in `DutyReminder.tsx`
 * is kept as a reference for any future browser-side preview tool that wants
 * to live-render the same layout.
 *
 * The HTML output intentionally mirrors the React component's layout so they
 * stay visually consistent.
 */

export interface DutyReminderProps {
  schoolName: string;
  /** Duty location, e.g. "Main Entrance" or "Playground" */
  dutyLocation: string;
  /** Local time string formatted in the school's timezone, e.g. "8:30 AM" */
  dutyTimeLocal: string;
  /** IANA timezone name of the school, e.g. "America/Toronto" */
  schoolTimezone: string;
  /** Human-readable countdown, e.g. "in 15 minutes", "tomorrow at 7:45 AM" */
  timeUntil: string;
  /** Custom message set by the teacher or admin (optional). */
  customMessage?: string | null;
  /** Greeting line — usually the teacher's first name. */
  recipientName?: string | null;
}

export interface RenderedDutyReminder {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Render a DutyReminder into subject + text + html.
 *
 * Subject spec: "Reminder: <duty.location> at <time>"
 */
export function renderDutyReminder(
  props: DutyReminderProps,
): RenderedDutyReminder {
  const subject = `Reminder: ${props.dutyLocation} at ${props.dutyTimeLocal}`;

  const greeting = props.recipientName ? `Hi ${props.recipientName},` : 'Hi,';

  const textLines: string[] = [
    subject,
    '',
    greeting,
    '',
    `You have a supervision duty scheduled at ${props.schoolName}.`,
    '',
    `Location: ${props.dutyLocation}`,
    `Time:     ${props.dutyTimeLocal} (${props.schoolTimezone})`,
    `Starts:   ${props.timeUntil}`,
  ];
  if (props.customMessage) {
    textLines.push('', 'Note:', props.customMessage);
  }
  textLines.push('', `This reminder was sent by ${props.schoolName} via EduSupervise.`);
  const text = textLines.join('\n');

  const safeSchool = escapeHtml(props.schoolName);
  const safeLocation = escapeHtml(props.dutyLocation);
  const safeTime = escapeHtml(props.dutyTimeLocal);
  const safeTz = escapeHtml(props.schoolTimezone);
  const safeTimeUntil = escapeHtml(props.timeUntil);
  const safeRecipient = escapeHtml(props.recipientName ?? '');
  const safeCustom = props.customMessage
    ? escapeHtml(props.customMessage).replace(/\n/g, '<br />')
    : null;

  const html =
    `<!DOCTYPE html>` +
    `<html><body style="background-color:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px 0;">` +
    `<div style="background-color:#ffffff;border:1px solid #e6ebf1;border-radius:8px;margin:0 auto;max-width:560px;padding:32px;">` +
    `<h1 style="color:#1a1a1a;font-size:22px;font-weight:600;margin:0 0 16px;">${escapeHtml(subject)}</h1>` +
    `<p style="color:#374151;font-size:16px;margin:0 0 12px;">${
      safeRecipient ? `Hi ${safeRecipient},` : 'Hi,'
    }</p>` +
    `<p style="color:#374151;font-size:16px;margin:0 0 16px;">` +
    `You have a supervision duty scheduled at <strong>${safeSchool}</strong>.` +
    `</p>` +
    `<div style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px;margin:16px 0;">` +
    `<p style="margin:0 0 6px;color:#1f2937;font-size:15px;"><strong>Location:</strong> ${safeLocation}</p>` +
    `<p style="margin:0 0 6px;color:#1f2937;font-size:15px;"><strong>Time:</strong> ${safeTime}` +
    ` <span style="color:#6b7280;margin-left:6px;">(${safeTz})</span></p>` +
    `<p style="margin:0;color:#1f2937;font-size:15px;"><strong>Starts:</strong> ${safeTimeUntil}</p>` +
    `</div>` +
    (safeCustom
      ? `<hr style="border:none;border-top:1px solid #e6ebf1;margin:20px 0;" />` +
        `<p style="color:#374151;font-size:15px;margin:0 0 8px;"><strong>Note:</strong></p>` +
        `<p style="color:#374151;font-size:15px;margin:0;">${safeCustom}</p>`
      : '') +
    `<hr style="border:none;border-top:1px solid #e6ebf1;margin:24px 0 16px;" />` +
    `<p style="color:#9ca3af;font-size:13px;margin:0;">` +
    `This reminder was sent by ${safeSchool} via EduSupervise.` +
    `</p>` +
    `</div></body></html>`;

  return { subject, text, html };
}