#!/usr/bin/env node
// apps/web/scripts/build-changelog.ts
//
// Pre-build hook that runs `git log` against the repo and writes the
// most recent 50 commits to apps/web/app/data/changelog.json. The
// /changelog route reads that JSON at runtime so the timeline stays
// in sync with every release without manual editing.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const outPath = resolve(repoRoot, 'apps/web/app/data/changelog.json');

interface Commit {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
  body: string;
}

const MAX_COMMITS = 50;

// Field separator = control-A (\x01). Why not NUL (\x00)?
// bash's `$(...)` command substitution silently strips NUL bytes
// from captured output, so a printf-built format string with NULs
// loses them when stored in $fmt. control-A (and any byte 0x01..0xFF)
// is safe in bash variables. git's --format uses %xNN for byte NN,
// so %x01 in the format string produces a real \x01 byte in output.
const FIELD_SEP = '\x01';
const RECORD_SEP = '\x01\n';

function parseLog(raw: string): Commit[] {
  const records = raw
    .split(RECORD_SEP)
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.length > 0);
  return records.map((record) => {
    const parts = record.split(FIELD_SEP);
    const hash = (parts[0] ?? '').trim();
    const date = (parts[1] ?? '').trim();
    const subject = (parts[2] ?? '').trim();
    const body = (parts.slice(3).join(FIELD_SEP)).trim();
    return { hash, shortHash: hash.slice(0, 7), date, subject, body };
  });
}

function main(): void {
  // Skip when not running inside a git checkout. The Docker build
  // context excludes .git (see .dockerignore), so container builds
  // must rely on the JSON that was committed alongside the script.
  // Local builds (where .git exists) regenerate the JSON fresh.
  const gitDir = resolve(repoRoot, '.git');
  if (!existsSync(gitDir)) {
    console.log(
      `[changelog] no .git at ${gitDir}; using existing ${outPath} (committed snapshot).`,
    );
    return;
  }

  // Build the --format string inside bash via printf so the \x01
  // bytes are REAL (not the literal text '\x01' that JSON.stringify
  // would produce from a TS string). Node refuses NUL bytes in
  // execSync args, so we cannot inject them from this side; bash's
  // printf interprets \x01 as byte 0x01 when constructing $fmt.
  //
  // Format: %H\x01%ad\x01%s\x01%b\x01\n (real bytes).
  // git output ends each commit with body\x01\n and adds an extra
  // \n between commits (built-in separator), so the inter-commit
  // sequence is \x01\n\n. The parser strips the leading \n before
  // parsing the next record.
  const gitCmd = [
    `cd ${JSON.stringify(repoRoot)}`,
    `fmt=$(printf '%s\\x01%s\\x01%s\\x01%s\\x01\\n' '%H' '%ad' '%s' '%b')`,
    `git log -n ${MAX_COMMITS} --format="$fmt" --date=short`,
  ].join(' && ');
  const raw = execSync(gitCmd, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    shell: '/bin/bash',
  });
  const commits = parseLog(raw);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(commits, null, 2) + '\n');
  console.log(`[changelog] wrote ${commits.length} commits -> ${outPath}`);
}

main();