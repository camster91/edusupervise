// @edusupervise/schemas — shared Zod schemas.
//
// Each schema in this package is the single source of truth for validating
// both client form submissions (via @hookform/resolvers/zod) and server
// action inputs (via schema.parse on the action body). Sharing the schema
// means the client and server cannot drift apart.
//
// Each domain area exports its schema from a sub-path:
//
//   import { loginSchema } from '@edusupervise/schemas/auth';
//   import { dutyCreateSchema } from '@edusupervise/schemas/duty';
//
// Populated by subsequent tasks (frontend-duties, frontend-reminders, etc.).
// This file is intentionally a barrel placeholder so the workspace builds.

export * from './auth.js';
export * from './reminder-job.js';