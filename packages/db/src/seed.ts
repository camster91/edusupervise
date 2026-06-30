/**
 * Dev seed — populates plan_limits, a demo school, an admin user, and
 * four duty slots that match the original Replit demo data.
 *
 * ⚠️  DEV-ONLY. DO NOT RUN IN PRODUCTION.
 *
 *   $ pnpm db:seed
 *
 * Idempotency:
 *   - `plan_limits` rows: `ON CONFLICT (plan) DO UPDATE` so re-running
 *     the seed overwrites the values (init SQL also does this).
 *   - Demo school: skipped if a school with slug `maple-elementary`
 *     already exists.
 *   - Demo user: skipped if `admin@maple.test` already exists in that
 *     school.
 *   - Demo duties: skipped if any duty already exists for the school.
 *
 * Demo data:
 *   - School: "Maple Elementary", slug `maple-elementary`, 5-day cycle,
 *     school year starting first Monday of September (current year) and
 *     ending 10 months later.
 *   - Admin user: `admin@maple.test` / `password123` (bcrypt 12 rounds).
 *   - Duties (matching the Replit demo):
 *       Main Entrance  08:30-09:00  cycle 1
 *       Playground     15:15-15:45  cycle 2
 *       Cafeteria      12:30-13:00  cycle 3
 *       Sports Field   11:45-12:15  cycle 4
 *
 * Connection: the OWNER role. The runtime + system roles have RLS that
 * would prevent inserting into other schools' rows.
 */
import { config as loadEnv } from 'dotenv';
import { eq } from 'drizzle-orm';
import { hash as bcryptHash } from 'bcryptjs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  duties,
  dutyAssignments,
  planLimits,
  schools,
  users,
  type NewDuty,
} from './schema.js';
import { addMonthsUtc, firstMondayOfSeptember } from './cycle-math.js';

const here = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(here, '../../../.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'seed: DATABASE_URL is not set. ' +
      'Export DATABASE_URL=postgres://edusupervise_owner:...@host:5432/db and retry.',
  );
  process.exit(1);
}

const DEMO_SCHOOL_SLUG = 'maple-elementary';
const DEMO_ADMIN_EMAIL = 'admin@maple.test';
const DEMO_ADMIN_PASSWORD = 'password123';

const BCRYPT_ROUNDS = 12;

const PLAN_LIMITS_VALUES = [
  { plan: 'trial', maxTeachers: 5, maxDuties: 20, maxRemindersPerAssignment: 3, smsIncluded: false, auditRetentionDays: 14 },
  { plan: 'free', maxTeachers: 3, maxDuties: 10, maxRemindersPerAssignment: 1, smsIncluded: false, auditRetentionDays: 7 },
  { plan: 'pro', maxTeachers: 50, maxDuties: 500, maxRemindersPerAssignment: 10, smsIncluded: true, auditRetentionDays: 90 },
  { plan: 'school', maxTeachers: 500, maxDuties: 5000, maxRemindersPerAssignment: 50, smsIncluded: true, auditRetentionDays: 365 },
] as const;

const DEMO_DUTIES: ReadonlyArray<
  Pick<NewDuty, 'cycleDay' | 'startTime' | 'endTime' | 'location' | 'description'>
