/**
 * Drizzle schema — mirrors `db/init/02-schema.sql` (which mirrors spec section 4)
 * plus the better-auth session/account/verification tables (defined in this
 * file because the init script cannot know about better-auth's columns).
 *
 * Why a Drizzle layer when SQL already runs from `db/init/`?
 *   - The init script is the FIRST-BOOT bootstrap so a fresh Postgres
 *     container can come up with a usable schema. After that, drizzle-kit
 *     migrations are the source of truth for schema evolution.
 *   - This file gives every consumer (web actions, worker jobs, scripts) a
 *     fully-typed query API. The TypeScript types are checked at build time;
 *     the SQL definitions are checked by Postgres at runtime.
 *
 * Conventions:
 *   - All tenant tables have `school_id UUID NOT NULL REFERENCES schools(id)
 *     ON DELETE CASCADE` and an RLS policy defined in the init SQL. RLS is
 *     NOT re-asserted here — drizzle-kit does not model policies, and the
 *     SQL is the single source of truth for them. See `db/init/02-schema.sql`.
 *   - CHECK constraints (length caps, time ordering, enum-equivalents that
 *     pgEnum does not cover) are written inline using drizzle's `check()`
 *     builder so they are emitted as part of the generated migration SQL.
 *   - Enums are modeled as `pgEnum` so Drizzle infers string-literal types
 *     for the corresponding column; pgEnum emits a matching
 *     `CREATE TYPE ... AS ENUM` plus an implicit CHECK, so we do NOT add a
 *     manual `check()` for enum membership on those columns.
 *   - Better-auth's `session` / `account` / `verification` tables ARE
 *     declared here — better-auth's Drizzle adapter expects them to exist
 *     before the first auth event. They are global (NOT tenant-scoped, no
 *     `school_id`) because a session is keyed by an opaque token, not by
 *     school. See `apps/web/server/auth.server.ts` for the field-name
 *     mapping that bridges our snake_case `users` columns to better-auth's
 *     camelCase expectations.
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Custom types
// ---------------------------------------------------------------------------

/**
 * Postgres `INET` type — drizzle-orm 0.36 has no built-in mapping, so we
 * declare it as a custom type that serializes as a string. The init SQL
 * declares the column as `INET`; we mirror that here so the migration does
 * not need to alter the column type.
 */
const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'inet';
  },
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const schoolPlanEnum = pgEnum('school_plan', [
  'trial',
  'free',
  'pro',
  'school',
]);
export type SchoolPlan = (typeof schoolPlanEnum.enumValues)[number];

export const userRoleEnum = pgEnum('user_role', [
  'school_admin',
  'teacher',
  'substitute',
]);
export type UserRole = (typeof userRoleEnum.enumValues)[number];

export const reminderChannelEnum = pgEnum('reminder_channel', [
  'email',
  'sms',
]);
export type ReminderChannel = (typeof reminderChannelEnum.enumValues)[number];

export const reminderStatusEnum = pgEnum('reminder_status', [
  'pending',
  'sent',
  'failed',
  'skipped',
]);
export type ReminderStatus = (typeof reminderStatusEnum.enumValues)[number];

export const notificationKindEnum = pgEnum('notification_kind', [
  'reminder.failed',
  'plan.downgrade.pending',
  'plan.downgrade.applied',
  'system.message',
]);
export type NotificationKind = (typeof notificationKindEnum.enumValues)[number];

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

