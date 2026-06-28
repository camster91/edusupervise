// @edusupervise/schemas — barrel.
//
// Domain areas live in their own files (auth, duty, reminder, ...). This
// barrel re-exports everything so consumers can do:
//
//   import { signupSchema, loginSchema } from '@edusupervise/schemas';
//
// Or pull a single domain explicitly:
//
//   import { signupSchema } from '@edusupervise/schemas/auth';

export * from './auth.js';