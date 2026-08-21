import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { FileFingerprint } from '../continuity/entries.js';
import { predictedFingerprint } from '../workspace/probe.js';
import {
  registerTool,
  type RegisteredTool,
  type ToolContext,
  type ToolSpec,
} from './tool.js';


interface WriteArgs {
  readonly path: string;
  readonly content: string;
}

interface ReadArgs {
  readonly path: string;
}

/**
 * Rejects paths that escape the workspace root.
 *
 * A model can emit any string it likes, and `../../.ssh/authorized_keys` is a
 * plausible hallucination as well as an attack. Containment is enforced here,
 * at the boundary, rather than trusted anywhere downstream.
 */
export function resolveInside(root: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${path}" is outside the workspace root`);
  }
  return absolute;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Tool argument "${field}" must be a non-empty string`);
  }
  return value;
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Tool arguments must be an object');
  }
  return args as Record<string, unknown>;
}

/**
 * Replaces a file's entire contents.
 *
 * Idempotent by construction: the content is fixed in the arguments, so running
 * it twice leaves the same bytes. That, plus a predictable post-state, is what
 * lets recovery adopt an interrupted write instead of asking the user.
 *
 * The write goes to a temporary file and is then renamed, so a crash mid-write
 * cannot leave a half-written file that matches neither the pre- nor the
 * post-state — the one workspace shape recovery cannot resolve on its own.
 */
export const writeFileTool: RegisteredTool = registerTool<WriteArgs>({
  name: 'write_file',
  safety: 'idempotent',
  parse(args) {
    const rec = asRecord(args);
    const content = rec['content'];
    if (typeof content !== 'string') {
      throw new Error('Tool argument "content" must be a string');
    }
    return { path: requireString(rec['path'], 'path'), content };
  },
  affectedPaths({ path }) {
    return [path];
  },
  predictPostState({ path, content }) {
    return [predictedFingerprint(path, content)];
  },
  async execute({ path, content }, ctx) {
    const absolute = resolveInside(ctx.root, path);
    await mkdir(dirname(absolute), { recursive: true });

    const temp = `${absolute}.coderelay-tmp`;
    await writeFile(temp, content, 'utf8');
    await rename(temp, absolute);

    const lines = content.length === 0 ? 0 : content.split('\n').length;
    return `wrote ${content.length} bytes (${lines} lines) to ${path}`;
  },
});

/** Deletes a file. Idempotent: the post-state is simply "absent". */
export const deleteFileTool: RegisteredTool = registerTool<ReadArgs>({
  name: 'delete_file',
  safety: 'idempotent',
  parse(args) {
    return { path: requireString(asRecord(args)['path'], 'path') };
  },
  affectedPaths({ path }) {
    return [path];
  },
  predictPostState({ path }): readonly FileFingerprint[] {
    return [{ path, sha256: null, sizeBytes: null }];
  },
  async execute({ path }, ctx) {
    await rm(resolveInside(ctx.root, path), { force: true });
    return `deleted ${path}`;
  },
});

/** Reads a file. Pure, so an interrupted read is always safe to repeat. */
export const readFileTool: RegisteredTool = registerTool<ReadArgs>({
  name: 'read_file',
  safety: 'pure',
  parse(args) {
    return { path: requireString(asRecord(args)['path'], 'path') };
  },
  affectedPaths() {
    return [];
  },
  predictPostState() {
    return null;
  },
  async execute({ path }, ctx: ToolContext) {
    return readFile(resolveInside(ctx.root, path), 'utf8');
  },
});

export const builtinFileTools: readonly RegisteredTool[] = [
  writeFileTool,
  deleteFileTool,
  readFileTool,
];

/**
 * What providers are told about the builtin tools.
 *
 * Kept beside the tools rather than inside a prompt builder so a tool and its
 * advertised contract cannot drift apart. Descriptions state the containment
 * rule explicitly, because a model told the constraint up front asks for a legal
 * path instead of producing a call that has to be rejected.
 */
export const builtinToolSpecs: readonly ToolSpec[] = [
  {
    name: 'write_file',
    description:
      'Replace the entire contents of a file, creating it and any missing parent ' +
      'directories. The path must be inside the workspace.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to write.' },
        content: { type: 'string', description: 'The complete new file contents.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file inside the workspace. Succeeds if it is already absent.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to delete.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 file inside the workspace and return its contents.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to read.' },
      },
      required: ['path'],
    },
  },
];

