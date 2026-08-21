import type { FileFingerprint } from '../continuity/entries.js';
import type { ToolSafety } from '../core/types.js';
import type { WorkspaceProbe } from '../recovery/replay.js';

/** What a tool is allowed to reach at execution time. */
export interface ToolContext {
  /** Workspace root that relative paths resolve against. */
  readonly root: string;
  readonly probe: WorkspaceProbe;
  /**
   * Where an `unsafe` tool records that it started.
   *
   * Supplied by `ToolRunner`, named after the call's `SideEffectKey`. Only tools
   * whose effect the workspace cannot describe need it: the file's existence is
   * evidence that execution began, and a recorded exit code is evidence that it
   * finished, which is what lets recovery settle an interrupted command from
   * disk instead of asking. Optional so the file tools, which have real
   * fingerprints, ignore it entirely.
   */
  readonly effectLogPath?: string;
  /** Cancels a long-running tool when the task is stopped. */
  readonly signal?: AbortSignal;
  /** Overrides the per-command timeout. */
  readonly commandTimeoutMs?: number;
}

/**
 * JSON Schema for a tool's arguments, sent to providers verbatim.
 *
 * Declared here rather than assembled in a provider module because a schema is
 * a property of the tool, and every provider on the target list accepts this
 * same object — Anthropic as `input_schema`, OpenAI-compatible endpoints as
 * `function.parameters`, Gemini as `functionDeclarations[].parameters`. It is
 * advisory only: `parse` still validates every call, because a model can ignore
 * a schema and a provider can fail to enforce one.
 */
export interface ToolSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

/** What a provider needs to be told about one tool. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: ToolSchema;
}

/**
 * A tool the agent can call.
 *

 * The unusual members are `affectedPaths` and `predictPostState`. They exist so
 * the ledger can record, *before* the tool runs, both what the workspace looked
 * like and what it should look like afterwards. Recovery needs no tool-specific
 * knowledge as a result: it just compares fingerprints.
 *
 * A tool that cannot predict its own post-state returns null and thereby opts
 * into escalation on an ambiguous restart. That is the honest answer for a shell
 * command, and it is better than a guess.
 */
export interface ToolDefinition<A> {
  readonly name: string;
  readonly safety: ToolSafety;
  /** Validates raw model-supplied arguments. Throws on anything unusable. */
  parse(args: unknown): A;
  /** Files this call may change. Used to capture the pre-state. */
  affectedPaths(args: A): readonly string[];
  /** The fingerprints the workspace should have afterwards, or null if unknowable. */
  predictPostState(args: A): readonly FileFingerprint[] | null;
  /** Performs the effect. Returns a short human-readable summary. */
  execute(args: A, ctx: ToolContext): Promise<string>;
}

/**
 * A tool with its argument type erased, so one registry can hold them all
 * without the runner needing to know each tool's shape.
 */
export interface RegisteredTool {
  readonly name: string;
  readonly safety: ToolSafety;
  /** Parses once and derives everything the ledger needs before execution. */
  plan(args: unknown): {
    readonly paths: readonly string[];
    readonly expectedPostState: readonly FileFingerprint[] | null;
  };
  execute(args: unknown, ctx: ToolContext): Promise<string>;
}

/** Erases the argument type while keeping validation in one place. */
export function registerTool<A>(def: ToolDefinition<A>): RegisteredTool {
  return {
    name: def.name,
    safety: def.safety,
    plan(args: unknown) {
      const parsed = def.parse(args);
      return {
        paths: def.affectedPaths(parsed),
        expectedPostState: def.predictPostState(parsed),
      };
    },
    // `async` so a parse failure surfaces as a rejected promise rather than a
    // synchronous throw. The declared type is `Promise<string>`, and a caller
    // that trusts it — anything using `.catch` instead of try/await — would miss
    // a synchronous throw entirely.
    async execute(args: unknown, ctx: ToolContext) {
      return def.execute(def.parse(args), ctx);
    },
  };
}

/** Name-indexed set of available tools. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(tools: readonly RegisteredTool[] = []) {
    for (const t of tools) {
      this.add(t);
    }
  }

  add(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      // Two tools under one name would make the ledger ambiguous about which
      // one ran, so this is a startup error rather than last-one-wins.
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool "${name}"`);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }
}
