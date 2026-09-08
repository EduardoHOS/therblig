// base_rev — the whole of ADR-010 rev. 2's concurrency story.
//
// The first 12 hex characters of the SHA-256 of the raw file bytes. Every read returns
// one; every write that is not a dry run requires the one you were given.
//
// Chosen over the handle pattern the spec's Stateful Tools section suggests, and over a
// patch_id, because it needs no server state at all: it survives a restart, it survives
// the process being a different process, and it detects an external write — someone
// saving from Camunda Modeler — that a dedup table or a counter could not see.
//
// Honest about what it is not: there is a window between hashing and renaming, so this
// is advisory against a concurrent save, not a lock. The atomic rename guarantees only
// that no reader ever observes a truncated file.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Hash raw bytes. Takes a Buffer or a string; bytes are what is on disk. */
export function revOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

/** Read a file and return both its text and its revision, from the same bytes. */
export async function readWithRev(absPath) {
  const bytes = await readFile(absPath);
  return { xml: bytes.toString('utf8'), rev: revOf(bytes) };
}
