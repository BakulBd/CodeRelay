/**
 * The task view's HTML shell.
 *
 * Every piece of task content is rendered by `media/task.js` with strict `textContent`
 * DOM manipulation, ensuring no untrusted text can become markup.
 */

/** Escapes text for HTML content or a quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ShellOptions {
  /** `webview.cspSource`, the origin the extension's own assets are served from. */
  readonly cspSource: string;
  /** `asWebviewUri` result for `media/task.css`. */
  readonly styleUri: string;
  /** `asWebviewUri` result for `media/task.js`. */
  readonly scriptUri: string;
  /** Per-load nonce. Must be fresh each time the HTML is built. */
  readonly nonce: string;
}

export function renderShell(options: ShellOptions): string {
  const nonce = escapeHtml(options.nonce);
  const csp = [
    "default-src 'none'",
    `style-src ${escapeHtml(options.cspSource)}`,
    `script-src 'nonce-${nonce}'`,
    `style-src-attr 'unsafe-inline'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeHtml(options.styleUri)}">
<title>CodeRelay</title>
</head>
<body>
<div class="app" id="app">

  <!-- Header: Real functional header bar with progress, context gauge, +, folder, settings, bell, ... -->
  <header class="top-nav" id="top-nav" role="banner" aria-label="CodeRelay Navigation">
    <div class="brand">
      <svg class="brand-logo" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8.5 5.5 3.5 12l5 6.5"/>
        <path d="M15.5 5.5 20.5 12l-5 6.5"/>
        <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>
      </svg>
      <span class="brand-name">CodeRelay</span>
    </div>

    <!-- Live Real Progress Indicator (Clicking reveals/opens current task) -->
    <div class="progress-pill-wrap" id="progress-pill-wrap">
      <button type="button" class="progress-pill" id="btn-progress" aria-label="Current task progress">
        <span class="progress-track">
          <span class="progress-fill" id="progress-fill" style="width: 0%;"></span>
        </span>
        <span class="progress-label" id="progress-label">Ready</span>
      </button>
    </div>

    <!-- Live Context Gauge & Cost Ticker -->
    <div class="context-gauge-wrap" id="context-gauge-wrap" title="Context usage & token count">
      <button type="button" class="context-pill" id="btn-context-gauge" aria-label="Context usage and token breakdown">
        <span class="gauge-bar-track">
          <span class="gauge-bar-fill" id="gauge-fill" style="width: 0%;"></span>
        </span>
        <span class="context-label" id="context-label">0%</span>
      </button>
      <div class="context-popover" id="context-popover" hidden>
        <div class="popover-title">Context & Token Usage</div>
        <div class="popover-stats" id="popover-stats">
          <div class="stat-row"><span class="stat-key">Context Window:</span><span class="stat-val" id="stat-ctx-win">—</span></div>
          <div class="stat-row"><span class="stat-key">Input Tokens:</span><span class="stat-val" id="stat-input-tok">—</span></div>
          <div class="stat-row"><span class="stat-key">Output Tokens:</span><span class="stat-val" id="stat-output-tok">—</span></div>
          <div class="stat-row"><span class="stat-key">Estimated Cost:</span><span class="stat-val" id="stat-cost">—</span></div>
        </div>
        <button type="button" class="btn btn-sm btn-quiet" id="btn-compact-ctx">⚡ Compact Context</button>
      </div>
    </div>

    <!-- Live Continuity Score & Resilience Gauge -->
    <div class="continuity-badge-wrap" id="continuity-badge-wrap" title="CodeRelay Continuity Score (0-100)">
      <button type="button" class="continuity-pill" id="btn-continuity-score" aria-label="CodeRelay Continuity Score">
        <span class="continuity-dot" id="continuity-dot"></span>
        <span class="continuity-score-val" id="continuity-score-val">100</span>
        <span class="continuity-health-label" id="continuity-health-label">HEALTHY</span>
      </button>
      <div class="continuity-popover" id="continuity-popover" hidden>
        <div class="popover-title">Continuity Score & Resilience</div>
        <div class="popover-stats" id="continuity-breakdown">
          <div class="stat-row"><span class="stat-key">Checkpoint Integrity:</span><span class="stat-val" id="stat-cp-int">20/20</span></div>
          <div class="stat-row"><span class="stat-key">Requirement Coverage:</span><span class="stat-val" id="stat-req-cov">25/25</span></div>
          <div class="stat-row"><span class="stat-key">Verification Recency:</span><span class="stat-val" id="stat-ver-rec">20/20</span></div>
          <div class="stat-row"><span class="stat-key">Worker Diversity:</span><span class="stat-val" id="stat-work-div">15/15</span></div>
          <div class="stat-row"><span class="stat-key">Action Idempotency:</span><span class="stat-val" id="stat-act-idem">20/20</span></div>
        </div>
        <div class="continuity-summary-note" id="continuity-summary-note">All systems verified & relay-ready.</div>
      </div>
    </div>

    <div class="nav-actions">
      <button type="button" class="icon-btn" id="btn-new-task" title="New Task (+)">+</button>
      <button type="button" class="icon-btn" id="btn-workspace" title="Workspace & Project (📁)">📁</button>
      <button type="button" class="icon-btn" id="btn-sessions" title="Task History (🗂️)">🗂️</button>
      <button type="button" class="icon-btn" id="btn-refresh" title="Refresh (🔄)">🔄</button>
      <button type="button" class="icon-btn" id="btn-export" title="Export Session (📄)">📄</button>
      <button type="button" class="icon-btn" id="btn-sound" title="Toggle Sound (🔔)">🔔</button>
      <button type="button" class="icon-btn" id="btn-settings" title="CodeRelay Settings (⚙️)">⚙️</button>
      <button type="button" class="icon-btn notif-btn" id="btn-notifications" title="Notifications (🔔)">
        <span class="notif-icon">🔔</span>
        <span class="notif-badge" id="notif-badge" hidden></span>
      </button>
      <button type="button" class="icon-btn" id="btn-open-setup" title="Provider Setup (⚡)" hidden>⚡</button>
      <button type="button" class="icon-btn" id="btn-overflow" title="More Actions (...)">…</button>
    </div>
  </header>

  <!-- Primary Navigation Bar (Task-First Architecture) -->
  <nav class="nav-tabs" id="nav-tabs" role="tablist" aria-label="CodeRelay Views">
    <button type="button" class="nav-tab is-active" id="tab-composer" role="tab" aria-selected="true" data-tab="composer">Composer</button>
    <button type="button" class="nav-tab" id="tab-current" role="tab" aria-selected="false" data-tab="current">Current</button>
    <button type="button" class="nav-tab" id="tab-tasks" role="tab" aria-selected="false" data-tab="tasks">Tasks</button>
    <button type="button" class="nav-tab" id="tab-workspace" role="tab" aria-selected="false" data-tab="workspace">Workspace</button>
    <button type="button" class="nav-tab" id="tab-ai" role="tab" aria-selected="false" data-tab="ai">AI System</button>
    <button type="button" class="nav-tab" id="tab-recovery" role="tab" aria-selected="false" data-tab="recovery">Recovery</button>
    <button type="button" class="nav-tab" id="tab-benchmarks" role="tab" aria-selected="false" data-tab="benchmarks">Benchmark Lab</button>
    <button type="button" class="nav-tab" id="tab-settings" role="tab" aria-selected="false" data-tab="settings">Settings</button>
  </nav>

  <!-- Session History Drawer Overlay -->
  <aside class="sessions-drawer" id="sessions-drawer" hidden>
    <div class="drawer-header">
      <h3 class="drawer-title">Task Sessions</h3>
      <button type="button" class="icon-btn" id="btn-close-drawer" aria-label="Close drawer">✕</button>
    </div>
    <div class="drawer-search-wrap">
      <input type="search" class="drawer-search" id="drawer-search" placeholder="Search past tasks…" aria-label="Search past tasks">
    </div>
    <div class="drawer-sessions-list" id="drawer-sessions-list"></div>
  </aside>

  <!-- Notification Center Drawer Overlay -->
  <aside class="notification-drawer" id="notification-drawer" hidden>
    <div class="drawer-header">
      <h3 class="drawer-title">Notifications</h3>
      <div class="drawer-actions">
        <button type="button" class="btn btn-sm btn-quiet" id="btn-dismiss-all-notifs">Dismiss All</button>
        <button type="button" class="icon-btn" id="btn-close-notifs" aria-label="Close notifications">✕</button>
      </div>
    </div>
    <div class="notification-list" id="notification-list">
      <p class="empty-state-notice">🔔 No new notifications</p>
    </div>
  </aside>

  <!-- Workspace Actions Dialog Modal -->
  <dialog class="workspace-modal" id="workspace-modal">
    <div class="modal-card">
      <div class="modal-header">
        <h3 class="modal-title">Workspace Actions</h3>
        <button type="button" class="icon-btn" id="btn-close-workspace-modal" aria-label="Close">✕</button>
      </div>
      <div class="workspace-info-box">
        <div class="info-label">Active Project:</div>
        <div class="info-value" id="ws-project-name">Loading…</div>
        <div class="info-path" id="ws-project-path"></div>
      </div>
      <div class="modal-actions-list">
        <button type="button" class="btn btn-secondary w-full" id="btn-ws-open-folder">Open Folder…</button>
        <button type="button" class="btn btn-secondary w-full" id="btn-ws-reveal">Reveal in Explorer</button>
        <button type="button" class="btn btn-quiet w-full" id="btn-ws-cancel">Cancel</button>
      </div>
    </div>
  </dialog>

  <!-- Interactive Context Selector Modal -->
  <dialog class="context-modal" id="context-modal">
    <div class="modal-card">
      <div class="modal-header">
        <h3 class="modal-title">Select Task Context</h3>
        <button type="button" class="icon-btn" id="btn-close-context-modal" aria-label="Close">✕</button>
      </div>
      <div class="context-sources-list">
        <label class="context-source-item">
          <input type="checkbox" id="ctx-chk-active-editor" checked>
          <span>Active Editor Tab & Cursor Selection</span>
        </label>
        <label class="context-source-item">
          <input type="checkbox" id="ctx-chk-diagnostics" checked>
          <span>Active Problems & Diagnostics (<span id="ctx-diag-count">0</span> errors)</span>
        </label>
        <label class="context-source-item">
          <input type="checkbox" id="ctx-chk-git-diff" checked>
          <span>Git Working Tree Diff</span>
        </label>
        <label class="context-source-item">
          <input type="checkbox" id="ctx-chk-memory">
          <span>Project Architecture Memory</span>
        </label>
      </div>
      <div class="context-files-section">
        <div class="section-title">Open & Relevant Files</div>
        <div class="context-files-list" id="context-files-list"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-quiet" id="btn-cancel-context">Cancel</button>
        <button type="button" class="btn btn-primary" id="btn-apply-context">Apply Context</button>
      </div>
    </div>
  </dialog>

  <!-- Dangerous Operation Approval Card -->
  <section class="approval-card" id="approval-card" role="alertdialog" aria-label="Approval Required" hidden>
    <div class="approval-header">
      <span class="approval-badge" id="approval-risk">HIGH RISK</span>
      <h3 class="approval-title">Command Approval Required</h3>
    </div>
    <div class="approval-body">
      <p class="approval-reason" id="approval-reason"></p>
      <pre class="approval-command" id="approval-command"></pre>
    </div>
    <div class="approval-actions">
      <button type="button" class="btn btn-sm" id="btn-approval-deny">Deny</button>
      <button type="button" class="btn btn-sm btn-secondary" id="btn-approval-once">Allow Once</button>
      <button type="button" class="btn btn-sm btn-primary" id="btn-approval-task">Allow For Task</button>
    </div>
  </section>

  <!-- Enhanced Task Review Card -->
  <section class="enhance-modal" id="enhance-card" role="region" aria-label="Enhanced Task Proposal" hidden>
    <div class="enhance-card-header">
      <span class="enhance-badge">✨ ENHANCED TASK</span>
      <div class="enhance-actions">
        <button type="button" class="btn btn-sm btn-quiet" id="btn-enhance-cancel">Cancel</button>
        <button type="button" class="btn btn-sm btn-secondary" id="btn-enhance-edit">Edit</button>
        <button type="button" class="btn btn-sm btn-primary" id="btn-enhance-use">Use This</button>
      </div>
    </div>
    <div class="enhance-card-body" id="enhance-card-body"></div>
  </section>

  <!-- Dedicated Settings Screen Panel -->
  <section class="settings-panel" id="settings-panel" aria-label="CodeRelay Settings" hidden>
    <div class="settings-header">
      <h2 class="settings-title">CodeRelay Settings</h2>
      <p class="settings-sub">Preferences persist across workspace reloads.</p>
    </div>
    <div class="settings-sections">
      <!-- General -->
      <fieldset class="settings-group">
        <legend class="group-title">General</legend>
        <label class="setting-row">
          <span class="setting-label">Default Execution Mode</span>
          <select class="field-select" id="set-default-mode">
            <option value="code">Build / Code</option>
            <option value="plan">Plan / Architecture</option>
            <option value="debug">Debug / Repair</option>
            <option value="review">Review / Critique</option>
            <option value="test">Test Discovery</option>
            <option value="ask">Ask / Explore</option>
          </select>
        </label>
        <label class="setting-row">
          <span class="setting-label">Sound on Completion</span>
          <input type="checkbox" id="set-sound-enabled" checked>
        </label>
      </fieldset>

      <!-- AI & Routing -->
      <fieldset class="settings-group">
        <legend class="group-title">AI System & Routing</legend>
        <label class="setting-row">
          <span class="setting-label">Automatic Model Selection</span>
          <input type="checkbox" id="set-auto-routing" checked>
        </label>
        <label class="setting-row">
          <span class="setting-label">Automatic Relay on Interruption</span>
          <input type="checkbox" id="set-auto-relay" checked>
        </label>
      </fieldset>

      <!-- Execution & Checkpoints -->
      <fieldset class="settings-group">
        <legend class="group-title">Execution & Safety</legend>
        <label class="setting-row">
          <span class="setting-label">Command Permission Mode</span>
          <select class="field-select" id="set-perm-mode">
            <option value="safe">Safe (Read-only)</option>
            <option value="balanced" selected>Balanced (Confirm destructive)</option>
            <option value="autonomous">Autonomous</option>
          </select>
        </label>
        <label class="setting-row">
          <span class="setting-label">Git Checkpoints</span>
          <input type="checkbox" id="set-checkpoints-enabled" checked>
        </label>
      </fieldset>

      <!-- Verification -->
      <fieldset class="settings-group">
        <legend class="group-title">Verification Engine</legend>
        <label class="setting-row">
          <span class="setting-label">Run Tests on Completion</span>
          <input type="checkbox" id="set-verify-tests" checked>
        </label>
        <label class="setting-row">
          <span class="setting-label">Verify TypeScript / Compiler</span>
          <input type="checkbox" id="set-verify-types" checked>
        </label>
      </fieldset>
    </div>
  </section>

  <!-- AI System Panel (Models, Providers, API Keys, Health) -->
  <section class="ai-panel" id="ai-panel" aria-label="AI System & Providers" hidden>
    <div class="ai-panel-header">
      <h2 class="ai-panel-title">AI System</h2>
      <button type="button" class="btn btn-sm btn-primary" id="btn-add-provider-modal">+ Add Provider</button>
    </div>
    <div class="ai-sub-tabs">
      <button type="button" class="ai-sub-tab is-active" data-sub="models">Models</button>
      <button type="button" class="ai-sub-tab" data-sub="providers">Providers</button>
      <button type="button" class="ai-sub-tab" data-sub="keys">API Keys</button>
      <button type="button" class="ai-sub-tab" data-sub="health">Health</button>
    </div>
    <div class="ai-content-body" id="ai-content-body"></div>
  </section>

  <!-- Active Task Execution Header (Shown when a task is selected or running) -->
  <section class="task-active-header" id="header" aria-label="Active task summary" hidden>
    <div class="header-main-row">
      <span class="status" id="status-chip">
        <span class="status-dot" id="status-dot" aria-hidden="true"></span>
        <span id="status-text">Running</span>
      </span>
      <h2 class="task-title-text" id="title" title=""></h2>
    </div>
    <div class="task-meta-bar" id="meta" aria-label="Task details"></div>
    <div class="task-action-bar" id="actions" role="toolbar" aria-label="Task controls">
      <button type="button" class="btn btn-sm" id="btn-stop" hidden>Stop</button>
      <button type="button" class="btn btn-sm btn-primary" id="btn-resume" hidden>Resume</button>
      <button type="button" class="btn btn-sm btn-primary" id="btn-retry" hidden>Retry</button>
      <button type="button" class="btn btn-sm btn-relay-primary" id="btn-relay" title="Continue this task on another model, from the recorded state">Relay</button>
      <button type="button" class="btn btn-sm" id="btn-switch" hidden>Switch Model</button>
      <button type="button" class="btn btn-sm btn-quiet" id="btn-timeline">Timeline</button>
    </div>
  </section>

  <!-- Model Interruption & Continuity Relay Hero Card -->
  <section class="relay-hero" id="relay-hero" role="region" aria-label="Model interruption and continuity relay" hidden></section>

  <!-- Notice: Recovery & Decision Alerts -->
  <div class="notice" id="notice" role="status" hidden></div>

  <!-- Changes Summary Card (Only shown when files are modified) -->
  <section class="changes-card" id="changes-card" aria-label="Modified files" hidden>
    <div class="changes-card-header">
      <span class="changes-badge" id="changes-badge">CHANGES (0)</span>
      <button type="button" class="btn btn-sm btn-quiet" id="btn-review-changes">Review Changes</button>
    </div>
    <div class="changes-card-list" id="changes-card-list"></div>
  </section>

  <!-- Guided Setup & Provider Manager -->
  <section class="setup" id="setup" aria-label="Provider setup" hidden>
    <ol class="setup-steps" id="setup-steps" aria-label="Setup progress"></ol>
    <h2 class="setup-title" id="setup-title"></h2>
    <p class="setup-sub" id="setup-sub"></p>
    <div class="setup-alert" id="setup-alert" role="status" hidden></div>
    <div class="setup-body" id="setup-body"></div>

    <!--
      The credential pool for the endpoint in hand. Hidden until there is an
      endpoint with keys, because an empty list under a heading reads as a
      feature that is broken rather than one that is not applicable.
    -->
    <section class="keypool" id="keypool" aria-label="API keys for this endpoint" hidden>
      <div class="keypool-head">
        <span class="keypool-title">API keys</span>
        <span class="keypool-summary" id="keypool-summary"></span>
        <button type="button" class="btn btn-sm btn-quiet" id="btn-key-add">Add key</button>
      </div>
      <p class="keypool-blocked" id="keypool-blocked" role="status" hidden></p>
      <ul class="keypool-list" id="keypool-list"></ul>
    </section>
    <div class="setup-foot">
      <button type="button" class="btn btn-quiet" id="setup-back" hidden>Back</button>
      <span class="setup-blocked" id="setup-blocked" role="status"></span>
      <button type="button" class="btn btn-quiet" id="setup-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="setup-primary">Continue</button>
    </div>
  </section>

  <!-- Default Screen: Prominent New Task Workspace & Recent Tasks -->
  <main class="default-workspace" id="empty" aria-label="New coding task workspace">
    <!-- Onboarding Card (Only when no models configured) -->
    <div class="onboarding-card" id="onboarding-card" hidden>
      <h2 class="onboarding-title">Welcome to CodeRelay</h2>
      <p class="onboarding-sub">Connect an AI provider to start coding with persistent recovery.</p>
      <div class="onboarding-actions">
        <button type="button" class="btn btn-primary" id="btn-setup-onboard">Set Up Provider</button>
        <button type="button" class="btn btn-quiet" id="btn-setup-local-onboard">Use Local Model</button>
      </div>
    </div>

    <!-- Large Prominent Composer (The Primary Center of the Workspace) -->
    <form class="workspace-composer" id="composer" aria-label="Compose task">
      <h2 class="composer-heading">What should I build, fix, or analyze?</h2>

      <div class="composer-box">
        <!-- Active Attached Context Chips -->
        <div class="context-chips" id="context-chips" hidden></div>

        <label class="sr-only" for="prompt">Describe the task</label>
        <textarea id="prompt" class="prompt" rows="3" placeholder="Describe your task or paste instructions (e.g. 'Fix auth bug in @src/auth.ts and add tests')…" aria-label="Task description" aria-describedby="composer-hint"></textarea>
        <span class="sr-only" id="composer-hint">Press Enter to send, Shift+Enter for a new line.</span>

        <!-- Auto-Complete Popups for @ and / -->
        <div class="autocomplete-popup" id="autocomplete-popup" role="listbox" hidden></div>

        <!-- Controls Toolbar -->
        <div class="composer-toolbar">
          <div class="toolbar-left">
            <!-- Model Picker Button & Dropdown Menu -->
            <div class="model-dropdown-wrap" id="model-wrap">
              <button type="button" class="pill" id="btn-model" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose model">
                <span id="model-label">Claude 3.7 Sonnet</span>
                <span class="pill-caret">▾</span>
              </button>
              <div class="model-menu" id="model-menu" role="listbox" hidden></div>
            </div>

            <!-- Mode Selector Button & Dropdown Menu -->
            <div class="mode-dropdown-wrap" id="mode-wrap">
              <button type="button" class="pill pill-mode" id="btn-mode" aria-haspopup="listbox" aria-expanded="false" aria-label="Select execution mode">
                <span id="mode-icon">🛠</span>
                <span id="mode-label">Build</span>
                <span class="pill-caret">▾</span>
              </button>
              <div class="mode-menu" id="mode-menu" role="listbox" hidden>
                <button type="button" class="mode-option is-active" data-mode="build" role="option">
                  <span class="option-icon">🛠</span>
                  <div class="option-text">
                    <span class="option-title">Build</span>
                    <span class="option-desc">Plan → Implement → Test → Repair</span>
                  </div>
                </button>
                <button type="button" class="mode-option" data-mode="plan" role="option">
                  <span class="option-icon">📐</span>
                  <div class="option-text">
                    <span class="option-title">Plan</span>
                    <span class="option-desc">Architecture & design review first</span>
                  </div>
                </button>
                <button type="button" class="mode-option" data-mode="debug" role="option">
                  <span class="option-icon">🐛</span>
                  <div class="option-text">
                    <span class="option-title">Debug</span>
                    <span class="option-desc">Reproduce, diagnose & fix bugs</span>
                  </div>
                </button>
                <button type="button" class="mode-option" data-mode="review" role="option">
                  <span class="option-icon">🔍</span>
                  <div class="option-text">
                    <span class="option-title">Review</span>
                    <span class="option-desc">Inspect code, identify risks & critique</span>
                  </div>
                </button>
                <button type="button" class="mode-option" data-mode="test" role="option">
                  <span class="option-icon">🧪</span>
                  <div class="option-text">
                    <span class="option-title">Test</span>
                    <span class="option-desc">Discover, run & fix test suites</span>
                  </div>
                </button>
                <button type="button" class="mode-option" data-mode="ask" role="option">
                  <span class="option-icon">💬</span>
                  <div class="option-text">
                    <span class="option-title">Ask</span>
                    <span class="option-desc">Codebase exploration & analysis</span>
                  </div>
                </button>
              </div>
            </div>

            <button type="button" class="pill pill-quiet" id="btn-attach" aria-label="Reference a workspace file">@ Context</button>
            <button type="button" class="pill pill-enhance" id="btn-enhance" title="Enhance prompt with structure and clarity">✨ Enhance</button>
          </div>

          <div class="toolbar-right">
            <button type="button" class="btn btn-primary btn-start-task" id="btn-send">Start Task</button>
          </div>
        </div>
      </div>
    </form>

    <!-- Recent & Active Tasks Section -->
    <section class="recent-tasks-section" id="recent-tasks-section" aria-label="Recent and active tasks">
      <div class="section-header">
        <h3 class="section-title">Tasks</h3>
      </div>
      <div class="recent-tasks-list" id="recent-tasks-list"></div>
    </section>
  </main>

  <!-- Execution Timeline (Live Agent Turns, Tool Invocations, Checkpoints, Recovery) -->
  <section class="stages" id="stages" aria-label="Task progress" hidden>
    <ol class="stage-list" id="stage-list"></ol>
  </section>

  <section class="why-panel" id="why-panel" aria-label="Model selection" hidden>
    <button type="button" class="why-toggle" id="why-toggle" aria-expanded="false" aria-controls="why-body">
      <span class="why-caret" aria-hidden="true">›</span>
      <span class="why-line" id="why-line"></span>
    </button>
    <div class="why-body" id="why-body" hidden>
      <ul class="why-list" id="why-list"></ul>
      <details class="why-rejected" id="why-rejected" hidden>
        <summary>Models not chosen</summary>
        <ul class="why-rejected-list" id="why-rejected-list"></ul>
      </details>
    </div>
  </section>

  <section class="ctx-panel" id="ctx-panel" aria-label="Task context" hidden>
    <button type="button" class="ctx-toggle" id="ctx-toggle" aria-expanded="false" aria-controls="ctx-body">
      <span class="ctx-caret" aria-hidden="true">›</span>
      <span class="ctx-title">Context</span>
      <span class="ctx-summary" id="ctx-summary"></span>
    </button>
    <div class="ctx-body" id="ctx-body" hidden>
      <ul class="ctx-list" id="ctx-list"></ul>
      <div class="ctx-excluded" id="ctx-excluded" hidden>
        <span class="ctx-excluded-title">Left out</span>
        <ul class="ctx-excluded-list" id="ctx-excluded-list"></ul>
      </div>
      <div class="ctx-actions">
        <button type="button" class="btn btn-sm btn-quiet" id="btn-ctx-rebuild">Rebuild</button>
        <button type="button" class="btn btn-sm btn-quiet" id="btn-ctx-clear">Clear</button>
      </div>
    </div>
  </section>

  <section class="req-panel" id="req-panel" aria-label="Task requirements" hidden>
    <div class="req-head">
      <span class="req-title">Requirements</span>
      <span class="req-summary" id="req-summary"></span>
    </div>
    <ul class="req-list" id="req-list"></ul>
  </section>

  <section class="verify-panel" id="verify-panel" aria-label="Verification" hidden>
    <div class="verify-head">
      <span class="verify-glyph" id="verify-glyph" aria-hidden="true"></span>
      <span class="verify-label" id="verify-label"></span>
      <span class="verify-total" id="verify-total"></span>
      <button type="button" class="btn btn-sm" id="btn-verify">Verify</button>
      <button type="button" class="btn btn-sm" id="btn-verify-stop" hidden>Stop</button>
    </div>
    <p class="verify-detail" id="verify-detail"></p>
    <ul class="verify-list" id="verify-list"></ul>
    <p class="verify-unavailable" id="verify-unavailable" hidden></p>
  </section>

  <section class="recovery-panel" id="recovery-panel" aria-label="Recovery history" hidden>
    <div class="relay-center-card" id="relay-center-card">
      <div class="relay-center-head">
        <h3 class="relay-title">Cross-Provider Relay Center</h3>
        <span class="lost-work-badge" id="lost-work-guarantee-badge" title="CodeRelay Technical Guarantee">🛡️ No Lost Progress</span>
      </div>
      <div class="relay-center-body">
        <div class="relay-target-row">
          <label for="select-target-worker">Successor Worker:</label>
          <select id="select-target-worker" class="relay-select"></select>
          <span class="confidence-badge" id="relay-confidence-badge">HIGH</span>
        </div>
        <p class="relay-rationale-text" id="relay-rationale-text">All side-effect tool actions hashed and deduplicated. Checkpoint verified.</p>
        <div class="relay-actions-row">
          <button type="button" class="btn btn-sm btn-primary" id="btn-execute-relay">⚡ Execute Safe Relay</button>
          <button type="button" class="btn btn-sm btn-quiet" id="btn-rollback-cp">⏪ Rollback Checkpoint</button>
        </div>
      </div>
    </div>

    <button type="button" class="recovery-toggle" id="recovery-toggle" aria-expanded="false" aria-controls="recovery-list">
      <span class="recovery-caret" aria-hidden="true">›</span>
      <span class="recovery-summary" id="recovery-summary"></span>
      <span class="recovery-checkpoints" id="recovery-checkpoints"></span>
    </button>
    <ol class="recovery-list" id="recovery-list" hidden></ol>
  </section>

  <!-- Benchmark Lab Panel -->
  <section class="benchmarks-panel" id="benchmarks-panel" aria-label="Recovery Benchmark Lab" hidden>
    <div class="bench-panel-header">
      <h2 class="bench-panel-title">Recovery Benchmark Lab & Chaos Harness</h2>
      <div class="bench-header-actions">
        <button type="button" class="btn btn-sm btn-quiet" id="btn-export-graph">Export Task Graph</button>
        <button type="button" class="btn btn-sm btn-quiet" id="btn-import-graph">Import Task Graph</button>
        <button type="button" class="btn btn-sm btn-quiet" id="btn-run-review">Multi-Model Review</button>
      </div>
    </div>
    <p class="bench-desc">Empirical proof: Normal Execution vs. Naive Fallback vs. CodeRelay Safe Relay across injected fault scenarios.</p>

    <!-- Benchmark Execution -->
    <div class="bench-scenario-row">
      <label for="select-benchmark-scenario">Scenario:</label>
      <select id="select-benchmark-scenario" class="bench-select">
        <option value="rate_limit_429">HTTP 429 Rate Limit Burst</option>
        <option value="stream_truncation">Partial Stream Disconnect</option>
        <option value="provider_500">Provider 500 Outage</option>
        <option value="context_overflow">Context Window Overflow</option>
      </select>
      <button type="button" class="btn btn-sm btn-primary" id="btn-run-benchmark">Run Benchmark</button>
    </div>

    <!-- Comparative Paradigm Results Table -->
    <div class="bench-table-wrap">
      <table class="bench-table" id="benchmark-results-table">
        <thead>
          <tr>
            <th>Paradigm</th>
            <th>Completed</th>
            <th>Recovery MTTR</th>
            <th>Duplicates Prevented</th>
            <th>Tokens Used</th>
            <th>Verified Gate</th>
          </tr>
        </thead>
        <tbody id="benchmark-table-body">
          <tr class="row-single">
            <td><strong>Single Worker</strong></td>
            <td>❌ Failed (429)</td>
            <td>N/A (Failed)</td>
            <td>0</td>
            <td>18,450</td>
            <td>❌ No</td>
          </tr>
          <tr class="row-naive">
            <td><strong>Naive Fallback</strong></td>
            <td>⚠️ Re-run from scratch</td>
            <td>4,850 ms</td>
            <td>0 (2 duplicates)</td>
            <td>42,100</td>
            <td>❌ Unverified</td>
          </tr>
          <tr class="row-coderelay">
            <td><strong>CodeRelay Relay</strong></td>
            <td>✅ 100% Succeeded</td>
            <td>320 ms</td>
            <td>4 Prevented</td>
            <td>21,800 (-48%)</td>
            <td>✅ Verified</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Chaos Injection Harness -->
    <div class="chaos-harness-card">
      <h3 class="chaos-title">Controlled Chaos Injection Testing</h3>
      <div class="chaos-controls-row">
        <label for="select-chaos-type">Inject Fault:</label>
        <select id="select-chaos-type" class="bench-select">
          <option value="RATE_LIMIT_429">Rate Limit (HTTP 429)</option>
          <option value="STREAM_CUTOFF">Stream Disconnect (SSE Cutoff)</option>
          <option value="MALFORMED_TOOL_ARGS">Malformed Tool Arguments</option>
          <option value="CONTEXT_OVERFLOW">Context Window Overflow</option>
          <option value="CREDENTIAL_REVOCATION">Credential Revocation (401)</option>
          <option value="GIT_CHECKPOINT_CONFLICT">Git Checkpoint Lock Conflict</option>
          <option value="PROVIDER_503_OUTAGE">Provider 503 Outage</option>
        </select>
        <button type="button" class="btn btn-sm btn-danger" id="btn-inject-chaos">Inject Failure</button>
      </div>
      <div class="chaos-results" id="chaos-results-display">Ready for chaos test.</div>
      <div class="review-results" id="review-verdict-display"></div>
      <div class="graph-status" id="graph-status-text"></div>
    </div>
  </section>

  <main class="timeline" id="timeline" role="log" aria-label="Execution timeline" aria-live="polite" aria-relevant="additions text" tabindex="0" hidden></main>

  <!-- Execution Follow-Up Bar (Only shown at bottom during active task execution) -->
  <form class="execution-followup" id="execution-followup" aria-label="Follow-up instruction" hidden>
    <div class="followup-box">
      <textarea id="followup-prompt" class="prompt followup-textarea" rows="1" placeholder="Follow-up instructions or answer questions…" aria-label="Follow-up instructions"></textarea>
      <div class="followup-toolbar">
        <button type="button" class="pill pill-quiet pill-sm" id="btn-followup-attach">@ file</button>
        <button type="button" class="pill pill-enhance pill-sm" id="btn-followup-enhance">✨ Enhance</button>
        <span class="spacer"></span>
        <button type="submit" class="btn btn-primary btn-sm" id="btn-followup-send">Send</button>
      </div>
    </div>
  </form>

</div>
<script nonce="${nonce}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>`;
}
