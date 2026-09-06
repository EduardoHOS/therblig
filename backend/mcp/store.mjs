import { randomUUID } from 'node:crypto';

import { parse } from '../core/index.mjs';
import { readBpmn } from '../io/bpmn-file.mjs';

// MCP has no protocol-level session, so nothing can be inferred from the connection. State lives
// here, keyed by a handle the model carries forward as an ordinary tool argument (ADR-010).

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createStore({ root }) {
  const documents = new Map();

  const find = (handle) => {
    const entry = documents.get(handle);
    if (!entry) throw refuse('unknown-handle', `Handle "${handle}" is unknown — open the file again`);
    return entry;
  };

  return {
    async open(path) {
      const { path: confined, xml, document } = await readBpmn(path, { root });
      const handle = randomUUID();
      const rev = randomUUID();
      // Opaque on purpose: a handle that encodes a path invites guessing at another one.
      documents.set(handle, {
        path: confined,
        head: rev,
        revisions: new Map([[rev, { xml, document }]]),
        results: new Map(),
      });
      return { handle, rev };
    },

    // The document a read tool sees is always the published one, never a candidate revision.
    head(handle) {
      const entry = find(handle);
      return { ...entry.revisions.get(entry.head), rev: entry.head, path: entry.path };
    },

    revision(handle, rev) {
      const entry = find(handle);
      const found = entry.revisions.get(rev);
      if (!found) throw refuse('unknown-revision', `Revision "${rev}" is unknown on this handle`);
      return { ...found, path: entry.path };
    },

    // Without protocol resumability a dropped stream means the client re-issues the call, so a
    // mutating tool that is not idempotent double-applies the edit.
    remembered(handle, patchId) {
      return find(handle).results.get(patchId);
    },

    remember(handle, patchId, result) {
      find(handle).results.set(patchId, result);
      return result;
    },

    requireHead(handle, baseRev) {
      const entry = find(handle);
      if (entry.head !== baseRev) {
        throw refuse(
          'stale-revision',
          `base_rev "${baseRev}" is not current — the document is at "${entry.head}"`,
        );
      }
      return entry;
    },

    // A candidate carries the proposal that produced it, so publish judges the edit that was
    // actually proposed instead of re-deriving a risk level from the bytes.
    async candidate(handle, xml, proposal) {
      const entry = find(handle);
      const rev = randomUUID();
      entry.revisions.set(rev, { xml, document: await parse(xml), proposal });
      return rev;
    },

    // Publishing moves the head: the next edit is judged against what is now on disk.
    promote(handle, rev) {
      const entry = find(handle);
      entry.head = rev;
    },
  };
}
