/**
 * Project memory: the handful of facts worth carrying between tasks.
 *
 * Stored as markdown in the workspace, at `CODERELAY.md`, for three reasons
 * that a hidden JSON blob would fail:
 *
 *  1. **It is reviewable.** Memory that steers an agent is as load-bearing as
 *     configuration, and configuration nobody can read is configuration nobody
 *     can correct.
 *  2. **It is version-controllable.** A convention the team agreed on belongs
 *     in the diff alongside the code that follows it.
 *  3. **It is portable.** A plain file is editable without this extension
 *     running, which matters the day something about the extension is broken.
 *
 * The rule that keeps it small: **memory is for what the repository cannot say
 * itself.** Structure, dependencies and history are all readable from the code
 * on demand; duplicating them here produces a file that silently goes stale and
 * then confidently misleads. What belongs here is the undocumented: a
 * convention with no linter behind it, a command nobody would guess, a decision
 * and the reason for it.
 *
 * Deliberately *not* conversation history. Storing transcripts would grow
 * without bound, leak whatever happened to be pasted into a prompt, and bury
 * the few facts that matter.
 */

/** The kinds of fact worth keeping. Anything else belongs in the code. */
export type MemoryCategory =
  | 'architecture'
  | 'conventions'
  | 'commands'
  | 'testing'
  | 'issues'
  | 'decisions';

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'architecture',
  'conventions',
  'commands',
  'testing',
  'issues',
  'decisions',
];

/** Heading text used in the file, and shown in the UI. */
export const CATEGORY_HEADINGS: Readonly<Record<MemoryCategory, string>> = {
  architecture: 'Architecture',
  conventions: 'Conventions',
  commands: 'Commands',
  testing: 'Testing',
  issues: 'Known issues',
  decisions: 'Decisions',
};

/** What each section is for, shown as guidance when it is empty. */
export const CATEGORY_HINTS: Readonly<Record<MemoryCategory, string>> = {
  architecture: 'How the pieces fit together, where that is not obvious from the tree.',
  conventions: 'Rules the code follows that no linter enforces.',
  commands: 'Commands nobody would guess from package.json alone.',
  testing: 'How to run and write tests here.',
  issues: 'Known breakage, so the agent does not spend a turn rediscovering it.',
  decisions: 'Choices already made, and why — so they are not silently reversed.',
};

export interface MemoryNote {
  readonly id: string;
  readonly category: MemoryCategory;
  readonly text: string;
  /**
   * Whether the agent is given this note.
   *
   * Disabling keeps the text but withholds it, which is what a user wants when
   * a note has become wrong but they are not yet sure what replaces it.
   * Represented in the file as a struck-through bullet, so the state is visible
   * to a reader of the markdown too.
   */
  readonly enabled: boolean;
}

export interface ProjectMemory {
  readonly notes: readonly MemoryNote[];
  /**
   * Content that was in the file but is not a note under a known heading.
   *
   * Preserved verbatim and written back unchanged. A tool that silently ate the
   * parts of a file it did not understand would be one nobody could trust with
   * a file they also edit by hand.
   */
  readonly preamble: string;
}

const HEADING_BY_TEXT = new Map<string, MemoryCategory>(
  MEMORY_CATEGORIES.map((c) => [CATEGORY_HEADINGS[c].toLowerCase(), c]),
);

/** Also accept a few obvious synonyms, so a hand-written file still parses. */
const SYNONYMS: Readonly<Record<string, MemoryCategory>> = {
  'known issues': 'issues',
  issues: 'issues',
  gotchas: 'issues',
  architecture: 'architecture',
  structure: 'architecture',
  conventions: 'conventions',
  style: 'conventions',
  commands: 'commands',
  scripts: 'commands',
  testing: 'testing',
  tests: 'testing',
  decisions: 'decisions',
};

function categoryFor(heading: string): MemoryCategory | null {
  const key = heading.trim().toLowerCase();
  return HEADING_BY_TEXT.get(key) ?? SYNONYMS[key] ?? null;
}

/**
 * Parse a memory file.
 *
 * Tolerant on purpose: anything it does not recognise is kept in `preamble` and
 * written back untouched. The file belongs to the user, not to this parser.
 */
