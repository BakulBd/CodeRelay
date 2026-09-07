/**
 * Every source file must be text.
 *
 * This exists because the same defect has been introduced three separate times:
 * a raw NUL byte used as a key separator inside a template literal. It compiles
 * and runs correctly — the escape and a literal zero byte are the same
 * character at runtime — but it makes the file *binary* to tooling, and `grep`
 * then skips it silently. A search for a symbol returns nothing, and the reader
 * concludes the symbol does not exist.
 *
 * The fix is always the same: write the two-character escape. This test is what
 * stops the fourth occurrence.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/** Control characters that are legitimate in source: tab, LF, CR. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'out') {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (/\.(ts|js|css|json|md|svg)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

test('no source file contains a raw control byte', () => {
  const root = process.cwd();
  const offenders: string[] = [];

  for (const path of [
    ...walk(join(root, 'src')),
    ...walk(join(root, 'test')),
    ...walk(join(root, 'media')),
  ]) {
    const bytes = readFileSync(path);
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = bytes[i] ?? 0;
      if (byte < 0x20 && !ALLOWED.has(byte)) {
        const line = bytes.subarray(0, i).toString('utf8').split('\n').length;
        offenders.push(`${path.slice(root.length + 1)}:${line} (0x${byte.toString(16)})`);
        break;
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a raw control byte makes a file binary to grep, which then skips it silently — write the escape sequence instead',
  );
});
