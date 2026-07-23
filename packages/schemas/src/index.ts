// @edusupervise/schemas — shared Zod schemas.
//
// Each domain area exports its schema from a sub-path:
//
//   import { reminderJobSchema } from '@edusupervise/schemas/reminder-job';
//
// Populated by subsequent tasks (frontend-duties, frontend-reminders, etc.).
// This file is intentionally a barrel placeholder so the workspace builds.
//
// Audit 2026-07-22 P0-1 / P1-8: the previously-shipped `auth.ts` barrel
// (containing loginSchema, forgotSchema, etc.) was never imported by any
// route — every route defined its own inline Zod schema. The contract was
// aspirational and the consumer never landed, so the file is gone. If/when
// the routes migrate to the shared schemas, re-add it then.

export * from './reminder-job.js';