export const schools = pgTable(
  'schools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('America/Toronto'),
    cycleDays: integer('cycle_days').notNull().default(5),
    schoolYearStart: date('school_year_start').notNull(),
    schoolYearEnd: date('school_year_end').notNull(),
    plan: schoolPlanEnum('plan').notNull().default('trial'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    planDowngradePendingTo: text('plan_downgrade_pending_to'),
    planDowngradeEffectiveAt: timestamp('plan_downgrade_effective_at', {
      withTimezone: true,
    }),
    stripeCustomerId: text('stripe_customer_id').unique(),
    stripeSubscriptionId: text('stripe_subscription_id').unique(),
    logoUrl: text('logo_url'),
    accentColor: text('accent_color').default('#3b82f6'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'schools_cycle_days_range',
      sql`${t.cycleDays} BETWEEN 1 AND 10`,
    ),
    check(
      'schools_year_end_after_start',
      sql`${t.schoolYearEnd} > ${t.schoolYearStart}`,
    ),
    check(
      'schools_year_within_14_months',
      sql`${t.schoolYearEnd} <= ${t.schoolYearStart} + interval '14 months'`,
    ),
    index('idx_schools_slug').on(t.slug),
  ],
);
export type School = typeof schools.$inferSelect;
export type NewSchool = typeof schools.$inferInsert;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    passwordHash: text('password_hash'),
    name: text('name').notNull(),
    role: userRoleEnum('role').notNull(),
    phone: text('phone'),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    avatarUrl: text('avatar_url'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('users_school_id_email_unique').on(t.schoolId, t.email),
    index('idx_users_school_id').on(t.schoolId),
    index('idx_users_email').on(t.email),
  ],
);
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// ---------------------------------------------------------------------------
// Cycle calendar
// ---------------------------------------------------------------------------

export const cycleCalendar = pgTable(
  'cycle_calendar',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    cycleDay: integer('cycle_day'),
    isSchoolDay: boolean('is_school_day').notNull().default(true),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'cycle_calendar_day_range',
      sql`${t.cycleDay} IS NULL OR (${t.cycleDay} >= 1 AND ${t.cycleDay} <= 10)`,
    ),
    check(
      'cycle_calendar_note_length',
      sql`${t.note} IS NULL OR length(${t.note}) <= 500`,
    ),
    unique('cycle_calendar_school_date_unique').on(t.schoolId, t.date),
    index('idx_cycle_calendar_school_date').on(t.schoolId, t.date),
  ],
);
export type CycleCalendar = typeof cycleCalendar.$inferSelect;
export type NewCycleCalendar = typeof cycleCalendar.$inferInsert;

// ---------------------------------------------------------------------------
// Duties
// ---------------------------------------------------------------------------

export const duties = pgTable(
  'duties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    cycleDay: integer('cycle_day').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    location: text('location').notNull(),
    description: text('description'),
    requiresVest: boolean('requires_vest').notNull().default(false),
    requiresRadio: boolean('requires_radio').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('duties_cycle_day_min', sql`${t.cycleDay} >= 1`),
    check(
      'duties_description_length',
      sql`${t.description} IS NULL OR length(${t.description}) <= 1000`,
    ),
    check('duties_end_after_start', sql`${t.endTime} > ${t.startTime}`),
    // Partial index on active rows: the workhorse lookup is "give me active
    // duties for cycle day N of school X" and the index never grows with
    // soft-deleted rows.
    index('idx_duties_school_cycle')
      .on(t.schoolId, t.cycleDay)
      .where(sql`${t.isActive}`),
  ],
);
export type Duty = typeof duties.$inferSelect;
export type NewDuty = typeof duties.$inferInsert;

// ---------------------------------------------------------------------------
// Duty assignments
// ---------------------------------------------------------------------------

