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

// Cap commit bodies at this length before redaction. Long bodies
// are noise on the public /changelog page; the first ~200 chars always
// contain the headline. Truncation happens BEFORE redaction so the
// "..." suffix doesn't accidentally count toward a redaction match.
const MAX_BODY_CHARS = 200;

// Redact patterns applied to the truncated body. Order matters: run
// the more specific patterns first (emails, then IPs, then hostnames).
// Unicode-aware — accepts both ASCII apostrophe (U+0027) and curly
// apostrophe (U+2019) in free-form prose.
const REDACT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // RFC-ish emails: local@domain.tld
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  // IPv4 (excludes trailing dots / CIDR)
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  // IPv6 (compressed form, rough)
  [/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, '[ip]'],
  // Infra hostnames: ashbi.ca, edusupervise.ashbi.ca, plus subdomains
  [/\b(?:[a-z0-9-]+\.)*edusupervise\.ashbi\.ca\b/gi, '[host]'],
  [/\b(?:[a-z0-9-]+\.)*ashbi\.ca\b/gi, '[host]'],
  // /root/<path> leak — internal filesystem hints
  [/\B\/root\/[a-zA-Z0-9._/-]+/g, '[/path]'],
  // Bearer tokens (sk-, ghp_, gho_, AIza, AKIA prefixes)
  [/\b(?:sk-|ghp_|gho_|AIza|AKIA)[A-Za-z0-9_-]{16,}\b/g, '[token]'],
];

function redactBody(raw: string): string {
  const truncated = raw.length > MAX_BODY_CHARS ? raw.slice(0, MAX_BODY_CHARS) + '\u2026' : raw;
  return REDACT_PATTERNS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    truncated,
  );
}

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
    const body = redactBody(parts.slice(3).join(FIELD_SEP).trim());
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
  // CI / fresh-runner environments may have .git/ but no git binary on
  // PATH (e.g., thin Docker base image). Check before invoking.
  let gitAvailable = false;
  try {
    execSync('git --version', { stdio: 'ignore' });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  if (!gitAvailable) {
    console.log(
      `[changelog] .git present but 'git --version' failed; using existing ${outPath} (committed snapshot).`,
    );
    return;
  }

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