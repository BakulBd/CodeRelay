import { registerTool, type RegisteredTool, type ToolSpec } from './tool.js';

interface ProposePlanArgs {
  readonly title: string;
  readonly plan_markdown: string;
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Tool arguments must be an object');
  }
  return args as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Tool argument "${field}" must be a non-empty string`);
  }
  return value;
}

export const proposePlanSpec: ToolSpec = {
  name: 'propose_plan',
  description: 'Propose an implementation plan for the user to review and approve before writing any code.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short, descriptive title for the plan.' },
      plan_markdown: { type: 'string', description: 'The detailed implementation plan formatted in Markdown.' },
    },
    required: ['title', 'plan_markdown'],
  },
};

/**
 * Proposes a plan to the user in Architect mode.
 * The tool is pure from the workspace's perspective, but it triggers a loop exit
 * returning PLAN_PROPOSED or ESCALATED depending on how we handle it in `loop.ts`.
 */
export const proposePlanTool: RegisteredTool = registerTool<ProposePlanArgs>({
  name: 'propose_plan',
  safety: 'pure',
  parse(args) {
    const rec = asRecord(args);
    return {
      title: requireString(rec['title'], 'title'),
      plan_markdown: requireString(rec['plan_markdown'], 'plan_markdown'),
    };
  },
  affectedPaths() {
    return [];
  },
  predictPostState() {
    return [];
  },
  async execute({ title, plan_markdown }) {
    // The ToolRunner just executes this. The real intercept happens in loop.ts.
    return JSON.stringify({ title, plan_markdown });
  },
});
