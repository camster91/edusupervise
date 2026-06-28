/**
 * Email template public API.
 *
 * Re-exports the `renderDutyReminder()` plain-template renderer used by both
 * mock and real email paths. The React component in `DutyReminder.tsx` is
 * kept as a reference for future browser-side previews — see `render.ts` for
 * why we don't ship it through the runtime adapter path.
 */
export {
  renderDutyReminder,
  type DutyReminderProps,
  type RenderedDutyReminder,
} from './render.js';