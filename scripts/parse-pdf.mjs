// parse-pdf.mjs — run pdf-parser on a local PDF and dump the result.
// Usage: tsx scripts/parse-pdf.mjs /path/to/file.pdf
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parsePdf } from '../apps/web/server/pdf-parser.server.ts';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: tsx scripts/parse-pdf.mjs <file>');
  process.exit(1);
}

const fileBuf = readFileSync(filePath);
const sha256 = createHash('sha256').update(fileBuf).digest('hex');

const result = await parsePdf({ filePath, sha256, timeoutMs: 15000 });

if (result.ok) {
  console.log(`OK Parsed in ${result.durationMs}ms -- cycle length: ${result.cycleLength}`);
  console.log(`Rows (${result.rows.length}):`);
  for (const row of result.rows.slice(0, 30)) {
    console.log(`  ${row.day ?? '?'} ${row.period ?? '?'}  ${row.startTime ?? '?'}-${row.endTime ?? '?'}  ${row.staff ?? '?'}  -> ${row.location ?? '?'}`);
    if (row.notes) console.log(`     notes: ${row.notes.slice(0, 80)}`);
  }
  if (result.rows.length > 30) {
    console.log(`  ... and ${result.rows.length - 30} more rows`);
  }
} else {
  console.log(`FAIL Parse failed: ${result.code}`);
  console.log(`  message: ${result.message}`);
}
