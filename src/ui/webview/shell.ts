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

  <!-- Header: Compact brand bar with New Task & Settings -->
  <header class="top-nav" id="top-nav" role="banner" aria-label="CodeRelay Navigation">
    <div class="brand">
      <svg class="brand-logo" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
      <span class="brand-name">CodeRelay</span>
    </div>

    <!-- Live Context Gauge -->
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

    <div class="nav-actions">
      <button type="button" class="icon-btn" id="btn-new-task" title="New Coding Task (+)">+</button>
      <button type="button" class="icon-btn" id="btn-sessions" title="Task History (🗂️)">🗂️</button>
      <button type="button" class="icon-btn" id="btn-open-setup" title="Settings & Providers (⚙️)">⚙️</button>
    </div>
  </header>

  <!-- Session History Drawer Overlay -->
  <aside class="sessions-drawer" id="sessions-drawer" hidden>
    <div class="drawer-header">
      <h3 class="drawer-title">Task History</h3>
      <button type="button" class="icon-btn" id="btn-close-drawer" aria-label="Close drawer">✕</button>
    </div>
    <div class="drawer-search-wrap">
      <input type="text" class="field-input drawer-search" id="drawer-search" placeholder="Search tasks by prompt, model, file…">
    </div>
    <div class="drawer-list" id="drawer-sessions-list"></div>
  </aside>

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
      <button type="button" class="btn btn-sm" id="btn-switch" hidden>Switch Model</button>
      <button type="button" class="btn btn-sm btn-quiet" id="btn-timeline">Timeline</button>
    </div>
  </section>

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
      <p class="onboarding-sub">Connect an AI provider to start coding.</p>
      <div class="onboarding-actions">
        <button type="button" class="btn btn-primary" id="btn-setup-onboard">Set Up Provider</button>
        <button type="button" class="btn btn-quiet" id="btn-setup-local-onboard">Use Local Model</button>
      </div>
    </div>

    <!-- Large Prominent Composer (The Primary Center of the Workspace) -->
    <section class="workspace-composer" id="workspace-composer" aria-label="Compose task">
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
    </section>

    <!-- Recent & Active Tasks Section -->
    <section class="recent-tasks-section" id="recent-tasks-section" aria-label="Recent and active tasks">
      <div class="section-header">
        <h3 class="section-title">Recent Tasks</h3>
      </div>
      <div class="recent-tasks-list" id="recent-tasks-list"></div>
    </section>
  </main>

  <!-- Execution Timeline (Live Agent Turns, Tool Invocations, Checkpoints, Recovery) -->
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
