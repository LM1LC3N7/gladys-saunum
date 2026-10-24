// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container):
//   - the time of the last read (written at most once a minute, BEFORE the
//     read), so a restart never reads sooner than the interval;
//   - the guard of a turn off that a start may have overtaken (a start sent
//     without answer before it): the reads of the next 2 min send the turn
//     off again if the sauna heats, even after a restart.
// Nothing secret (the panel has no password). The file is readable by the
// container user only (0600), bounded and repaired when read back (a
// hand-edited or damaged file never stops the integration for good).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/saunum-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 16 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/**
 * The persisted state, repaired and bounded (wall clock times):
 * `{ lastAttemptAt: number | null, stopGuard: { until, reasserts, target } | null }`
 * (`target`: the address of the panel the guard belongs to).
 */
export function normalizeMemory(raw, now) {
  const data = object(raw);
  const guard = object(data.stopGuard);
  return {
    // A time in the future (a clock set back) counts as now: never a longer wait than the interval.
    lastAttemptAt:
      Number.isFinite(data.lastAttemptAt) && data.lastAttemptAt > 0
        ? Math.min(data.lastAttemptAt, now)
        : null,
    stopGuard:
      Number.isFinite(guard.until) &&
      guard.until > now &&
      typeof guard.target === 'string' &&
      guard.target.length <= 300 &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/.test(guard.target)
        ? {
            target: guard.target,
            // Capped from now: an edited file or a clock jump never keeps it longer.
            until: Math.min(guard.until, now + TIMINGS.guard),
            reasserts:
              Number.isInteger(guard.reasserts) && guard.reasserts >= 0
                ? Math.min(guard.reasserts, TIMINGS.stopReasserts)
                : 0,
          }
        : null,
  };
}
