import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { FileFingerprint } from '../continuity/entries.js';
import type { SideEffectKey } from '../core/types.js';
import type { EffectLogReader, EffectRecord, WorkspaceProbe } from '../recovery/replay.js';

/** Content hash used everywhere a file state is compared. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Reads real file state for recovery decisions.
 *
 * Two rules matter here, and both exist to keep `planRecovery` sound:
 *
 * 1. A missing file is reported as `sha256: null`. Absence is a *fact*, and the
 *    expected post-state of a delete is exactly this.
 * 2. Any other error is thrown, never mapped to null. "I could not read it"
 *    must not masquerade as "it is not there", because that would let recovery
 *    conclude a write never landed and re-run it.
 */
export class FileSystemProbe implements WorkspaceProbe {
  /** @param root Base directory that relative ledger paths resolve against. */
  constructor(private readonly root: string) {}

  async fingerprint(path: string): Promise<FileFingerprint> {
    const absolute = isAbsolute(path) ? path : resolve(this.root, path);
    try {
      const buf = await readFile(absolute);
      return { path, sha256: sha256Hex(buf), sizeBytes: buf.byteLength };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EISDIR: a directory occupies the path, so the *file* does not exist.
      if (code === 'ENOENT' || code === 'EISDIR') {
        return { path, sha256: null, sizeBytes: null };
      }
      throw err;
    }
  }
}

/** Fingerprints several paths, preserving order. */
export async function fingerprintAll(
  probe: WorkspaceProbe,
  paths: readonly string[],
): Promise<FileFingerprint[]> {
  const out: FileFingerprint[] = [];
  for (const p of paths) {
    out.push(await probe.fingerprint(p));
  }
  return out;
}

/** The fingerprint a path will have once `content` is written to it. */
export function predictedFingerprint(path: string, content: string): FileFingerprint {
  const buf = Buffer.from(content, 'utf8');
  return { path, sha256: sha256Hex(buf), sizeBytes: buf.byteLength };
}


/**
 * Reads the effect logs `unsafe` tools write.
 *
 * The parsing is deliberately trivial — the presence of an `exit:` line is the
 * whole signal — because this file is evidence about a crash, and evidence that
 * needs a careful parser is evidence that can be misread. Anything unreadable is
 * reported as `started`, which is the conservative answer: it sends the case to
 * the user rather than concluding the command finished.
 */
export class FileSystemEffectLog implements EffectLogReader {
  constructor(private readonly dir: string) {}

  async read(sideEffectKey: SideEffectKey): Promise<EffectRecord | null> {
    let text: string;
    try {
      text = await readFile(join(this.dir, `${sideEffectKey}.log`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No log at all: the tool never reached the point of writing one.
        return null;
      }
      throw err;
    }

    const match = /^exit:\s*(-?\d+|killed)\s*$/m.exec(text);
    if (match === null) {
      return { t: 'started' };
    }
    const raw = match[1];
    return { t: 'finished', exitCode: raw === 'killed' || raw === undefined ? null : Number(raw) };
  }
}
