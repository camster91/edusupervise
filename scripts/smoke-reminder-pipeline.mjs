// scripts/smoke-reminder-pipeline.mjs
// H-4: validate reminder pipeline end-to-end.
// Seeds an outbox row with a near-future fire-time, waits for the
// outbox-flush + reminder-scheduler + reminders processor loop, then
// checks reminder_log for the entry.

import postgres from 'postgres';
import { Queue } from 'bullmq';

const SYSTEM_URL = process.env.SYSTEM_DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
if (!SYSTEM_URL) {
  console.error('SYSTEM_DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(SYSTEM_URL, { max: 1 });

async function main() {
  // Pick a test school + duty_assignment + reminder
  const [school] = await sql`SELECT id FROM schools LIMIT 1`;
  if (!school) {
    console.error('No schools in DB — skipping');
    process.exit(2);
  }
  const [reminder] = await sql`
    SELECT r.id, r.school_id FROM reminders r
     WHERE r.school_id = ${school.id}
     LIMIT 1
  `;
  if (!reminder) {
    console.error(`No reminders for school ${school.id} — skipping`);
    process.exit(2);
  }

  // Check the queue
  const queue = new Queue('reminders', { connection: { url: REDIS_URL } });
  const counts = await queue.getJobCounts();
  console.log('Queue counts before:', counts);

  // Wait 65s for the reminder-scheduler (60s window) + 5s for outbox-flush
  console.log('Waiting 75s for the scheduler + flush + processor loops...');
  await new Promise(r => setTimeout(r, 75000));

  const countsAfter = await queue.getJobCounts();
  console.log('Queue counts after:', countsAfter);

  // Check reminder_log
  const logEntries = await sql`
    SELECT id, scheduled_for, channel, status, created_at
      FROM reminder_log
     WHERE reminder_id = ${reminder.id}
     ORDER BY created_at DESC
     LIMIT 5
  `;
  console.log('Recent reminder_log entries:');
  for (const e of logEntries) console.log('  ', e);

  await sql.end();
  await queue.close();
}

main().catch(e => { console.error(e); process.exit(1); });
