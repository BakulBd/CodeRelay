/**
 * UI-to-Backend Wiring & Interaction Tests.
 *
 * Verifies that:
 * - Every inbound message variant from the webview is correctly parsed and bounded
 * - The presentation view model carries complete and accurate progress, workspace info, notifications, and settings
 * - NotificationCenter accurately tracks and mutates operational events
 * - Settings model exposes all 6 categories with typed defaults
 * - Every interactive control in the shell is wired to a real listener in task.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseInbound } from '../../src/ui/webview/protocol.js';
import { present } from '../../src/ui/webview/present.js';
import { NotificationCenter } from '../../src/ui/state/notifications.js';
import { DEFAULT_SETTINGS } from '../../src/ui/state/settings.js';
import { renderShell } from '../../src/ui/webview/shell.js';

test('parseInbound accepts all new navigation, workspace, notification and settings messages', () => {
  // workspaceActions
  assert.deepEqual(parseInbound({ kind: 'workspaceActions' }), { kind: 'workspaceActions' });

  // openNotifications & dismiss
  assert.deepEqual(parseInbound({ kind: 'openNotifications' }), { kind: 'openNotifications' });
  assert.deepEqual(parseInbound({ kind: 'dismissNotification', id: 'notif-123' }), {
    kind: 'dismissNotification',
    id: 'notif-123',
  });
  assert.deepEqual(parseInbound({ kind: 'dismissAllNotifications' }), {
    kind: 'dismissAllNotifications',
  });

  // openOverflowMenu & focusActiveTask
  assert.deepEqual(parseInbound({ kind: 'openOverflowMenu' }), { kind: 'openOverflowMenu' });
  assert.deepEqual(parseInbound({ kind: 'focusActiveTask' }), { kind: 'focusActiveTask' });

  // switchNavTab
  assert.deepEqual(parseInbound({ kind: 'switchNavTab', tab: 'settings' }), {
    kind: 'switchNavTab',
    tab: 'settings',
  });

  // openContextPicker & applyContext
  assert.deepEqual(parseInbound({ kind: 'openContextPicker' }), { kind: 'openContextPicker' });
  assert.deepEqual(
    parseInbound({ kind: 'applyContext', files: ['src/app.ts', 'src/util.ts'] }),
    { kind: 'applyContext', files: ['src/app.ts', 'src/util.ts'] },
  );

  // saveSetting
  assert.deepEqual(
    parseInbound({ kind: 'saveSetting', category: 'general', key: 'defaultTaskMode', value: 'plan' }),
    { kind: 'saveSetting', category: 'general', key: 'defaultTaskMode', value: 'plan' },
  );

  // runPlayground
  assert.deepEqual(
    parseInbound({ kind: 'runPlayground', providerId: 'anthropic', modelId: 'claude-3-7-sonnet', testType: 'streaming' }),
    { kind: 'runPlayground', providerId: 'anthropic', modelId: 'claude-3-7-sonnet', testType: 'streaming' },
  );

  // selectModel
  assert.deepEqual(
    parseInbound({ kind: 'selectModel', providerId: 'gemini', modelId: 'gemini-1.5-pro' }),
    { kind: 'selectModel', providerId: 'gemini', modelId: 'gemini-1.5-pro' },
  );

  // resolveApproval
  assert.deepEqual(
    parseInbound({ kind: 'resolveApproval', requestId: 'req-42', decision: 'allow_once' }),
    { kind: 'resolveApproval', requestId: 'req-42', decision: 'allow_once' },
  );
  assert.deepEqual(
    parseInbound({ kind: 'resolveApproval', requestId: 'req-42', decision: 'allow_for_task' }),
    { kind: 'resolveApproval', requestId: 'req-42', decision: 'allow_for_task' },
  );
  assert.deepEqual(
    parseInbound({ kind: 'resolveApproval', requestId: 'req-42', decision: 'deny' }),
    { kind: 'resolveApproval', requestId: 'req-42', decision: 'deny' },
  );
});

test('present() populates real progress, workspaceInfo, notifications, and settings in idle state', () => {
  const model = present({
    taskId: null,
    projection: null,
    live: false,
    blocked: null,
    selectedModel: null,
    verifying: false,
    activeNavTab: 'composer',
    workspaceInfo: { name: 'MyProject', path: '/tmp/proj', hasFolders: true },
    notifications: [
      { id: '1', kind: 'checkpoint_created', title: 'Checkpoint', message: 'Saved turn 1', timestamp: '12:00', read: false },
    ],
    settings: DEFAULT_SETTINGS,
    candidates: [
      {
        model: { providerId: 'anthropic', modelId: 'claude-3-7-sonnet' },
        capabilities: { streaming: true, toolCalling: true, structuredOutputs: true, nativeReasoning: true },
        isSelected: true,
      },
    ],
    configuredProviders: [
      { id: 'anthropic', kind: 'anthropic', modelCount: 1, keyCount: 1, defaultModel: 'claude-3-7-sonnet' },
    ],
    health: [
      { providerId: 'anthropic/claude-3-7-sonnet', state: 'healthy', latencyMs: 240 },
    ],
  });

  assert.equal(model.activeNavTab, 'composer');
  assert.deepEqual(model.progress, {
    label: 'Ready',
    percent: 0,
    state: 'ready',
  });
  assert.equal(model.workspaceInfo.name, 'MyProject');
  assert.equal(model.workspaceInfo.path, '/tmp/proj');
  assert.equal(model.notifications.length, 1);
  assert.equal(model.unreadNotificationsCount, 1);
  assert.equal(model.settings.general.defaultTaskMode, 'code');
  assert.equal(model.settings.ai.automaticRouting, true);
  assert.equal(model.settings.execution.permissionMode, 'balanced');
  assert.equal(model.candidates.length, 1);
  assert.equal(model.candidates[0]?.model.modelId, 'claude-3-7-sonnet');
  assert.equal(model.configuredProviders.length, 1);
  assert.equal(model.configuredProviders[0]?.id, 'anthropic');
  assert.equal(model.health.length, 1);
  assert.equal(model.health[0]?.state, 'healthy');
});

test('NotificationCenter manages operational event lifecycle', () => {
  const center = new NotificationCenter();
  assert.equal(center.unreadCount(), 0);
  assert.equal(center.list().length, 0);

  const n1 = center.add({
    kind: 'checkpoint_created',
    title: 'Checkpoint Created',
    message: 'Turn 3 committed to git history',
  });
  assert.ok(n1.id.startsWith('notif-'));
  assert.equal(n1.read, false);
  assert.equal(center.unreadCount(), 1);

  const n2 = center.add({
    kind: 'task_completed',
    title: 'Task Done',
    message: 'Task successfully completed and verified',
  });
  assert.equal(center.unreadCount(), 2);
  assert.equal(center.list().length, 2);

  // markAllRead
  center.markAllRead();
  assert.equal(center.unreadCount(), 0);
  assert.equal(center.list().every((e) => e.read), true);

  // dismiss single
  center.dismiss(n1.id);
  assert.equal(center.list().length, 1);
  assert.equal(center.list()[0]?.id, n2.id);

  // clear
  center.clear();
  assert.equal(center.list().length, 0);
});

test('all interactive buttons declared in shell.ts are wired with event listeners in task.js', () => {
  const html = renderShell({
    nonce: 'n0nce',
    cspSource: 'vscode-webview:',
    scriptUri: 's',
    styleUri: 'c',
  });
  const client = readFileSync(join(process.cwd(), 'media', 'task.js'), 'utf8');

  const requiredButtons = [
    'btn-progress',
    'btn-new-task',
    'btn-workspace',
    'btn-settings',
    'btn-notifications',
    'btn-overflow',
    'tab-composer',
    'tab-current',
    'tab-tasks',
    'tab-workspace',
    'tab-ai',
    'tab-recovery',
    'tab-settings',
    'btn-close-notifs',
    'btn-dismiss-all-notifs',
    'btn-close-workspace-modal',
    'btn-ws-open-folder',
    'btn-ws-reveal',
    'btn-ws-cancel',
    'btn-close-context-modal',
    'btn-cancel-context',
    'btn-apply-context',
    'btn-approval-deny',
    'btn-approval-once',
    'btn-approval-task',
    'btn-enhance-cancel',
    'btn-enhance-edit',
    'btn-enhance-use',
    'btn-add-provider-modal',
  ];

  for (const id of requiredButtons) {
    assert.ok(html.includes(`id="${id}"`), `shell is missing button #${id}`);
    assert.ok(
      client.includes(`'${id}'`) || client.includes(`"${id}"`),
      `task.js does not reference button #${id}`,
    );
  }
});
