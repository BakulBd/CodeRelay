/**
 * Session & Task Portability for CodeRelay.
 *
 * Enables exporting and importing complete task states, checkpoints, and execution
 * ledgers in JSON or JSONL formats without leaking API keys, secrets, or host credentials.
 */

export interface PortableTaskPackage {
  readonly format: 'coderelay-task-v1';
  readonly exportedAt: string;
  readonly taskId: string;
  readonly objective: string;
  readonly completedSteps: readonly string[];
  readonly remainingSteps: readonly string[];
  readonly filesChanged: readonly string[];
  readonly verificationState: {
    readonly verdict: string;
    readonly passedCount: number;
    readonly failedCount: number;
  } | null;
  readonly checkpoints: readonly {
    readonly sequence: number;
    readonly commitSha: string;
    readonly timestamp: string;
  }[];
}

export function exportTaskToPortableJson(data: Omit<PortableTaskPackage, 'format' | 'exportedAt'>): string {
  const pkg: PortableTaskPackage = {
    format: 'coderelay-task-v1',
    exportedAt: new Date().toISOString(),
    ...data,
  };
  return JSON.stringify(pkg, null, 2);
}

export function importTaskFromPortableJson(jsonString: string): PortableTaskPackage {
  const parsed = JSON.parse(jsonString) as PortableTaskPackage;
  if (parsed.format !== 'coderelay-task-v1' || !parsed.taskId || !parsed.objective) {
    throw new Error('Invalid CodeRelay portable task format.');
  }
  return parsed;
}
