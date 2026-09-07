/**
 * Tool Policy Engine for CodeRelay.
 *
 * Enforces declarative permissions per tool execution:
 * - Safe: Runs without prompting (read-only queries, tests, diagnostics).
 * - Ask: Prompts user for approval before running (file overwrites, package installs, database migrations).
 * - Restricted: Constrained or sandboxed execution.
 * - Blocked: Never permitted to run (catastrophic operations like rm -rf /, force push).
 */

export type ToolPermissionLevel = 'Safe' | 'Ask' | 'Restricted' | 'Blocked';

export interface ToolPolicyRule {
  readonly toolName: string;
  readonly level: ToolPermissionLevel;
  readonly reason: string;
}

export const DEFAULT_TOOL_POLICIES: readonly ToolPolicyRule[] = [
  { toolName: 'read_file', level: 'Safe', reason: 'Read-only inspection of files.' },
  { toolName: 'search_files', level: 'Safe', reason: 'Read-only workspace search.' },
  { toolName: 'list_directory', level: 'Safe', reason: 'Read-only directory listing.' },
  { toolName: 'git_status', level: 'Safe', reason: 'Read-only git status inspection.' },
  { toolName: 'git_diff', level: 'Safe', reason: 'Read-only working tree diff.' },
  { toolName: 'run_tests', level: 'Safe', reason: 'Test execution.' },
  { toolName: 'typecheck', level: 'Safe', reason: 'Language server typecheck.' },

  { toolName: 'write_file', level: 'Ask', reason: 'Modifies workspace files.' },
  { toolName: 'delete_file', level: 'Ask', reason: 'Deletes workspace files.' },
  { toolName: 'terminal_command', level: 'Ask', reason: 'Executes arbitrary shell command.' },
  { toolName: 'db_migration', level: 'Ask', reason: 'Mutates database schemas.' },
  { toolName: 'package_install', level: 'Ask', reason: 'Modifies project dependencies.' },

  { toolName: 'rm_rf_root', level: 'Blocked', reason: 'Catastrophic filesystem destruction.' },
  { toolName: 'git_force_push', level: 'Blocked', reason: 'Overwrites remote repository history.' },
];

export class ToolPolicyEngine {
  private readonly policies = new Map<string, ToolPolicyRule>();

  constructor(customPolicies?: readonly ToolPolicyRule[]) {
    for (const rule of DEFAULT_TOOL_POLICIES) {
      this.policies.set(rule.toolName, rule);
    }
    if (customPolicies) {
      for (const rule of customPolicies) {
        this.policies.set(rule.toolName, rule);
      }
    }
  }

  getPolicy(toolName: string): ToolPolicyRule {
    return (
      this.policies.get(toolName) ?? {
        toolName,
        level: 'Ask',
        reason: 'Default safe-by-default policy for undeclared tools.',
      }
    );
  }

  setPolicy(toolName: string, level: ToolPermissionLevel, reason?: string): void {
    this.policies.set(toolName, {
      toolName,
      level,
      reason: reason ?? `User override set level to ${level}.`,
    });
  }

  listPolicies(): readonly ToolPolicyRule[] {
    return [...this.policies.values()];
  }
}
