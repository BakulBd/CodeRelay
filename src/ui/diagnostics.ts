/**
 * Diagnostics reporting for CodeRelay.
 *
 * Provides a clean, secret-free system report showing extension health,
 * active configuration, models, storage, and recent errors.
 *
 * Fully decoupled from the VS Code runtime so it can be tested purely with node --test.
 */
import { listTasks } from '../continuity/tasks.js';
import { ExecutionLedger } from '../continuity/ledger.js';

export interface DiagnosticsData {
  readonly extVersion: string;
  readonly codeVersion: string;
  readonly storagePath: string | null;
  readonly providers: readonly { readonly id: string; readonly type?: string; readonly enabled?: boolean }[];
  readonly models: readonly { readonly modelId: string; readonly providerId: string; readonly enabled?: boolean }[];
  readonly recentErrors: readonly {
    readonly taskName: string;
    readonly errors: readonly { readonly errorClass: string; readonly message: string }[];
  }[];
  /**
   * Proxy settings CodeRelay can see, or null when it was not asked.
   *
   * Reported because "every request fails behind our proxy" is the commonest
   * enterprise failure and the least self-explanatory. Stated carefully: this
   * is what CodeRelay *detected*, not what it routes through — Node's `fetch`
   * does not honour `HTTPS_PROXY` on its own, and claiming otherwise would send
   * someone hunting the wrong bug.
   */
  readonly proxy?: {
    readonly proxyUrl: string | null;
    readonly strictSsl: boolean;
    readonly noProxy: readonly string[];
    readonly customCaPath: string | null;
  } | null;
}

/**
 * Pure formatter for diagnostics report markdown.
 * Guaranteed never to interpolate secret tokens or credentials.
 */
export function formatDiagnosticsReport(data: DiagnosticsData): string {
  let report = `# CodeRelay Diagnostics\n\n`;
  report += `## System\n`;
  report += `- **CodeRelay Version:** ${data.extVersion}\n`;
  report += `- **VS Code Version:** ${data.codeVersion}\n`;
  report += `- **Storage Path:** ${data.storagePath ?? 'Not available (No workspace opened)'}\n\n`;

  if (data.proxy !== undefined && data.proxy !== null) {
    report += `## Network\n`;
    // Stated as detection, not as behaviour: Node's `fetch` does not route
    // through HTTPS_PROXY on its own, and implying it does would send someone
    // hunting the wrong bug when requests fail behind a corporate proxy.
    report += `CodeRelay reads these but does **not** tunnel through a proxy itself.\n`;
    report += `- **Proxy detected:** ${data.proxy.proxyUrl ?? 'none'}\n`;
    report += `- **Strict TLS:** ${data.proxy.strictSsl ? 'on' : 'off'}\n`;
    report += `- **Bypass rules:** ${data.proxy.noProxy.join(', ') || 'none'}\n`;
    report += `- **Extra CA bundle:** ${data.proxy.customCaPath ?? 'none'}\n\n`;
  }

  report += `## Configuration\n`;
  report += `- **Configured Providers:** ${data.providers.length}\n`;
  for (const p of data.providers) {
    report += `  - \`${p.id}\` (${p.type ?? 'custom'}) — ${p.enabled !== false ? 'Enabled' : 'Disabled'}\n`;
  }
  if (data.providers.length === 0) {
    report += `  - *(No providers configured)*\n`;
  }

  report += `- **Configured Models:** ${data.models.length}\n`;
  for (const m of data.models) {
    report += `  - \`${m.modelId}\` (via \`${m.providerId}\`) — ${m.enabled !== false ? 'Enabled' : 'Disabled'}\n`;
  }
  if (data.models.length === 0) {
    report += `  - *(No models configured)*\n`;
  }
  report += `\n`;

  report += `## Recent Errors\n`;
  if (data.recentErrors.length === 0) {
    report += `- No recent errors found in task history.\n`;
  } else {
    for (const item of data.recentErrors) {
      report += `### Task: ${item.taskName}\n`;
      for (const err of item.errors) {
        report += `- **${err.errorClass}:** ${err.message}\n`;
      }
    }
  }

  return report;
}

export interface CollectDiagnosticsOptions {
  readonly extVersion: string;
  readonly codeVersion: string;
  readonly storagePath: string | null;
  readonly providers: readonly { id: string; type?: string; enabled?: boolean }[];
  readonly models: readonly { modelId: string; providerId: string; enabled?: boolean }[];
  /** Detected proxy settings, passed through to the report. */
  readonly proxy?: DiagnosticsData['proxy'];
}

/**
 * Collects runtime state and formats a full diagnostic report.
 */
export async function buildDiagnosticsReport(opts: CollectDiagnosticsOptions): Promise<string> {
  const recentErrors: Array<{
    taskName: string;
    errors: Array<{ errorClass: string; message: string }>;
  }> = [];

  if (opts.storagePath) {
    try {
      const tasks = await listTasks(opts.storagePath);
      for (const t of tasks.slice(0, 5)) {
        const entries = await ExecutionLedger.readEntries(t.filePath).catch(() => []);
        const failures = entries.filter((e) => e.type === 'FAILED');
        if (failures.length > 0) {
          recentErrors.push({
            taskName: t.objective ?? t.taskId,
            errors: failures.map((f) => ({
              errorClass: f.type === 'FAILED' ? f.errorClass : 'UNKNOWN',
              message: f.type === 'FAILED' ? f.message : 'Unknown error',
            })),
          });
        }
      }
    } catch {
      // Storage read issues are non-fatal for diagnostics
    }
  }

  return formatDiagnosticsReport({
    extVersion: opts.extVersion,
    codeVersion: opts.codeVersion,
    storagePath: opts.storagePath,
    providers: opts.providers,
    models: opts.models,
    recentErrors,
    ...(opts.proxy === undefined ? {} : { proxy: opts.proxy }),
  });
}