export const dutyAssignments = pgTable(
  'duty_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    dutyId: uuid('duty_id')
      .notNull()
      .references(() => duties.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'duty_assignments_end_after_start',
      sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`,
    ),
    index('idx_assignments_school_user').on(t.schoolId, t.userId),
    index('idx_assignments_school_duty').on(t.schoolId, t.dutyId),
  ],
);
export type DutyAssignment = typeof dutyAssignments.$inferSelect;
export type NewDutyAssignment = typeof dutyAssignments.$inferInsert;

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => dutyAssignments.id, { onDelete: 'cascade' }),
    minutesBefore: integer('minutes_before').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    notifyEmail: boolean('notify_email').notNull().default(true),
    notifySms: boolean('notify_sms').notNull().default(false),
    customMessage: text('custom_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'reminders_minutes_range',
      sql`${t.minutesBefore} >= 0 AND ${t.minutesBefore} <= 10080`,
    ),
    check(
      'reminders_custom_message_length',
      sql`${t.customMessage} IS NULL OR length(${t.customMessage}) <= 500`,
    ),
    index('idx_reminders_school_assignment').on(t.schoolId, t.assignmentId),
  ],
);
export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;

// ---------------------------------------------------------------------------
// Reminder dispatch log
// ---------------------------------------------------------------------------

export const reminderLog = pgTable(
  'reminder_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    reminderId: uuid('reminder_id')
      .notNull()
      .references(() => reminders.id, { onDelete: 'cascade' }),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => dutyAssignments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    channel: reminderChannelEnum('channel').notNull(),
    status: reminderStatusEnum('status').notNull(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Idempotency on concurrent dispatch: if two workers try to send the
    // same (reminder, scheduled_for, channel) tuple, the second one fails
    // on this unique index and the loser can treat it as a no-op.
    uniqueIndex('reminder_log_dedup_unique').on(
      t.reminderId,
      t.scheduledFor,
      t.channel,
    ),
    index('idx_reminder_log_school_status').on(t.schoolId, t.status),
    index('idx_reminder_log_assignment').on(t.assignmentId),
  ],
);
export type ReminderLog = typeof reminderLog.$inferSelect;
export type NewReminderLog = typeof reminderLog.$inferInsert;

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

/**
 * Transactional outbox. The web app inserts rows here in the same
 * transaction as the data change; a worker loop reads `enqueued_at IS NULL`
 * rows and enqueues BullMQ jobs.
 *
 * `id` is BIGSERIAL (matches init SQL). Spec section 4 originally wrote
 * `UUIDSERIAL` but that is not a Postgres type — the init SQL uses
 * `BIGSERIAL` and we mirror that here for forward compatibility with
 * existing rows.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    schoolId: uuid('school_id').notNull(),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload').notNull(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Partial index on un-enqueued rows — the worker query is
    //   SELECT * FROM outbox WHERE enqueued_at IS NULL ORDER BY created_at
    // and we want that to be cheap even when the table is large.
    index('idx_outbox_pending')
      .on(t.createdAt)
      .where(sql`${t.enqueuedAt} IS NULL`),
  ],
);
export type Outbox = typeof outbox.$inferSelect;
export type NewOutbox = typeof outbox.$inferInsert;

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    // `user_id` is nullable: system-initiated actions (cron, webhooks,
    // background workers) do not have a logged-in user.
    userId: uuid('user_id').references(() => users.id),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_audit_school_created').on(t.schoolId, t.createdAt),
    index('idx_audit_target').on(t.schoolId, t.targetType, t.targetId),
  ],
);
export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;

// ---------------------------------------------------------------------------
// Stripe webhook idempotency
// ---------------------------------------------------------------------------

export const stripeEvents = pgTable('stripe_events', {
  // PK is the Stripe event.id so a duplicate webhook POST is a no-op.
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type StripeEvent = typeof stripeEvents.$inferSelect;
export type NewStripeEvent = typeof stripeEvents.$inferInsert;

// ---------------------------------------------------------------------------
// Worker heartbeats
// ---------------------------------------------------------------------------

export const workerHeartbeats = pgTable('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  lastBeat: timestamp('last_beat', { withTimezone: true }).notNull(),
  jobsCompleted: bigserial('jobs_completed', { mode: 'bigint' })
    .notNull()
    .default(0n),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
});
export type WorkerHeartbeat = typeof workerHeartbeats.$inferSelect;
export type NewWorkerHeartbeat = typeof workerHeartbeats.$inferInsert;

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKindEnum('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    linkUrl: text('link_url'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Partial index on unread rows: the notification bell query is
    //   SELECT * FROM notifications WHERE user_id = $1 AND read_at IS NULL
    // and we want it to ignore already-read rows.
    index('idx_notifications_user_unread')
      .on(t.userId, t.createdAt)
      .where(sql`${t.readAt} IS NULL`),
  ],
);
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

// ---------------------------------------------------------------------------
// Push notification subscriptions
// ---------------------------------------------------------------------------

/**
 * One row per browser endpoint that a user has registered for Web Push
 * notifications from a given school. The unique constraint
 * (school_id, user_id, endpoint) makes subscribe idempotent — the route
 * handler uses `ON CONFLICT ... DO UPDATE` to refresh `last_used_at`
 * rather than error on duplicate insert.
 *
 * Why `endpoint` is the natural key (not user-agent + device):
 *   - The browser service worker is what produces the endpoint. A user
 *     reinstalling the same browser on the same device generates a new
 *     endpoint, so trying to dedupe on UA would still let stale rows in.
 *   - The push service (FCM / Mozilla autopush / Apple) controls endpoint
 *     identity — if they rotate the endpoint, the old one will return 410
 *     and the handler DELETEs the row.
 *
 * RLS is defined in db/init/02-schema.sql (and mirrored in
 * db/migrations/2026-06-28-push-subscriptions.sql). The policy is
 * `push_sub_tenant` and matches `tenant_isolation` semantically.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    // Idempotency on subscribe — duplicate subscribe refreshes last_used_at
    // instead of erroring. See apps/web/server/push.server.ts.
    uniqueIndex('push_subscriptions_school_user_endpoint_unique').on(
      t.schoolId,
      t.userId,
      t.endpoint,
    ),
    // Lookup is "give me all subs for this user" (send push to one user).
    index('idx_push_subscriptions_user').on(t.schoolId, t.userId),
  ],
);
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;

// ---------------------------------------------------------------------------
// Plan limits
// ---------------------------------------------------------------------------

export const planLimits = pgTable('plan_limits', {
  plan: text('plan').primaryKey(),
  maxTeachers: integer('max_teachers').notNull(),
  maxDuties: integer('max_duties').notNull(),
  maxRemindersPerAssignment: integer('max_reminders_per_assignment').notNull(),
  smsIncluded: boolean('sms_included').notNull().default(false),
  auditRetentionDays: integer('audit_retention_days').notNull(),
});
export type PlanLimit = typeof planLimits.$inferSelect;
export type NewPlanLimit = typeof planLimits.$inferInsert;

// ---------------------------------------------------------------------------
// Relations (for Drizzle's relational query API; RLS still applies)
// ---------------------------------------------------------------------------

export const schoolsRelations = relations(schools, ({ many }) => ({
  users: many(users),
  cycleCalendar: many(cycleCalendar),
  duties: many(duties),
  dutyAssignments: many(dutyAssignments),
  reminders: many(reminders),
  notifications: many(notifications),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  school: one(schools, { fields: [users.schoolId], references: [schools.id] }),
  dutyAssignments: many(dutyAssignments),
  reminderLogs: many(reminderLog),
  pushSubscriptions: many(pushSubscriptions),
}));

export const dutiesRelations = relations(duties, ({ one, many }) => ({
  school: one(schools, { fields: [duties.schoolId], references: [schools.id] }),
  createdByUser: one(users, {
    fields: [duties.createdBy],
    references: [users.id],
  }),
  assignments: many(dutyAssignments),
}));

export const dutyAssignmentsRelations = relations(
  dutyAssignments,
  ({ one, many }) => ({
    school: one(schools, {
      fields: [dutyAssignments.schoolId],
      references: [schools.id],
    }),
    duty: one(duties, {
      fields: [dutyAssignments.dutyId],
      references: [duties.id],
    }),
    user: one(users, {
      fields: [dutyAssignments.userId],
      references: [users.id],
    }),
    createdByUser: one(users, {
      fields: [dutyAssignments.createdBy],
      references: [users.id],
    }),
    reminders: many(reminders),
  }),
);

export const remindersRelations = relations(reminders, ({ one, many }) => ({
  school: one(schools, {
    fields: [reminders.schoolId],
    references: [schools.id],
  }),
  assignment: one(dutyAssignments, {
    fields: [reminders.assignmentId],
    references: [dutyAssignments.id],
  }),
  log: many(reminderLog),
}));

export const reminderLogRelations = relations(reminderLog, ({ one }) => ({
  school: one(schools, {
    fields: [reminderLog.schoolId],
    references: [schools.id],
  }),
  reminder: one(reminders, {
    fields: [reminderLog.reminderId],
    references: [reminders.id],
  }),
  assignment: one(dutyAssignments, {
    fields: [reminderLog.assignmentId],
    references: [dutyAssignments.id],
  }),
  user: one(users, {
    fields: [reminderLog.userId],
    references: [users.id],
  }),
}));

export const cycleCalendarRelations = relations(cycleCalendar, ({ one }) => ({
  school: one(schools, {
    fields: [cycleCalendar.schoolId],
    references: [schools.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  school: one(schools, {
    fields: [notifications.schoolId],
    references: [schools.id],
  }),
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));

export const pushSubscriptionsRelations = relations(
  pushSubscriptions,
  ({ one }) => ({
    school: one(schools, {
      fields: [pushSubscriptions.schoolId],
      references: [schools.id],
    }),
    user: one(users, {
      fields: [pushSubscriptions.userId],
      references: [users.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Google Calendar OAuth tokens (Tier 2 calendar-exports-v2-google)
// ---------------------------------------------------------------------------

/**
 * Per-user OAuth tokens for the Google Calendar 2-way sync. Defined in
 * `db/migrations/2026-07-01-google-calendar-tokens.sql` and mirrored here
 * so the @edusupervise/google-calendar package can query it through Drizzle
 * with full type safety.
 *
 * UNIQUE(school_id, user_id) means each EduSupervise user links to at most
 * one Google account at a time; reconnecting reuses the same row.
 */
export const googleCalendarTokens = pgTable(
  'google_calendar_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    expiryDate: timestamp('expiry_date', { withTimezone: true }).notNull(),
    scope: text('scope').notNull(),
    googleEmail: text('google_email'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('google_calendar_tokens_school_user_unique').on(t.schoolId, t.userId),
    index('idx_google_calendar_tokens_school_user').on(t.schoolId, t.userId),
  ],
);
export type GoogleCalendarToken = typeof googleCalendarTokens.$inferSelect;
export type NewGoogleCalendarToken = typeof googleCalendarTokens.$inferInsert;

// ---------------------------------------------------------------------------
// EduSupervise <-> Google event link (Tier 2 calendar-exports-v2-google)
// ---------------------------------------------------------------------------

/**
 * Maps an EduSupervise duty-assignment occurrence to a Google Calendar event
 * id. Used by `reconcile` to detect created/updated/deleted events without
 * re-pushing every duty on every sync.
 *
 * The composite PK (`schoolId, dutyAssignmentId, date`) matches one Google
 * event per (assignment, occurrence). When the sync pushes a duty event to
 * Google it inserts a row here; when the sync pulls a Google event we look
 * up the row by `googleEventId` to find the local source.
 *
 * RLS is enforced the same way as every other tenant table — see
 * `db/init/02-schema.sql`'s RLS loop. We do not re-assert RLS here; the
 * migration SQL is the source of truth.
 */
export const calendarEventLinks = pgTable(
  'calendar_event_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schoolId: uuid('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    dutyAssignmentId: uuid('duty_assignment_id')
      .notNull()
      .references(() => dutyAssignments.id, { onDelete: 'cascade' }),
    /** Calendar date the duty fires on (UTC midnight). */
    date: date('date').notNull(),
    googleEventId: text('google_event_id').notNull(),
    googleEtag: text('google_etag'),
    /** When we last reconciled this link. */
    syncedAt: timestamp('synced_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('calendar_event_links_school_assignment_date_unique').on(
      t.schoolId,
      t.dutyAssignmentId,
      t.date,
    ),
    index('idx_calendar_event_links_school_duty').on(
      t.schoolId,
      t.dutyAssignmentId,
    ),
    index('idx_calendar_event_links_google_event_id').on(t.googleEventId),
  ],
);
export type CalendarEventLink = typeof calendarEventLinks.$inferSelect;
export type NewCalendarEventLink = typeof calendarEventLinks.$inferInsert;

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  school: one(schools, {
    fields: [auditLog.schoolId],
    references: [schools.id],
  }),
  user: one(users, { fields: [auditLog.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// Better-auth session / account / verification tables
// ---------------------------------------------------------------------------
//
// These tables are GLOBAL (no `school_id`, no RLS). They are keyed by opaque
// tokens / provider IDs, not by tenant — a session token identifies "this
// browser is logged in as user X", and `school_id` is read off the user row
// inside the request handler after `auth.api.getSession({ headers })`
// returns the session.
//
// Why these are NOT in db/init/02-schema.sql:
//   - The init script doesn't know better-auth's column shape. Column types
//     and lengths are owned by the better-auth adapter contract, so we
//     declare them here as Drizzle tables and let drizzle-kit migrations
//     manage their evolution.
//   - The runtime role gets `SELECT/INSERT/UPDATE/DELETE` on these tables
//     via the GRANT loop at the bottom of 02-schema.sql, which uses
//     `pg_tables` — but that loop only sees tables that already exist at
//     init time. The GRANT for these tables is therefore re-applied by the
//     migration that creates them (see db/migrations/0000_init.sql — the
//     migration emits explicit `GRANT ... TO edusupervise_runtime` for
//     every better-auth table it creates).
//
// Column shape matches better-auth's internal adapter (see
// `@better-auth/core/dist/db/schema/*.mjs`):
//   - session:   id, userId, token, expiresAt, ipAddress, userAgent
//   - account:   id, userId, accountId, providerId, accessToken, ... , password
//   - verification: id, identifier, value, expiresAt
//
// We use camelCase columns because better-auth's drizzle adapter defaults to
// camelCase column names; setting `camelCase: false` would force us to write
// a `fields` mapping for every column, which is more friction than value.

/**
 * Better-auth session. Identified by an opaque `token` (unique). The runtime
 * role reads this table on every authenticated request via
 * `auth.api.getSession({ headers })`. NO school_id, NO RLS — session lookup
 * is the very step that figures out which school the request belongs to.
 */
export const authSession = pgTable('auth_session', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  createdAt: timestamp('createdAt', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type AuthSession = typeof authSession.$inferSelect;
export type NewAuthSession = typeof authSession.$inferInsert;

/**
 * Better-auth account. One row per (userId, providerId) — credential accounts
 * hold the bcrypt password hash in `password`; OAuth accounts hold the
 * provider's access/refresh tokens. Read on sign-in (password verify) and on
 * OAuth callback.
 */
export const authAccount = pgTable(
  'auth_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt', {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', {
      withTimezone: true,
    }),
    scope: text('scope'),
    /** bcrypt hash for `providerId='credential'`. */
    password: text('password'),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One row per (user, provider). A user can have a credential account
    // AND a Google account at the same time, but only one of each.
    uniqueIndex('auth_account_user_provider_unique').on(t.userId, t.providerId),
    index('idx_auth_account_user').on(t.userId),
  ],
);
export type AuthAccount = typeof authAccount.$inferSelect;
export type NewAuthAccount = typeof authAccount.$inferInsert;

/**
 * Better-auth verification. Generic token store for email-verification,
 * password-reset, magic-link flows. Each row is a one-time token (better-auth
 * deletes on consume). NO RLS — verification lookups happen before we know
 * which user / school the token belongs to.
 */
export const authVerification = pgTable(
  'auth_verification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_auth_verification_identifier').on(t.identifier),
  ],
);
export type AuthVerification = typeof authVerification.$inferSelect;
export type NewAuthVerification = typeof authVerification.$inferInsert;

export const authSessionRelations = relations(authSession, ({ one }) => ({
  user: one(users, { fields: [authSession.userId], references: [users.id] }),
}));

export const authAccountRelations = relations(authAccount, ({ one }) => ({
  user: one(users, { fields: [authAccount.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// Schema array — convenient for drizzle-kit + drizzle-orm
// ---------------------------------------------------------------------------

export const schema = {
  schools,
  users,
  cycleCalendar,
  duties,
  dutyAssignments,
  reminders,
  reminderLog,
  outbox,
  auditLog,
  stripeEvents,
  workerHeartbeats,
  notifications,
  pushSubscriptions,
  planLimits,
  googleCalendarTokens,
  calendarEventLinks,
  authSession,
  authAccount,
  authVerification,
};