export function parseMemory(markdown: string): ProjectMemory {
  const lines = markdown.split(/\r?\n/);
  const notes: MemoryNote[] = [];
  const preamble: string[] = [];
  let current: MemoryCategory | null = null;
  let index = 0;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '#').length;
      const category = categoryFor(heading[2] ?? '');
      current = category;
      // A level-1 heading is the document title, which `renderMemory` writes
      // itself. Keeping it in the preamble too made the file gain a duplicate
      // title on every single save — the parser and the renderer each believed
      // they owned it.
      if (category === null && level > 1) {
        preamble.push(line);
      }
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet === null || current === null) {
      if (current === null && line.trim() !== '') {
        preamble.push(line);
      }
      continue;
    }

    const raw = bullet[1] ?? '';
    // `~~text~~` is a disabled note: still in the file, not given to the agent.
    const struck = /^~~(.*)~~\s*$/.exec(raw.trim());
    const text = (struck?.[1] ?? raw).trim();
    if (text === '') {
      continue;
    }
    index += 1;
    notes.push({
      id: `mem-${index}`,
      category: current,
      text,
      enabled: struck === null,
    });
  }

  return { notes, preamble: preamble.join('\n').trim() };
}

/**
 * Render memory back to markdown.
 *
 * Only sections that have notes are written. An empty file full of empty
 * headings is noise, and it would make the file look maintained when it is not.
 */
export function renderMemory(memory: ProjectMemory): string {
  const parts: string[] = ['# CodeRelay project memory', ''];
  if (memory.preamble !== '') {
    parts.push(memory.preamble, '');
  }

  for (const category of MEMORY_CATEGORIES) {
    const notes = memory.notes.filter((n) => n.category === category);
    if (notes.length === 0) {
      continue;
    }
    parts.push(`## ${CATEGORY_HEADINGS[category]}`, '');
    for (const note of notes) {
      parts.push(note.enabled ? `- ${note.text}` : `- ~~${note.text}~~`);
    }
    parts.push('');
  }

  return `${parts.join('\n').trimEnd()}\n`;
}

/**
 * The text handed to a model.
 *
 * Disabled notes are omitted entirely rather than marked, because a model given
 * "this used to be true" will weigh it anyway. Returns null when there is
 * nothing to say — an empty memory section in a prompt is tokens spent to
 * communicate an absence.
 */
export function renderForPrompt(memory: ProjectMemory): string | null {
  const active = memory.notes.filter((n) => n.enabled);
  if (active.length === 0) {
    return null;
  }

  const parts: string[] = ['Project notes recorded for this repository:'];
  for (const category of MEMORY_CATEGORIES) {
    const notes = active.filter((n) => n.category === category);
    if (notes.length === 0) {
      continue;
    }
    parts.push('', `${CATEGORY_HEADINGS[category]}:`);
    for (const note of notes) {
      parts.push(`- ${note.text}`);
    }
  }
  return parts.join('\n');
}

/** Add a note, returning a new memory. Ids are reassigned so they stay dense. */
export function addNote(
  memory: ProjectMemory,
  category: MemoryCategory,
  text: string,
): ProjectMemory {
  const trimmed = text.trim();
  if (trimmed === '') {
    return memory;
  }
  return reindex({ ...memory, notes: [...memory.notes, { id: 'new', category, text: trimmed, enabled: true }] });
}

export function removeNote(memory: ProjectMemory, id: string): ProjectMemory {
  return reindex({ ...memory, notes: memory.notes.filter((n) => n.id !== id) });
}

export function setEnabled(memory: ProjectMemory, id: string, enabled: boolean): ProjectMemory {
  return {
    ...memory,
    notes: memory.notes.map((n) => (n.id === id ? { ...n, enabled } : n)),
  };
}

export function editNote(memory: ProjectMemory, id: string, text: string): ProjectMemory {
  const trimmed = text.trim();
  if (trimmed === '') {
    return removeNote(memory, id);
  }
  return {
    ...memory,
    notes: memory.notes.map((n) => (n.id === id ? { ...n, text: trimmed } : n)),
  };
}

export const EMPTY_MEMORY: ProjectMemory = { notes: [], preamble: '' };

function reindex(memory: ProjectMemory): ProjectMemory {
  return {
    ...memory,
    notes: memory.notes.map((note, i) => ({ ...note, id: `mem-${i + 1}` })),
  };
}