> = [
  {
    cycleDay: 1,
    startTime: '08:30:00',
    endTime: '09:00:00',
    location: 'Main Entrance',
    description: 'Greet students and direct them to homeroom.',
  },
  {
    cycleDay: 2,
    startTime: '15:15:00',
    endTime: '15:45:00',
    location: 'Playground',
    description: 'Afternoon recess supervision.',
  },
  {
    cycleDay: 3,
    startTime: '12:30:00',
    endTime: '13:00:00',
    location: 'Cafeteria',
    description: 'Lunch duty — monitor noise and clean-up.',
  },
  {
    cycleDay: 4,
    startTime: '11:45:00',
    endTime: '12:15:00',
    location: 'Sports Field',
    description: 'Outdoor PE class supervision.',
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'seed: refusing to run with NODE_ENV=production. ' +
        'This script creates demo data and is for dev only.',
    );
  }
  if (!process.env.ALLOW_DEV_SEED && process.env.NODE_ENV === 'production') {
    throw new Error('seed: ALLOW_DEV_SEED must be set to run in non-prod');
  }

  // The DATABASE_URL presence guard above proves this is defined;
  // the non-null assertion tells TypeScript that too without making
  // the surrounding code deal with a possibly-undefined string.
  const sql = postgres(databaseUrl!, { max: 1 });
  const db = drizzle(sql, { schema: { planLimits, schools, users, duties, dutyAssignments } });

  try {
    // 1. plan_limits — idempotent ON CONFLICT update.
    console.log('seed: upserting plan_limits ...');
    for (const row of PLAN_LIMITS_VALUES) {
      await db
        .insert(planLimits)
        .values(row)
        .onConflictDoUpdate({
          target: planLimits.plan,
          set: {
            maxTeachers: row.maxTeachers,
            maxDuties: row.maxDuties,
            maxRemindersPerAssignment: row.maxRemindersPerAssignment,
            smsIncluded: row.smsIncluded,
            auditRetentionDays: row.auditRetentionDays,
          },
        });
    }

    // 2. Demo school — skip if slug already exists.
    const existingSchool = await db
      .select({ id: schools.id })
      .from(schools)
      .where(eq(schools.slug, DEMO_SCHOOL_SLUG))
      .limit(1);

    let schoolId: string;
    if (existingSchool.length > 0) {
      schoolId = existingSchool[0]!.id;
      console.log(`seed: school '${DEMO_SCHOOL_SLUG}' already exists (${schoolId})`);
    } else {
      const now = new Date();
      const year = now.getUTCFullYear();
      const start = firstMondayOfSeptember(year);
      // 10 months — typical North-American school year, inside the
      // 14-month cap.
      const end = addMonthsUtc(start, 10);
      const [inserted] = await db
        .insert(schools)
        .values({
          slug: DEMO_SCHOOL_SLUG,
          name: 'Maple Elementary',
          timezone: 'America/Toronto',
          cycleDays: 5,
          schoolYearStart: start.toISOString().slice(0, 10), // 'YYYY-MM-DD'
          schoolYearEnd: end.toISOString().slice(0, 10),
          plan: 'trial',
          joinCode: 'MAPLE-42',
        })
        .returning({ id: schools.id });
      if (!inserted) throw new Error('seed: failed to insert demo school');
      schoolId = inserted.id;
      console.log(
        `seed: created school 'Maple Elementary' (${schoolId}) — ` +
          `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`,
      );
    }

    // 3. Demo admin user — skip if email already exists for this school.
    const existingUser = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, DEMO_ADMIN_EMAIL))
      .limit(1);

    let adminUserId: string;
    if (existingUser.length > 0) {
      adminUserId = existingUser[0]!.id;
      console.log(`seed: user '${DEMO_ADMIN_EMAIL}' already exists (${adminUserId})`);
    } else {
      const passwordHash = await bcryptHash(DEMO_ADMIN_PASSWORD, BCRYPT_ROUNDS);
      const [inserted] = await db
        .insert(users)
        .values({
          schoolId,
          email: DEMO_ADMIN_EMAIL,
          name: 'Maple Admin',
          role: 'school_admin',
          passwordHash,
          emailVerifiedAt: new Date(), // skip verification in dev
        })
        .returning({ id: users.id });
      if (!inserted) throw new Error('seed: failed to insert demo admin');
      adminUserId = inserted.id;
      console.log(`seed: created user '${DEMO_ADMIN_EMAIL}' (${adminUserId})`);
    }

    // 4. Demo duties — skip if any duties already exist for the school.
    const existingDuties = await db
      .select({ id: duties.id })
      .from(duties)
      .where(eq(duties.schoolId, schoolId))
      .limit(1);

    if (existingDuties.length > 0) {
      console.log('seed: duties already exist for demo school; skipping');
    } else {
      console.log('seed: creating 4 demo duties ...');
      for (const d of DEMO_DUTIES) {
        await db.insert(duties).values({
          schoolId,
          cycleDay: d.cycleDay,
          startTime: d.startTime,
          endTime: d.endTime,
          location: d.location,
          description: d.description,
          requiresVest: false,
          requiresRadio: false,
          isActive: true,
          createdBy: adminUserId,
        });
      }
      console.log('seed: created duties:');
      for (const d of DEMO_DUTIES) {
        console.log(
          `  cycle ${d.cycleDay}: ${d.startTime}-${d.endTime} ${d.location}`,
        );
      }
    }

    console.log('');
    console.log('seed: complete.');
    console.log(`  school:  ${DEMO_SCHOOL_SLUG} (id=${schoolId})`);
    console.log(`  admin:   ${DEMO_ADMIN_EMAIL} / ${DEMO_ADMIN_PASSWORD}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('seed: failed:', err);
  process.exit(1);
});
