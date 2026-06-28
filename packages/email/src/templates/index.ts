/**
 * Render a DutyReminder template to plain-text + HTML. Used by both the mock
 * and the real email adapters so the same template is exercised in tests.
 *
 * NOTE: `@react-email/render`'s `render()` is async even in the node build
 * (it uses renderToReadableStream under the hood) — this function is therefore
 * async too.
 */
import { render } from '@react-email/render';
import { createElement } from 'react';
import { DutyReminder, type DutyReminderProps } from './DutyReminder.js';

export interface RenderedDutyReminder {
  subject: string;
  text: string;
  html: string;
}

/**
 * Render a DutyReminder into subject + text + html.
 *
 * Subject spec: "Reminder: <duty.location> at <time>"
 */
export async function renderDutyReminder(
  props: DutyReminderProps,
): Promise<RenderedDutyReminder> {
  const subject = `Reminder: ${props.dutyLocation} at ${props.dutyTimeLocal}`;
  const element = createElement(DutyReminder, props);
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject, text, html };
}

export { DutyReminder } from './DutyReminder.js';
export type { DutyReminderProps } from './DutyReminder.js';