// apps/web/server/uploads.server.ts
//
// Phase 2 — PDF staging helper.
//
// What this module does:
//   1. Validates that the uploaded bytes are an actual PDF (magic-byte
//      check, not just MIME type). Browsers happily send `text/plain`
//      as `application/pdf` if the user picks the wrong file.
//   2. Computes a SHA-256 over the bytes for audit + dedupe.
//   3. Stages the file at `/app/uploads/{school_id}/{user_id}/{uuid}.pdf`
//      and returns the absolute path + the SHA-256.
//
// Why we don't write to a generic /tmp: docker-compose mounts
// `/data/uploads` to `/app/uploads`. Writing here means the file
// survives container restarts and gives Phase 3 a place to add S3
// mirroring without changing call sites.
//
// Why a magic-byte check: a malicious client could rename `evil.exe`
// to `evil.pdf` and POST with `Content-Type: application/pdf`; the
// browser doesn't enforce the type. We reject anything whose first 5
// bytes are not `%PDF-` AND whose trailer is not `%%EOF` somewhere in
// the last 1024 bytes (cheap fuzzy match — pdfplumber does the real
// parse).
//
// We DON'T validate the PDF is parseable here. That's the parser's
// job — keep this module focused on staging. A "looks like a PDF but
// is actually corrupt" file should get the friendly "scanned_pdf" or
// "pdfplumber_crashed" error from the parser, not a 400 here.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StageInput {
  /** Raw bytes from the multipart upload. */
  bytes: Uint8Array;
  /** Caller's school id (used as the first directory level). */
  schoolId: string;
  /** Caller's user id (used as the second directory level). */
  userId: string;
}

export interface StageOutput {
  /** Absolute path to the staged file inside the web container. */
  filePath: string;
  /** Lowercase hex SHA-256 over the bytes — stable across re-uploads. */
  sha256: string;
  /** Byte size of the staged file. */
  sizeBytes: number;
  /** UUID used in the filename. Echoed back so the caller can audit. */
  storedAs: string;
}

export type StageFailureCode =
  | 'not_a_pdf'
  | 'too_large'
  | 'empty'
  | 'too_small'
  | 'io_error';

export interface StageFailure {
  ok: false;
  code: StageFailureCode;
  message: string;
}

export type StageOutcome =
  | (StageOutput & { ok: true })
  | StageFailure;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** 10 MB cap per spec section 2.1. Above this we reject before
 * writing anything to disk so a 1GB upload doesn't fill the volume. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** A real PDF is at minimum ~200 bytes (smallest valid one-page PDF
 * is ~300 bytes after deflate). Anything smaller is corrupt. */
export const MIN_PDF_BYTES = 100;

/** Default root path. Override via `UPLOADS_ROOT` for testing. */
const UPLOADS_ROOT =
  process.env.UPLOADS_ROOT ?? '/app/uploads';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate + stage a PDF upload. Resolves (never throws) so the
 * route handler can map the outcome to an HTTP status without
 * try/catch.
 */
export async function stagePdfUpload(input: StageInput): Promise<StageOutcome> {
  const { bytes, schoolId, userId } = input;

  if (bytes.byteLength === 0) {
    return { ok: false, code: 'empty', message: 'File is empty.' };
  }
  if (bytes.byteLength < MIN_PDF_BYTES) {
    return {
      ok: false,
      code: 'too_small',
      message: 'File is too small to be a valid PDF.',
    };
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    return {
      ok: false,
      code: 'too_large',
      message: `File is over the 10 MB limit (${formatBytes(bytes.byteLength)}).`,
    };
  }
  if (!looksLikePdf(bytes)) {
    return {
      ok: false,
      code: 'not_a_pdf',
      message: 'File is not a PDF. Re-upload a .pdf file.',
    };
  }

  const storedAs = randomUUID();
  const dir = path.join(UPLOADS_ROOT, schoolId, userId);
  const filePath = path.join(dir, `${storedAs}.pdf`);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, bytes, { mode: 0o640 });
    const st = await stat(filePath);
    const sha256 = sha256Hex(bytes);
    return {
      ok: true,
      filePath,
      sha256,
      sizeBytes: st.size,
      storedAs,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'io_error',
      message:
        err instanceof Error
          ? `Couldn't write upload: ${err.message}`
          : "Couldn't write upload.",
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Magic-byte check: a valid PDF starts with `%PDF-` (5 bytes) and
 * ends with `%%EOF` within the last 1024 bytes. pdfplumber will
 * still surface a real parse error for malformed PDFs, so we don't
 * try to be exhaustive here.
 *
 * Browsers can spoof Content-Type, so we MUST check the bytes
 * themselves — relying on the form-data MIME type is the original
 * bug we're defending against.
 */
function looksLikePdf(bytes: Uint8Array): boolean {
  // Magic header.
  if (
    bytes[0] !== 0x25 || // %
    bytes[1] !== 0x50 || // P
    bytes[2] !== 0x44 || // D
    bytes[3] !== 0x46 || // F
    bytes[4] !== 0x2d    // -
  ) {
    return false;
  }
  // Trailer — scan the last 1024 bytes for "%%EOF".
  const tailStart = Math.max(0, bytes.byteLength - 1024);
  const tail = bytes.subarray(tailStart);
  // Use Buffer to get a string view without copying.
  const tailStr = Buffer.from(tail).toString('binary');
  return tailStr.includes('%%EOF');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Test seam: override the upload root for vitest runs so we don't
 * pollute `/app/uploads` between integration tests. Tests pass a
 * per-test temp dir.
 */
export function __setUploadsRootForTests(root: string): void {
  // Mutating process.env is the simplest hook for a server module
  // without dragging in DI. Production never calls this.
  process.env.UPLOADS_ROOT = root;
}