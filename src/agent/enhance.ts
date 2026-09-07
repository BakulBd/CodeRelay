/**
 * Prompt Enhancement Engine for CodeRelay.
 *
 * Transforms vague or brief user prompts (e.g. "fix login", "add tests for payment")
 * into structured, high-clarity engineering tasks with:
 * - Goal statement
 * - Scope & target components
 * - Actionable implementation plan
 * - Evidence-backed verification criteria
 */

export interface EnhancedTaskPrompt {
  readonly original: string;
  readonly goal: string;
  readonly scope: string;
  readonly plan: readonly string[];
  readonly verification: readonly string[];
  readonly formattedMarkdown: string;
}

export function generateEnhancedTask(rawText: string, workspaceFiles?: readonly string[]): EnhancedTaskPrompt {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      original: '',
      goal: 'Perform workspace engineering task',
      scope: 'Workspace',
      plan: ['Inspect relevant files', 'Implement necessary modifications', 'Run verification'],
      verification: ['Typecheck', 'Run test suites'],
      formattedMarkdown: '',
    };
  }

  // Derive relevant scope from prompt keywords and workspace files
  const lower = trimmed.toLowerCase();
  let scope = 'Workspace';
  if (/auth|login|signup|jwt|token|session/i.test(lower)) {
    scope = workspaceFiles?.find((f) => /auth|login|session/i.test(f)) ?? 'src/auth (Authentication & Session)';
  } else if (/pay|checkout|stripe|billing|invoice/i.test(lower)) {
    scope = workspaceFiles?.find((f) => /pay|billing/i.test(f)) ?? 'src/payment (Billing & Transactions)';
  } else if (/test|spec|assert/i.test(lower)) {
    scope = 'test/ (Test Suites & Verifications)';
  } else if (/api|endpoint|route|server/i.test(lower)) {
    scope = 'src/api (API Endpoints & Routing)';
  } else if (/db|database|schema|migration|prisma|sql/i.test(lower)) {
    scope = 'database / schema (Data persistence)';
  }

  // Derive goal
  let goal = trimmed;
  if (!/^(fix|add|implement|refactor|create|build|update|debug)/i.test(trimmed)) {
    goal = `Implement: ${trimmed}`;
  }

  // Derive plan
  const plan: string[] = [
    `Inspect relevant components in ${scope} and review active patterns.`,
    `Identify root cause, missing edge cases, or required architectural additions.`,
    `Implement clean, minimal, type-safe modifications without breaking existing contracts.`,
    `Address regression risks and ensure edge-case handling is complete.`,
  ];

  if (/bug|fix|error|fail|crash|broken/i.test(lower)) {
    plan.unshift('Reproduce the reported failure with a targeted test case or diagnostic probe.');
  }

  // Derive verification
  const verification: string[] = [
    'Execute TypeScript compiler (`tsc --noEmit`) to ensure type safety.',
    'Run relevant project test suites (`npm test`) to confirm passing behavior.',
    'Check workspace diagnostics to verify zero compiler or linter errors.',
  ];

  const formattedMarkdown =
    `# Objective\n${goal}\n\n` +
    `## Scope\n- ${scope}\n\n` +
    `## Implementation Plan\n` +
    plan.map((p, i) => `${i + 1}. ${p}`).join('\n') +
    `\n\n## Verification Criteria\n` +
    verification.map((v) => `- [ ] ${v}`).join('\n');

  return {
    original: trimmed,
    goal,
    scope,
    plan,
    verification,
    formattedMarkdown,
  };
}
