/**
 * Public surface of `@edusupervise/db`.
 *
 * Consumers should import from `@edusupervise/db` (not from internal
 * subpaths) so we can refactor internals without breaking call sites.
 * The `package.json#exports` field restricts what is reachable.
 */
export * from './schema.js';
export { getRuntimeClient, getSystemClient, schema } from './client.js';
export type { Db } from './client.js';
export {
  withSchoolContext,
  withUserContext,
  setSchoolContext,
  sql,
} from './rls.js';
export type {
  SchoolContextTx,
  WithSchoolContextOptions,
} from './rls.js';
export {
  cycleDayForDate,
  firstMondayOfSeptember,
  addMonthsUtc,
} from './cycle-math.js';
export type { School, CalendarEntry } from './cycle-math.js';
export { authSchema } from './auth-schema.js';
