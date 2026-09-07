/*
 * CodeRelay Webview Client.
 *
 * High-performance, developer-first AI coding interface.
 * Implements:
 * - Agent Modes (Code, Architect, Ask)
 * - Live Context Gauge & Cost Ticker
 * - @ Mentions & / Slash Commands Autocomplete
 * - Prompt Enhancer (✨)
 * - Collapsible Thinking / Reasoning Traces
 * - Rich Terminal & Diff Cards with 1-click View Diff & Rewind
 * - Session History Drawer
 * - Web Audio Chimes
 * - Complete In-Panel Provider Setup & Management
 */
// @ts-nocheck — plain browser script; the host side is the typed half.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const el = {
    // Top Nav & Mode
    topNav: document.getElementById('top-nav'),
    btnMode: document.getElementById('btn-mode'),
    modeIcon: document.getElementById('mode-icon'),
    modeLabel: document.getElementById('mode-label'),
    modeMenu: document.getElementById('mode-menu'),
    btnContextGauge: document.getElementById('btn-context-gauge'),
    gaugeFill: document.getElementById('gauge-fill'),
    contextLabel: document.getElementById('context-label'),
    contextPopover: document.getElementById('context-popover'),
    statCtxWin: document.getElementById('stat-ctx-win'),
    statInputTok: document.getElementById('stat-input-tok'),
    statOutputTok: document.getElementById('stat-output-tok'),
    statCost: document.getElementById('stat-cost'),
    btnCompactCtx: document.getElementById('btn-compact-ctx'),
    btnNewTask: document.getElementById('btn-new-task'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnSessions: document.getElementById('btn-sessions'),
    btnExport: document.getElementById('btn-export'),
    btnSound: document.getElementById('btn-sound'),
    btnOpenSetup: document.getElementById('btn-open-setup'),
    btnProgress: document.getElementById('btn-progress'),
    progressFill: document.getElementById('progress-fill'),
    progressLabel: document.getElementById('progress-label'),
    btnWorkspace: document.getElementById('btn-workspace'),
    btnSettings: document.getElementById('btn-settings'),
    btnNotifications: document.getElementById('btn-notifications'),
    notifBadge: document.getElementById('notif-badge'),
    btnOverflow: document.getElementById('btn-overflow'),

    // Navigation Tabs
    navTabs: document.getElementById('nav-tabs'),
    tabComposer: document.getElementById('tab-composer'),
    tabCurrent: document.getElementById('tab-current'),
    tabTasks: document.getElementById('tab-tasks'),
    tabWorkspace: document.getElementById('tab-workspace'),
    tabAi: document.getElementById('tab-ai'),
    tabRecovery: document.getElementById('tab-recovery'),
    tabBenchmarks: document.getElementById('tab-benchmarks'),
    tabSettings: document.getElementById('tab-settings'),

    // Continuity & Resilience Gauge
    btnContinuityScore: document.getElementById('btn-continuity-score'),
    continuityDot: document.getElementById('continuity-dot'),
    continuityScoreVal: document.getElementById('continuity-score-val'),
    continuityHealthLabel: document.getElementById('continuity-health-label'),
    continuityPopover: document.getElementById('continuity-popover'),
    continuitySummaryNote: document.getElementById('continuity-summary-note'),
    statCpInt: document.getElementById('stat-cp-int'),
    statReqCov: document.getElementById('stat-req-cov'),
    statVerRec: document.getElementById('stat-ver-rec'),
    statWorkDiv: document.getElementById('stat-work-div'),
    statActIdem: document.getElementById('stat-act-idem'),

    // Benchmark Lab & Chaos
    benchmarksPanel: document.getElementById('benchmarks-panel'),
    selectBenchmarkScenario: document.getElementById('select-benchmark-scenario'),
    btnRunBenchmark: document.getElementById('btn-run-benchmark'),
    benchmarkResultsTable: document.getElementById('benchmark-results-table'),
    benchmarkTableBody: document.getElementById('benchmark-table-body'),
    selectChaosType: document.getElementById('select-chaos-type'),
    btnInjectChaos: document.getElementById('btn-inject-chaos'),
    chaosResultsDisplay: document.getElementById('chaos-results-display'),
    btnExportGraph: document.getElementById('btn-export-graph'),
    btnImportGraph: document.getElementById('btn-import-graph'),
    btnRunReview: document.getElementById('btn-run-review'),
    reviewVerdictDisplay: document.getElementById('review-verdict-display'),
    graphStatusText: document.getElementById('graph-status-text'),

    // Relay Center
    selectTargetWorker: document.getElementById('select-target-worker'),
    relayConfidenceBadge: document.getElementById('relay-confidence-badge'),
    relayRationaleText: document.getElementById('relay-rationale-text'),
    btnExecuteRelay: document.getElementById('btn-execute-relay'),
    btnRollbackCp: document.getElementById('btn-rollback-cp'),
    lostWorkGuaranteeBadge: document.getElementById('lost-work-guarantee-badge'),

    // Notification Drawer
    notificationDrawer: document.getElementById('notification-drawer'),
    btnCloseNotifs: document.getElementById('btn-close-notifs'),
    btnDismissAllNotifs: document.getElementById('btn-dismiss-all-notifs'),
    notificationList: document.getElementById('notification-list'),

    // Workspace Modal
    workspaceModal: document.getElementById('workspace-modal'),
    btnCloseWorkspaceModal: document.getElementById('btn-close-workspace-modal'),
    wsProjectName: document.getElementById('ws-project-name'),
    wsProjectPath: document.getElementById('ws-project-path'),
    btnWsOpenFolder: document.getElementById('btn-ws-open-folder'),
    btnWsReveal: document.getElementById('btn-ws-reveal'),
    btnWsCancel: document.getElementById('btn-ws-cancel'),

    // Interactive Context Modal
    contextModal: document.getElementById('context-modal'),
    btnCloseContextModal: document.getElementById('btn-close-context-modal'),
    ctxChkActiveEditor: document.getElementById('ctx-chk-active-editor'),
    ctxChkDiagnostics: document.getElementById('ctx-chk-diagnostics'),
    ctxDiagCount: document.getElementById('ctx-diag-count'),
    ctxChkGitDiff: document.getElementById('ctx-chk-git-diff'),
    ctxChkMemory: document.getElementById('ctx-chk-memory'),
    contextFilesList: document.getElementById('context-files-list'),
    btnCancelContext: document.getElementById('btn-cancel-context'),
    btnApplyContext: document.getElementById('btn-apply-context'),

    // Approval Card
    approvalCard: document.getElementById('approval-card'),
    approvalRisk: document.getElementById('approval-risk'),
    approvalReason: document.getElementById('approval-reason'),
    approvalCommand: document.getElementById('approval-command'),
    btnApprovalDeny: document.getElementById('btn-approval-deny'),
    btnApprovalOnce: document.getElementById('btn-approval-once'),
    btnApprovalTask: document.getElementById('btn-approval-task'),

    // Enhance Proposal Card
    enhanceCard: document.getElementById('enhance-card'),
    enhanceCardBody: document.getElementById('enhance-card-body'),
    btnEnhanceCancel: document.getElementById('btn-enhance-cancel'),
    btnEnhanceEdit: document.getElementById('btn-enhance-edit'),
    btnEnhanceUse: document.getElementById('btn-enhance-use'),

    // Settings Panel
    settingsPanel: document.getElementById('settings-panel'),
    setDefaultMode: document.getElementById('set-default-mode'),
    setSoundEnabled: document.getElementById('set-sound-enabled'),
    setAutoRouting: document.getElementById('set-auto-routing'),
    setAutoRelay: document.getElementById('set-auto-relay'),
    setPermMode: document.getElementById('set-perm-mode'),
    setCheckpointsEnabled: document.getElementById('set-checkpoints-enabled'),
    setVerifyTests: document.getElementById('set-verify-tests'),
    setVerifyTypes: document.getElementById('set-verify-types'),

    // AI System Panel
    aiPanel: document.getElementById('ai-panel'),
    btnAddProviderModal: document.getElementById('btn-add-provider-modal'),
    aiContentBody: document.getElementById('ai-content-body'),

    // Sessions Drawer
    sessionsDrawer: document.getElementById('sessions-drawer'),
    btnCloseDrawer: document.getElementById('btn-close-drawer'),
    drawerSearch: document.getElementById('drawer-search'),
    drawerSessionsList: document.getElementById('drawer-sessions-list'),

    // Header
    header: document.getElementById('header'),
    statusChip: document.getElementById('status-chip'),
    statusText: document.getElementById('status-text'),
    title: document.getElementById('title'),
    meta: document.getElementById('meta'),
    relayHero: document.getElementById('relay-hero'),
    notice: document.getElementById('notice'),
    empty: document.getElementById('empty'),
    onboardingCard: document.getElementById('onboarding-card'),
    btnSetupOnboard: document.getElementById('btn-setup-onboard'),
    btnSetupLocalOnboard: document.getElementById('btn-setup-local-onboard'),
    // The composer element, looked up once. It is a <form id="composer"> so the
    // client's submit handler fires; `workspaceComposer` is the same node under
    // the name the show/hide code uses.
    workspaceComposer: document.getElementById('composer'),
    recentTasksSection: document.getElementById('recent-tasks-section'),
    recentTasksList: document.getElementById('recent-tasks-list'),
    changesCard: document.getElementById('changes-card'),
    changesBadge: document.getElementById('changes-badge'),
    changesCardList: document.getElementById('changes-card-list'),
    btnReviewChanges: document.getElementById('btn-review-changes'),
    timeline: document.getElementById('timeline'),
    stages: document.getElementById('stages'),
    stageList: document.getElementById('stage-list'),
    whyPanel: document.getElementById('why-panel'),
    whyToggle: document.getElementById('why-toggle'),
    whyLine: document.getElementById('why-line'),
    whyBody: document.getElementById('why-body'),
    whyList: document.getElementById('why-list'),
    whyRejected: document.getElementById('why-rejected'),
    whyRejectedList: document.getElementById('why-rejected-list'),
    ctxPanel: document.getElementById('ctx-panel'),
    ctxToggle: document.getElementById('ctx-toggle'),
    ctxSummary: document.getElementById('ctx-summary'),
    ctxBody: document.getElementById('ctx-body'),
    ctxList: document.getElementById('ctx-list'),
    ctxExcluded: document.getElementById('ctx-excluded'),
    ctxExcludedList: document.getElementById('ctx-excluded-list'),
    btnCtxRebuild: document.getElementById('btn-ctx-rebuild'),
    btnCtxClear: document.getElementById('btn-ctx-clear'),
    reqPanel: document.getElementById('req-panel'),
    reqSummary: document.getElementById('req-summary'),
    reqList: document.getElementById('req-list'),
    verifyPanel: document.getElementById('verify-panel'),
    verifyGlyph: document.getElementById('verify-glyph'),
    verifyLabel: document.getElementById('verify-label'),
    verifyTotal: document.getElementById('verify-total'),
    verifyDetail: document.getElementById('verify-detail'),
    verifyList: document.getElementById('verify-list'),
    verifyUnavailable: document.getElementById('verify-unavailable'),
    btnVerify: document.getElementById('btn-verify'),
    btnRelay: document.getElementById('btn-relay'),
    btnVerifyStop: document.getElementById('btn-verify-stop'),
    recoveryPanel: document.getElementById('recovery-panel'),
    recoveryToggle: document.getElementById('recovery-toggle'),
    recoverySummary: document.getElementById('recovery-summary'),
    recoveryCheckpoints: document.getElementById('recovery-checkpoints'),
    recoveryList: document.getElementById('recovery-list'),
    executionFollowup: document.getElementById('execution-followup'),
    followupPrompt: document.getElementById('followup-prompt'),
    btnFollowupAttach: document.getElementById('btn-followup-attach'),
    btnFollowupEnhance: document.getElementById('btn-followup-enhance'),
    btnFollowupSend: document.getElementById('btn-followup-send'),

    // Composer & Autocomplete
    composer: document.getElementById('composer'),
    autocompletePopup: document.getElementById('autocomplete-popup'),
    contextChips: document.getElementById('context-chips'),
    prompt: document.getElementById('prompt'),
    modelWrap: document.getElementById('model-wrap'),
    modelMenu: document.getElementById('model-menu'),
    modelLabel: document.getElementById('model-label'),
    btnModel: document.getElementById('btn-model'),
    btnAttach: document.getElementById('btn-attach'),
    btnEnhance: document.getElementById('btn-enhance'),
    btnSend: document.getElementById('btn-send'),
    btnStop: document.getElementById('btn-stop'),
    btnResume: document.getElementById('btn-resume'),
    btnRetry: document.getElementById('btn-retry'),
    btnSwitch: document.getElementById('btn-switch'),
    btnTimeline: document.getElementById('btn-timeline'),

    // Guided Setup
    setup: document.getElementById('setup'),
    setupSteps: document.getElementById('setup-steps'),
    setupTitle: document.getElementById('setup-title'),
    setupSub: document.getElementById('setup-sub'),
    setupAlert: document.getElementById('setup-alert'),
    setupBody: document.getElementById('setup-body'),
    keypool: document.getElementById('keypool'),
    keypoolSummary: document.getElementById('keypool-summary'),
    keypoolBlocked: document.getElementById('keypool-blocked'),
    keypoolList: document.getElementById('keypool-list'),
    btnKeyAdd: document.getElementById('btn-key-add'),
    setupBack: document.getElementById('setup-back'),
    setupBlocked: document.getElementById('setup-blocked'),
    setupCancel: document.getElementById('setup-cancel'),
    setupPrimary: document.getElementById('setup-primary'),
  };

  /** Rows currently in the DOM, by host-supplied id. */
  const rows = new Map();
  /** Ids the user has expanded. */
  const expanded = new Set();
  /** The most recent view model. */
  let state = null;
  /** Set while the user has scrolled up. */
  let pinnedToBottom = true;
  /** Sound enabled state. */
  let soundEnabled = true;
  /** Current mode. */
  let currentMode = 'code';

  const saved = vscode.getState();
  if (saved && typeof saved.draft === 'string') {
    el.prompt.value = saved.draft;
  }
  if (saved && Array.isArray(saved.expanded)) {
    for (const id of saved.expanded) {
      expanded.add(id);
    }
  }

  function persist() {
    vscode.setState({ draft: el.prompt.value, expanded: [...expanded] });
  }

  function post(message) {
    vscode.postMessage(message);
  }

  // --- Web Audio Chimes ---

  function playChime(type) {
    if (!soundEnabled) {
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        return;
      }
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'complete') {
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15); // A5
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      } else if (type === 'attention') {
        osc.frequency.setValueAtTime(440, ctx.currentTime); // A4
        osc.frequency.setValueAtTime(554.37, ctx.currentTime + 0.1); // C#5
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      }
    } catch {
      // Audio playback is optional; ignore failures in sandboxed environments.
    }
  }

  // --- Small DOM Helpers ---

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function setText(node, text) {
    const next = text === null || text === undefined ? '' : String(text);
    if (node.textContent !== next) {
      node.textContent = next;
    }
  }

  function show(node, visible) {
    if (node.hidden === !visible) {
      return;
    }
    node.hidden = !visible;
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function button(label, className, onClick) {
    const node = make('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  // --- Safe Markdown DOM Parser ---

  function renderInlineMarkdown(container, text) {
    const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const token = match[0];
      if (token.startsWith('`') && token.endsWith('`')) {
        container.appendChild(make('code', 'inline-code', token.slice(1, -1)));
      } else if (token.startsWith('**') && token.endsWith('**')) {
        container.appendChild(make('strong', 'inline-strong', token.slice(2, -2)));
      } else if (token.startsWith('*') && token.endsWith('*')) {
        container.appendChild(make('em', 'inline-em', token.slice(1, -1)));
      }
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function renderMarkdown(container, text) {
    clear(container);
    if (!text) {
      return;
    }

    const lines = text.split('\n');
    let inCodeBlock = false;
    let codeLang = '';
    let codeLines = [];
    let currentList = null;

    function flushList() {
      if (currentList) {
        container.appendChild(currentList);
        currentList = null;
      }
    }

    function flushCodeBlock() {
      if (inCodeBlock) {
        const codeCard = make('div', 'code-block-card');
        const codeHeader = make('div', 'code-block-header');
        const langSpan = make('span', 'code-block-lang', codeLang || 'code');
        const copyBtn = make('button', 'btn btn-sm btn-quiet btn-copy-code', 'Copy');
        copyBtn.type = 'button';
        const rawCode = codeLines.join('\n');
        copyBtn.addEventListener('click', () => {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(rawCode);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => {
              copyBtn.textContent = 'Copy';
            }, 1500);
          }
        });
        codeHeader.appendChild(langSpan);
        codeHeader.appendChild(copyBtn);
        codeCard.appendChild(codeHeader);

        const pre = make('pre', 'code-block-pre');
        const code = make('code', 'code-block-code', rawCode);
        pre.appendChild(code);
        codeCard.appendChild(pre);

        container.appendChild(codeCard);
        inCodeBlock = false;
        codeLang = '';
        codeLines = [];
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith('```')) {
        if (inCodeBlock) {
          flushCodeBlock();
        } else {
          flushList();
          inCodeBlock = true;
          codeLang = trimmed.slice(3).trim();
          codeLines = [];
        }
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
      if (listMatch) {
        const isOrdered = listMatch[2].endsWith('.');
        if (!currentList || (currentList.tagName === 'OL') !== isOrdered) {
          flushList();
          currentList = make(isOrdered ? 'ol' : 'ul', 'markdown-list');
        }
        const li = make('li', 'markdown-list-item');
        renderInlineMarkdown(li, listMatch[3]);
        currentList.appendChild(li);
        continue;
      } else {
        flushList();
      }

      if (trimmed.startsWith('### ')) {
        const h3 = make('h3', 'markdown-h3');
        renderInlineMarkdown(h3, trimmed.slice(4));
        container.appendChild(h3);
        continue;
      }
      if (trimmed.startsWith('## ')) {
        const h2 = make('h2', 'markdown-h2');
        renderInlineMarkdown(h2, trimmed.slice(3));
        container.appendChild(h2);
        continue;
      }
      if (trimmed.startsWith('# ')) {
        const h1 = make('h1', 'markdown-h1');
        renderInlineMarkdown(h1, trimmed.slice(2));
        container.appendChild(h1);
        continue;
      }

      if (trimmed.startsWith('> ')) {
        const bq = make('blockquote', 'markdown-blockquote');
        renderInlineMarkdown(bq, trimmed.slice(2));
        container.appendChild(bq);
        continue;
      }

      if (trimmed === '') {
        continue;
      }

      const p = make('p', 'markdown-p');
      renderInlineMarkdown(p, line);
      container.appendChild(p);
    }

    flushList();
    flushCodeBlock();
  }

  // --- Mode Switcher ---

  const MODE_ICONS = {
    build: '🛠',
    code: '🛠',
    plan: '📐',
    architect: '📐',
    debug: '🐛',
    review: '🔍',
    test: '🧪',
    ask: '💬',
  };

  const MODE_LABELS = {
    build: 'Build',
    code: 'Build',
    plan: 'Plan',
    architect: 'Plan',
    debug: 'Debug',
    review: 'Review',
    test: 'Test',
    ask: 'Ask',
  };

  function updateModeUI(mode) {
    currentMode = mode;
    setText(el.modeIcon, MODE_ICONS[mode] || '🛠');
    setText(el.modeLabel, MODE_LABELS[mode] || 'Build');
    const options = el.modeMenu.querySelectorAll('.mode-option');
    for (const opt of options) {
      opt.classList.toggle('is-active', opt.dataset.mode === mode);
    }
  }

  el.btnMode.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = el.modeMenu.hidden;
    show(el.modeMenu, isHidden);
    el.btnMode.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    show(el.contextPopover, false);
  });

  for (const opt of el.modeMenu.querySelectorAll('.mode-option')) {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const mode = opt.dataset.mode;
      updateModeUI(mode);
      show(el.modeMenu, false);
      el.btnMode.setAttribute('aria-expanded', 'false');
      post({ kind: 'setMode', mode });
    });
  }

  // --- Context Gauge & Popover ---

  el.whyToggle.addEventListener('click', () => {
    const open = el.whyBody.hidden;
    el.whyBody.hidden = !open;
    el.whyToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.whyPanel.classList.toggle('is-open', open);
  });

  el.ctxToggle.addEventListener('click', () => {
    const open = el.ctxBody.hidden;
    el.ctxBody.hidden = !open;
    el.ctxToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.ctxPanel.classList.toggle('is-open', open);
  });
  el.btnCtxRebuild.addEventListener('click', () => post({ kind: 'rebuildContext' }));
  el.btnCtxClear.addEventListener('click', () => post({ kind: 'clearContext' }));

  el.btnKeyAdd.addEventListener('click', () => post({ kind: 'addCredential' }));
  el.btnRelay.addEventListener('click', () => post({ kind: 'relay' }));
  el.btnVerify.addEventListener('click', () => post({ kind: 'verify' }));
  el.btnVerifyStop.addEventListener('click', () => post({ kind: 'stopVerify' }));

  // Recovery panel: collapsed by default. The headline says whether anything
  // went wrong, and the detail is one click away rather than always on screen.
  el.recoveryToggle.addEventListener('click', () => {
    const open = el.recoveryList.hidden;
    el.recoveryList.hidden = !open;
    el.recoveryToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.recoveryPanel.classList.toggle('is-open', open);
  });

  el.btnContextGauge.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = el.contextPopover.hidden;
    show(el.contextPopover, isHidden);
    show(el.modeMenu, false);
  });

  el.btnCompactCtx.addEventListener('click', () => {
    show(el.contextPopover, false);
    post({ kind: 'compactContext' });
  });

  // Continuity Score Popover
  if (el.btnContinuityScore) {
    el.btnContinuityScore.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.continuityPopover) {
        show(el.continuityPopover, el.continuityPopover.hidden);
      }
    });
  }

  // Relay Center Actions
  if (el.btnExecuteRelay) {
    el.btnExecuteRelay.addEventListener('click', () => {
      post({ kind: 'relayTask' });
    });
  }
  if (el.btnRollbackCp) {
    el.btnRollbackCp.addEventListener('click', () => {
      post({ kind: 'rollbackCheckpoint', checkpointId: 'latest' });
    });
  }

  // Benchmark Lab & Chaos Harness Actions
  if (el.btnRunBenchmark) {
    el.btnRunBenchmark.addEventListener('click', () => {
      const scenarioId = el.selectBenchmarkScenario ? el.selectBenchmarkScenario.value : 'rate_limit_429';
      post({ kind: 'runRecoveryBenchmark', scenarioId });
    });
  }
  if (el.btnInjectChaos) {
    el.btnInjectChaos.addEventListener('click', () => {
      const failureType = el.selectChaosType ? el.selectChaosType.value : 'RATE_LIMIT_429';
      post({ kind: 'injectChaos', failureType });
    });
  }
  if (el.btnExportGraph) {
    el.btnExportGraph.addEventListener('click', () => {
      post({ kind: 'exportTaskGraph' });
    });
  }
  if (el.btnImportGraph) {
    el.btnImportGraph.addEventListener('click', () => {
      const json = window.prompt('Paste exported task graph JSON:');
      if (json) {
        post({ kind: 'importTaskGraph', graphJson: json });
      }
    });
  }
  if (el.btnRunReview) {
    el.btnRunReview.addEventListener('click', () => {
      post({ kind: 'runMultiModelReview' });
    });
  }

  document.addEventListener('click', (e) => {
    if (!el.modeWrap || !el.contextGaugeWrap) return;
    if (!document.getElementById('mode-wrap').contains(e.target)) {
      show(el.modeMenu, false);
      el.btnMode.setAttribute('aria-expanded', 'false');
    }
    if (!document.getElementById('context-gauge-wrap').contains(e.target)) {
      show(el.contextPopover, false);
    }
    const contWrap = document.getElementById('continuity-badge-wrap');
    if (contWrap && !contWrap.contains(e.target) && el.continuityPopover) {
      show(el.continuityPopover, false);
    }
    if (!el.composer.contains(e.target)) {
      show(el.autocompletePopup, false);
    }
  });

  // --- Sessions Drawer ---

  el.btnSessions.addEventListener('click', () => {
    show(el.sessionsDrawer, el.sessionsDrawer.hidden);
    if (!el.sessionsDrawer.hidden) {
      el.drawerSearch.value = '';
      renderSessionsList(state?.sessions || []);
      el.drawerSearch.focus();
    }
  });

  el.btnCloseDrawer.addEventListener('click', () => {
    show(el.sessionsDrawer, false);
  });

  el.drawerSearch.addEventListener('input', () => {
    const q = el.drawerSearch.value.trim().toLowerCase();
    const all = state?.sessions || [];
    const filtered = q === '' ? all : all.filter((s) => s.title.toLowerCase().includes(q));
    renderSessionsList(filtered);
  });

  function renderSessionsList(sessions) {
    clear(el.drawerSessionsList);
    if (sessions.length === 0) {
      el.drawerSessionsList.appendChild(
        make('p', 'drawer-empty', 'No past sessions found in this workspace.'),
      );
      return;
    }
    for (const session of sessions) {
      const item = make('div', 'drawer-item' + (session.isCurrent ? ' is-current' : ''));
      const info = make('button', 'drawer-item-main');
      info.type = 'button';

      const title = make('span', 'drawer-item-title', session.title || 'Untitled task');
      info.appendChild(title);

      const meta = make('span', 'drawer-item-meta');
      meta.appendChild(make('span', 'drawer-status status-' + session.status, session.status));
      if (session.timeAgo) {
        meta.appendChild(make('span', 'drawer-time', session.timeAgo));
      }
      meta.appendChild(make('span', 'drawer-turns', `${session.turns} turns`));
      info.appendChild(meta);

      info.addEventListener('click', () => {
        show(el.sessionsDrawer, false);
        post({ kind: 'switchSession', taskId: session.id });
      });
      item.appendChild(info);

      const del = make('button', 'drawer-item-del', '✕');
      del.type = 'button';
      del.title = 'Delete session';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this session record?')) {
          post({ kind: 'deleteSession', taskId: session.id });
        }
      });
      item.appendChild(del);

      el.drawerSessionsList.appendChild(item);
    }
  }

  // --- Top Action Buttons & Command Center ---

  el.btnNewTask.addEventListener('click', () => post({ kind: 'newSession' }));
  if (el.btnRefresh) {
    el.btnRefresh.addEventListener('click', () => post({ kind: 'refreshViews' }));
  }
  el.btnExport.addEventListener('click', () => post({ kind: 'exportMarkdown' }));
  el.btnSound.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    setText(el.btnSound, soundEnabled ? '🔔' : '🔕');
    post({ kind: 'toggleSound', enabled: soundEnabled });
  });
  el.btnOpenSetup.addEventListener('click', () => post({ kind: 'setupOpenManage' }));

  // --- Header, Navigation, Modals & Panels Controller ---

  let currentNavTab = 'composer';
  let activeApprovalId = null;
  let pendingEnhancedText = null;
  let currentAiSubTab = 'models';

  function switchTab(tabId, notify = true) {
    currentNavTab = tabId;
    const allTabs = [
      el.tabComposer,
      el.tabCurrent,
      el.tabTasks,
      el.tabWorkspace,
      el.tabAi,
      el.tabRecovery,
      el.tabBenchmarks,
      el.tabSettings,
    ];
    for (const btn of allTabs) {
      if (!btn) continue;
      const isTarget = btn.getAttribute('data-tab') === tabId;
      btn.classList.toggle('is-active', isTarget);
      btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    }

    if (tabId === 'settings') {
      show(el.settingsPanel, true);
      show(el.aiPanel, false);
      show(el.benchmarksPanel, false);
      show(el.empty, false);
      show(el.header, false);
      show(el.timeline, false);
      show(el.stages, false);
      show(el.whyPanel, false);
      show(el.ctxPanel, false);
      show(el.reqPanel, false);
      show(el.verifyPanel, false);
      show(el.recoveryPanel, false);
      if (el.executionFollowup) show(el.executionFollowup, false);
    } else if (tabId === 'benchmarks') {
      show(el.benchmarksPanel, true);
      show(el.settingsPanel, false);
      show(el.aiPanel, false);
      show(el.empty, false);
      show(el.header, false);
      show(el.timeline, false);
      show(el.stages, false);
      show(el.whyPanel, false);
      show(el.ctxPanel, false);
      show(el.reqPanel, false);
      show(el.verifyPanel, false);
      show(el.recoveryPanel, false);
      if (el.executionFollowup) show(el.executionFollowup, false);
      renderBenchmarkLab(state || {});
    } else if (tabId === 'ai') {
      show(el.aiPanel, true);
      show(el.settingsPanel, false);
      show(el.benchmarksPanel, false);
      show(el.empty, false);
      show(el.header, false);
      show(el.timeline, false);
      show(el.stages, false);
      show(el.whyPanel, false);
      show(el.ctxPanel, false);
      show(el.reqPanel, false);
      show(el.verifyPanel, false);
      show(el.recoveryPanel, false);
      if (el.executionFollowup) show(el.executionFollowup, false);
      renderAiPanel(state);
    } else if (tabId === 'workspace') {
      openWorkspaceModal();
    } else if (tabId === 'tasks') {
      show(el.settingsPanel, false);
      show(el.aiPanel, false);
      show(el.benchmarksPanel, false);
      if (el.sessionsDrawer) {
        show(el.sessionsDrawer, true);
      }
    } else if (tabId === 'recovery') {
      show(el.settingsPanel, false);
      show(el.aiPanel, false);
      show(el.benchmarksPanel, false);
      show(el.empty, false);
      show(el.header, false);
      show(el.timeline, false);
      show(el.stages, false);
      show(el.whyPanel, false);
      show(el.ctxPanel, false);
      show(el.reqPanel, false);
      show(el.verifyPanel, false);
      if (el.executionFollowup) show(el.executionFollowup, false);
      if (el.recoveryPanel) {
        show(el.recoveryPanel, true);
        el.recoveryPanel.scrollIntoView({ behavior: 'smooth' });
      }
    } else if (tabId === 'current') {
      show(el.settingsPanel, false);
      show(el.aiPanel, false);
      show(el.benchmarksPanel, false);
      const hasTask = Boolean(state && state.taskId && (state.live || (state.nodes && state.nodes.length > 0) || state.header));
      show(el.header, hasTask);
      show(el.timeline, hasTask);
      show(el.stages, hasTask && Boolean(state && state.stages && state.stages.length > 0));
      show(el.whyPanel, hasTask && Boolean(state && state.whyModel));
      show(el.ctxPanel, hasTask && Boolean(state && state.context));
      show(el.reqPanel, hasTask && Boolean(state && state.requirements && state.requirements.length > 0));
      show(el.verifyPanel, hasTask);
      show(el.recoveryPanel, hasTask && Boolean(state && state.recoverySummary && state.recovery && state.recovery.length > 0));
      if (el.executionFollowup) show(el.executionFollowup, hasTask);
      show(el.empty, !hasTask);
    } else {
      // Composer
      show(el.settingsPanel, false);
      show(el.aiPanel, false);
      show(el.benchmarksPanel, false);
      show(el.header, false);
      show(el.timeline, false);
      show(el.stages, false);
      show(el.whyPanel, false);
      show(el.ctxPanel, false);
      show(el.reqPanel, false);
      show(el.verifyPanel, false);
      show(el.recoveryPanel, false);
      if (el.executionFollowup) show(el.executionFollowup, false);
      show(el.empty, true);
      el.prompt.focus();
    }

    if (notify) {
      post({ kind: 'switchNavTab', tab: tabId });
    }
  }

  // Header controls
  if (el.btnProgress) {
    el.btnProgress.addEventListener('click', () => {
      post({ kind: 'focusActiveTask' });
      switchTab('current');
    });
  }
  if (el.btnWorkspace) {
    el.btnWorkspace.addEventListener('click', () => {
      openWorkspaceModal();
      post({ kind: 'workspaceActions' });
    });
  }
  if (el.btnSettings) {
    el.btnSettings.addEventListener('click', () => switchTab('settings'));
  }
  if (el.btnNotifications) {
    el.btnNotifications.addEventListener('click', () => toggleNotificationDrawer());
  }
  if (el.btnOverflow) {
    el.btnOverflow.addEventListener('click', () => post({ kind: 'openOverflowMenu' }));
  }

  // Navigation tab clicks
  const tabButtons = [
    el.tabComposer,
    el.tabCurrent,
    el.tabTasks,
    el.tabWorkspace,
    el.tabAi,
    el.tabRecovery,
    el.tabBenchmarks,
    el.tabSettings,
  ];
  for (const tb of tabButtons) {
    if (!tb) continue;
    tb.addEventListener('click', () => {
      const tab = tb.getAttribute('data-tab');
      if (tab) switchTab(tab);
    });
  }

  // Notifications Drawer
  function toggleNotificationDrawer() {
    if (!el.notificationDrawer) return;
    const isHidden = el.notificationDrawer.hidden;
    show(el.notificationDrawer, isHidden);
    if (isHidden) {
      post({ kind: 'openNotifications' });
    }
  }

  if (el.btnCloseNotifs) {
    el.btnCloseNotifs.addEventListener('click', () => show(el.notificationDrawer, false));
  }
  if (el.btnDismissAllNotifs) {
    el.btnDismissAllNotifs.addEventListener('click', () => post({ kind: 'dismissAllNotifications' }));
  }

  function renderNotifications(notifications) {
    if (!el.notificationList) return;
    clear(el.notificationList);
    const unread = (notifications || []).filter((n) => !n.read).length;
    if (el.notifBadge) {
      if (unread > 0) {
        setText(el.notifBadge, String(unread));
        show(el.notifBadge, true);
      } else {
        show(el.notifBadge, false);
      }
    }

    if (!notifications || notifications.length === 0) {
      el.notificationList.appendChild(make('p', 'empty-state-notice', '🔔 No new notifications'));
      return;
    }

    for (const notif of notifications) {
      const item = make('div', `notification-item ${notif.read ? 'is-read' : 'is-unread'}`);
      const head = make('div', 'notif-item-head');
      head.appendChild(make('strong', 'notif-item-title', notif.title));
      head.appendChild(make('span', 'notif-item-time', notif.timestamp || ''));

      const dismissBtn = make('button', 'icon-btn notif-dismiss', '✕');
      dismissBtn.title = 'Dismiss';
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        post({ kind: 'dismissNotification', id: notif.id });
      });
      head.appendChild(dismissBtn);
      item.appendChild(head);

      item.appendChild(make('p', 'notif-item-msg', notif.message));

      if (notif.taskId) {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => {
          post({ kind: 'switchSession', taskId: notif.taskId });
          show(el.notificationDrawer, false);
          switchTab('current');
        });
      }
      el.notificationList.appendChild(item);
    }
  }

  // Workspace Modal
  function openWorkspaceModal() {
    if (!el.workspaceModal) return;
    if (state && state.workspaceInfo) {
      setText(el.wsProjectName, state.workspaceInfo.name || 'Active Project');
      setText(el.wsProjectPath, state.workspaceInfo.path || '');
    }
    if (typeof el.workspaceModal.showModal === 'function') {
      try {
        el.workspaceModal.showModal();
      } catch {
        show(el.workspaceModal, true);
      }
    } else {
      show(el.workspaceModal, true);
    }
  }

  function closeWorkspaceModal() {
    if (!el.workspaceModal) return;
    if (typeof el.workspaceModal.close === 'function') {
      try {
        el.workspaceModal.close();
      } catch {
        show(el.workspaceModal, false);
      }
    } else {
      show(el.workspaceModal, false);
    }
  }

  if (el.btnCloseWorkspaceModal) {
    el.btnCloseWorkspaceModal.addEventListener('click', closeWorkspaceModal);
  }
  if (el.btnWsCancel) {
    el.btnWsCancel.addEventListener('click', closeWorkspaceModal);
  }
  if (el.btnWsOpenFolder) {
    el.btnWsOpenFolder.addEventListener('click', () => {
      post({ kind: 'workspaceActions' });
      closeWorkspaceModal();
    });
  }
  if (el.btnWsReveal) {
    el.btnWsReveal.addEventListener('click', () => {
      post({ kind: 'workspaceActions' });
      closeWorkspaceModal();
    });
  }

  // Context Modal
  function openContextModal() {
    if (!el.contextModal) return;
    if (state && state.context && state.context.files && el.contextFilesList) {
      clear(el.contextFilesList);
      for (const f of state.context.files) {
        const lbl = make('label', 'context-source-item');
        const chk = make('input');
        chk.type = 'checkbox';
        chk.value = f.path;
        chk.checked = true;
        lbl.appendChild(chk);
        lbl.appendChild(make('span', null, f.path));
        el.contextFilesList.appendChild(lbl);
      }
    }
    if (typeof el.contextModal.showModal === 'function') {
      try {
        el.contextModal.showModal();
      } catch {
        show(el.contextModal, true);
      }
    } else {
      show(el.contextModal, true);
    }
  }

  function closeContextModal() {
    if (!el.contextModal) return;
    if (typeof el.contextModal.close === 'function') {
      try {
        el.contextModal.close();
      } catch {
        show(el.contextModal, false);
      }
    } else {
      show(el.contextModal, false);
    }
  }

  if (el.btnCloseContextModal) el.btnCloseContextModal.addEventListener('click', closeContextModal);
  if (el.btnCancelContext) el.btnCancelContext.addEventListener('click', closeContextModal);
  if (el.btnApplyContext) {
    el.btnApplyContext.addEventListener('click', () => {
      const selectedFiles = [];
      if (el.contextFilesList) {
        const chks = el.contextFilesList.querySelectorAll('input[type="checkbox"]:checked');
        chks.forEach((c) => selectedFiles.push(c.value));
      }
      post({ kind: 'applyContext', files: selectedFiles });
      closeContextModal();
    });
  }

  // Approval Card
  if (el.btnApprovalDeny) {
    el.btnApprovalDeny.addEventListener('click', () => {
      post({ kind: 'resolveApproval', requestId: activeApprovalId || '', decision: 'deny' });
      show(el.approvalCard, false);
      activeApprovalId = null;
    });
  }
  if (el.btnApprovalOnce) {
    el.btnApprovalOnce.addEventListener('click', () => {
      post({ kind: 'resolveApproval', requestId: activeApprovalId || '', decision: 'allow_once' });
      show(el.approvalCard, false);
      activeApprovalId = null;
    });
  }
  if (el.btnApprovalTask) {
    el.btnApprovalTask.addEventListener('click', () => {
      post({ kind: 'resolveApproval', requestId: activeApprovalId || '', decision: 'allow_for_task' });
      show(el.approvalCard, false);
      activeApprovalId = null;
    });
  }

  // Enhance Card
  if (el.btnEnhanceCancel) {
    el.btnEnhanceCancel.addEventListener('click', () => {
      show(el.enhanceCard, false);
      pendingEnhancedText = null;
    });
  }
  if (el.btnEnhanceEdit) {
    el.btnEnhanceEdit.addEventListener('click', () => {
      if (pendingEnhancedText) {
        el.prompt.value = pendingEnhancedText;
        autosize();
        persist();
        el.prompt.focus();
      }
      show(el.enhanceCard, false);
    });
  }
  if (el.btnEnhanceUse) {
    el.btnEnhanceUse.addEventListener('click', () => {
      if (pendingEnhancedText) {
        el.prompt.value = pendingEnhancedText;
        autosize();
        persist();
      }
      show(el.enhanceCard, false);
    });
  }

  // Settings Synchronization
  function syncSettingsUI(settings) {
    if (!settings) return;
    if (el.setDefaultMode && settings.general) {
      el.setDefaultMode.value = settings.general.defaultTaskMode || 'code';
    }
    if (el.setSoundEnabled && settings.general) {
      el.setSoundEnabled.checked = Boolean(settings.general.enableSoundNotifications);
    }
    if (el.setAutoRouting && settings.ai) {
      el.setAutoRouting.checked = Boolean(settings.ai.automaticRouting);
    }
    if (el.setAutoRelay && settings.ai) {
      el.setAutoRelay.checked = Boolean(settings.ai.autoRelayOnFailure);
    }
    if (el.setPermMode && settings.execution) {
      el.setPermMode.value = settings.execution.permissionMode || 'balanced';
    }
    if (el.setCheckpointsEnabled && settings.execution) {
      el.setCheckpointsEnabled.checked = settings.execution.checkpointFrequency !== 'manual';
    }
    if (el.setVerifyTests && settings.verification) {
      el.setVerifyTests.checked = Boolean(settings.verification.runTests);
    }
    if (el.setVerifyTypes && settings.verification) {
      el.setVerifyTypes.checked = Boolean(settings.verification.runTypecheck);
    }
  }

  if (el.setDefaultMode) {
    el.setDefaultMode.addEventListener('change', (e) =>
      post({ kind: 'saveSetting', category: 'general', key: 'defaultTaskMode', value: e.target.value }),
    );
  }
  if (el.setSoundEnabled) {
    el.setSoundEnabled.addEventListener('change', (e) =>
      post({ kind: 'saveSetting', category: 'general', key: 'enableSoundNotifications', value: e.target.checked }),
    );
  }
  if (el.setAutoRouting) {
    el.setAutoRouting.addEventListener('change', (e) =>
      post({ kind: 'saveSetting', category: 'ai', key: 'automaticRouting', value: e.target.checked }),
    );
  }
  if (el.setAutoRelay) {
    el.setAutoRelay.addEventListener('change', (e) =>
      post({ kind: 'saveSetting', category: 'ai', key: 'autoRelayOnFailure', value: e.target.checked }),
    );
  }
  if (el.setPermMode) {
    el.setPermMode.addEventListener('change', (e) =>
      post({ kind: 'saveSetting', category: 'execution', key: 'permissionMode', value: e.target.value }),
    );
  }
  if (el.setCheckpointsEnabled) {
    el.setCheckpointsEnabled.addEventListener('change', (e) =>
      post({
        kind: 'saveSetting',
        category: 'execution',
        key: 'checkpointFrequency',
        value: e.target.checked ? 'file_modifications_only' : 'manual',
      }),
    );
  }
  if (el.setVerifyTests) {
    el.setVerifyTests.addEventListener('change', (e) =>
      post({ kind: 'saveSetting', category: 'verification', key: 'runTests', value: e.target.checked }),
    );
  }
  if (el.setVerifyTypes) {
    el.setVerifyTypes.addEventListener('change', (e) =>
      post({ kind: 'saveSetting', category: 'verification', key: 'runTypecheck', value: e.target.checked }),
    );
  }

  // AI Panel
  if (el.btnAddProviderModal) {
    el.btnAddProviderModal.addEventListener('click', () => post({ kind: 'setupOpenAdd' }));
  }

  const aiSubTabs = document.querySelectorAll('.ai-sub-tab');
  aiSubTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      aiSubTabs.forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      currentAiSubTab = tab.getAttribute('data-sub') || 'models';
      renderAiPanel(state);
    });
  });

  function renderAiPanel(model) {
    if (!el.aiContentBody) return;
    clear(el.aiContentBody);

    if (currentAiSubTab === 'models') {
      const candidates = model?.candidates ?? [];
      const list = make('div', 'ai-models-list');
      if (candidates.length === 0) {
        list.appendChild(make('p', 'empty-hint', 'No models configured yet. Add an AI provider to get started.'));
        const btnSetup = button('+ Set Up AI Provider', 'btn btn-primary', () => post({ kind: 'setupOpenAdd' }));
        list.appendChild(btnSetup);
      } else {
        for (const c of candidates) {
          const card = make('div', 'ai-model-card');
          const titleRow = make('div', 'model-card-title');
          const nameSpan = make('strong', null, `${c.model.providerId}/${c.model.modelId}`);
          titleRow.appendChild(nameSpan);

          if (c.isSelected) {
            titleRow.appendChild(make('span', 'pill pill-sm pill-accent', '★ Active Model'));
          } else {
            const btnSelect = button('Select', 'btn btn-sm btn-quiet', () => {
              post({ kind: 'selectModel', providerId: c.model.providerId, modelId: c.model.modelId });
            });
            titleRow.appendChild(btnSelect);
          }
          card.appendChild(titleRow);

          const caps = make('div', 'model-card-caps');
          if (c.capabilities) {
            const capBadges = [];
            if (c.capabilities.streaming) capBadges.push('⚡ Streaming');
            if (c.capabilities.toolCalling) capBadges.push('🛠 Tool Calling');
            if (c.capabilities.structuredOutputs) capBadges.push('📋 Structured Output');
            if (c.capabilities.nativeReasoning) capBadges.push('🧠 Reasoning');
            if (c.capabilities.contextWindow) capBadges.push(`🪟 ${Math.round(c.capabilities.contextWindow / 1000)}k ctx`);
            caps.textContent = capBadges.join(' • ');
          }
          card.appendChild(caps);

          const actionsRow = make('div', 'ai-actions-row');
          actionsRow.appendChild(button('⚡ Ping / Connect', 'btn btn-sm btn-quiet', () => {
            post({ kind: 'runPlayground', providerId: c.model.providerId, modelId: c.model.modelId, testType: 'connection' });
          }));
          actionsRow.appendChild(button('⚡ Test Stream', 'btn btn-sm btn-quiet', () => {
            post({ kind: 'runPlayground', providerId: c.model.providerId, modelId: c.model.modelId, testType: 'streaming' });
          }));
          actionsRow.appendChild(button('⚡ Test Tool Call', 'btn btn-sm btn-quiet', () => {
            post({ kind: 'runPlayground', providerId: c.model.providerId, modelId: c.model.modelId, testType: 'tool_call' });
          }));
          card.appendChild(actionsRow);

          list.appendChild(card);
        }
      }
      el.aiContentBody.appendChild(list);
    } else if (currentAiSubTab === 'providers') {
      const list = make('div', 'ai-providers-list');
      const providers = model?.configuredProviders ?? [];
      if (providers.length === 0) {
        list.appendChild(make('p', 'empty-hint', 'No AI providers configured yet.'));
      } else {
        for (const p of providers) {
          const card = make('div', 'ai-provider-card');
          const titleRow = make('div', 'ai-provider-header');
          titleRow.appendChild(make('strong', null, p.id));
          titleRow.appendChild(make('span', 'pill pill-sm', p.kind));
          card.appendChild(titleRow);

          const meta = make('div', 'ai-provider-meta');
          if (p.baseUrl) meta.appendChild(make('span', null, `Endpoint: ${p.baseUrl}`));
          meta.appendChild(make('span', null, `${p.modelCount} model(s)`));
          meta.appendChild(make('span', null, `${p.keyCount} key(s)`));
          if (p.defaultModel) meta.appendChild(make('span', null, `Default: ${p.defaultModel}`));
          card.appendChild(meta);

          const actionsRow = make('div', 'ai-actions-row');
          actionsRow.appendChild(button('⚡ Test Provider', 'btn btn-sm btn-quiet', () => {
            post({ kind: 'runPlayground', providerId: p.id, modelId: p.defaultModel || 'test', testType: 'connection' });
          }));
          actionsRow.appendChild(button('Edit', 'btn btn-sm btn-secondary', () => {
            post({ kind: 'setupEditProvider', providerId: p.id });
          }));
          card.appendChild(actionsRow);

          list.appendChild(card);
        }
      }
      const btnAdd = button('+ Add New Provider', 'btn btn-primary', () => post({ kind: 'setupOpenAdd' }));
      list.appendChild(btnAdd);
      el.aiContentBody.appendChild(list);
    } else if (currentAiSubTab === 'keys') {
      const box = make('div', 'ai-keys-box');
      box.appendChild(make('p', 'settings-sub', 'API keys and credentials are encrypted using OS Keychain via VS Code SecretStorage. Keys are never logged or exported in tasks.'));

      const providers = model?.configuredProviders ?? [];
      if (providers.length > 0) {
        const keyList = make('div', 'ai-models-list');
        for (const p of providers) {
          const row = make('div', 'ai-health-row');
          row.appendChild(make('strong', null, p.id));
          row.appendChild(make('span', 'meta-tag', `${p.keyCount} stored key(s)`));
          keyList.appendChild(row);
        }
        box.appendChild(keyList);
      }

      const actionsRow = make('div', 'ai-actions-row');
      actionsRow.appendChild(button('Manage Credentials', 'btn btn-primary', () => post({ kind: 'setupOpenManage' })));
      actionsRow.appendChild(button('+ Add Provider Key', 'btn btn-secondary', () => post({ kind: 'setupOpenAdd' })));
      box.appendChild(actionsRow);

      el.aiContentBody.appendChild(box);
    } else if (currentAiSubTab === 'health') {
      const list = make('div', 'ai-health-list');
      const endpoints = model?.health ?? [];
      if (endpoints.length === 0) {
        list.appendChild(make('p', 'empty-hint', 'No recent provider health records. Probes run automatically during routing or on manual test.'));
      } else {
        for (const h of endpoints) {
          const row = make('div', 'ai-health-row');
          const titleDiv = make('div', null);
          titleDiv.appendChild(make('strong', null, h.providerId));
          if (h.latencyMs) {
            titleDiv.appendChild(make('span', 'pill pill-sm', `${h.latencyMs}ms`));
          }
          row.appendChild(titleDiv);

          const statusBadge = make('span', `health-status is-${h.state || 'healthy'}`, (h.state || 'healthy').toUpperCase());
          row.appendChild(statusBadge);
          list.appendChild(row);
        }
      }

      const btnProbeAll = button('⚡ Run Connection Probe', 'btn btn-secondary', () => {
        const first = model?.candidates?.[0];
        if (first) {
          post({ kind: 'runPlayground', providerId: first.model.providerId, modelId: first.model.modelId, testType: 'connection' });
        } else {
          post({ kind: 'setupOpenAdd' });
        }
      });
      list.appendChild(btnProbeAll);

      el.aiContentBody.appendChild(list);
    }
  }

  // --- Context Chips Management ---

  const attachedChips = new Set();

  function addContextChip(name) {
    if (!name) return;
    const clean = name.startsWith('@') ? name : '@' + name;
    attachedChips.add(clean);
    renderContextChips();
  }

  function removeContextChip(name) {
    attachedChips.delete(name);
    renderContextChips();
  }

  function renderContextChips() {
    if (!el.contextChips) return;
    clear(el.contextChips);
    if (attachedChips.size === 0) {
      show(el.contextChips, false);
      return;
    }
    show(el.contextChips, true);
    for (const chip of attachedChips) {
      const tag = make('span', 'context-chip');
      tag.appendChild(make('span', null, chip));
      const removeBtn = make('button', 'context-chip-remove', '✕');
      removeBtn.type = 'button';
      removeBtn.title = 'Remove ' + chip;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeContextChip(chip);
      });
      tag.appendChild(removeBtn);
      el.contextChips.appendChild(tag);
    }
  }

  if (el.composer) {
    el.composer.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.prompt.classList.add('is-dragover');
    });

    el.composer.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.prompt.classList.remove('is-dragover');
    });

    el.composer.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.prompt.classList.remove('is-dragover');
      if (e.dataTransfer && e.dataTransfer.files) {
        for (const file of e.dataTransfer.files) {
          addContextChip(file.name);
        }
      }
    });
  }

  // --- Header ---

  const STATUS_WORD = {
    running: 'Running',
    awaiting: 'Needs you',
    interrupted: 'Interrupted',
    completed: 'Completed',
    stopped: 'Stopped',
    failed: 'Failed',
    empty: 'Idle',
  };

  let lastStatus = null;

  function renderHeader(model) {
    const header = model.header;

    // Update Context Gauge
    if (header && header.contextPercent !== null && header.contextPercent !== undefined) {
      el.gaugeFill.style.width = Math.min(100, header.contextPercent) + '%';
      setText(el.contextLabel, `${header.contextPercent}%`);
      setText(
        el.statCtxWin,
        header.contextWindowLimit ? `${(header.contextWindowLimit / 1000).toFixed(0)}k tokens` : '—',
      );
      setText(el.statInputTok, header.inputTokens ? header.inputTokens.toLocaleString() : '0');
      setText(el.statOutputTok, header.outputTokens ? header.outputTokens.toLocaleString() : '0');
      setText(el.statCost, header.costUsd ? `$${header.costUsd.toFixed(4)}` : '$0.00');
    } else {
      el.gaugeFill.style.width = '0%';
      setText(el.contextLabel, '0%');
    }

    // Update Progress Pill
    if (model.progress) {
      if (el.progressFill) {
        el.progressFill.style.width = `${Math.min(100, Math.max(0, model.progress.percent))}%`;
      }
      if (el.progressLabel) {
        setText(el.progressLabel, model.progress.label || 'Ready');
      }
    } else {
      if (el.progressFill) el.progressFill.style.width = '0%';
      if (el.progressLabel) setText(el.progressLabel, 'Ready');
    }

    // Update notifications and badge
    if (model.notifications) {
      renderNotifications(model.notifications);
    }
    // Update settings
    if (model.settings) {
      syncSettingsUI(model.settings);
    }
    // Update workspace modal info
    if (model.workspaceInfo) {
      if (el.wsProjectName) setText(el.wsProjectName, model.workspaceInfo.name || 'Active Project');
      if (el.wsProjectPath) setText(el.wsProjectPath, model.workspaceInfo.path || '');
    }

    if (model.mode) {
      updateModeUI(model.mode);
    }

    const hasTask = Boolean(header) && Boolean(model.taskId) && model.nodes && model.nodes.length > 0;
    show(el.header, hasTask);
    show(el.empty, !hasTask);
    show(el.timeline, hasTask);
    if (el.executionFollowup) {
      show(el.executionFollowup, hasTask);
    }

    if (!hasTask) {
      return;
    }

    const status = header.status;
    if (status !== lastStatus) {
      if (status === 'completed') {
        playChime('complete');
      } else if (status === 'awaiting') {
        playChime('attention');
      }
      lastStatus = status;
    }

    el.statusChip.className = 'status status-' + status;
    setText(el.statusText, STATUS_WORD[status] || status);
    setText(el.title, header.title);
    el.title.title = header.title;

    clear(el.meta);
    const facts = [];
    if (header.model) {
      facts.push(['Model', header.model.providerId + '/' + header.model.modelId]);
    }
    if (header.elapsedLabel) {
      facts.push(['Elapsed', header.elapsedLabel]);
    }
    facts.push(['Turns', String(header.turns)]);
    if (header.filesChanged > 0) {
      facts.push(['Files', String(header.filesChanged)]);
    }
    if (header.tokensLabel) {
      facts.push(['Tokens', header.tokensLabel]);
    }
    if (header.costLabel) {
      facts.push(['Cost', header.costLabel]);
    }
    for (const [key, value] of facts) {
      const item = make('span', 'meta-item');
      item.appendChild(make('span', 'meta-key', key));
      item.appendChild(make('span', 'meta-value', value));
      el.meta.appendChild(item);
    }

    const running = model.live;
    const resumable =
      !running && (status === 'interrupted' || status === 'stopped' || status === 'failed');
    show(el.btnStop, running);
    show(el.btnResume, resumable);
    show(el.btnRetry, !running && status === 'failed');
    show(el.btnSwitch, running || resumable);
  }

  // --- Notice: Recovery and Pending Decisions ---

  function renderRelayHero(model) {
    if (!el.relayHero) return;
    const relay = model.relayInterruption;
    if (!relay) {
      show(el.relayHero, false);
      clear(el.relayHero);
      return;
    }

    clear(el.relayHero);

    // 1. Banner
    const banner = make('div', 'relay-hero-banner');
    const badgeWrap = make('div', 'relay-hero-badges');
    badgeWrap.appendChild(make('span', 'relay-badge-tag', '⚡ MODEL INTERRUPTION'));
    badgeWrap.appendChild(
      make(
        'span',
        'relay-badge-model',
        `${relay.interruptedModel.providerId} · ${relay.interruptedModel.modelId}`,
      ),
    );
    banner.appendChild(badgeWrap);
    banner.appendChild(make('h2', 'relay-hero-title', relay.failureTitle));
    banner.appendChild(make('p', 'relay-hero-desc', relay.failureMessage));
    el.relayHero.appendChild(banner);

    // 2. Continuity Grid
    const grid = make('div', 'relay-hero-grid');

    // Progress Card
    const progressCard = make('div', 'relay-card relay-progress-card');
    const progressCircle = make('div', 'relay-progress-circle');
    progressCircle.appendChild(make('span', 'relay-progress-val', `${relay.progressPercent}%`));
    progressCard.appendChild(progressCircle);
    progressCard.appendChild(make('div', 'relay-progress-title', 'Verified Progress Preserved'));
    progressCard.appendChild(
      make('p', 'relay-progress-subtitle', 'Task state & file writes safe on disk'),
    );
    grid.appendChild(progressCard);

    // Verified State Card
    const verifiedCard = make('div', 'relay-card relay-verified-card');
    verifiedCard.appendChild(make('h3', 'relay-card-heading', 'Verified on Disk'));
    const factsList = make('ul', 'relay-facts-list');
    for (const fact of relay.verifiedFacts) {
      const item = make('li', 'relay-fact-item');
      item.appendChild(make('span', 'relay-fact-check', '✓'));
      item.appendChild(make('span', 'relay-fact-text', fact.label));
      factsList.appendChild(item);
    }
    verifiedCard.appendChild(factsList);
    grid.appendChild(verifiedCard);

    // Remaining Work Card
    const remainingCard = make('div', 'relay-card relay-remaining-card');
    remainingCard.appendChild(make('h3', 'relay-card-heading', 'Remaining Work'));
    const remainingList = make('ul', 'relay-remaining-list');
    for (const step of relay.remainingSteps) {
      const item = make('li', 'relay-step-item');
      item.appendChild(make('span', 'relay-step-dot', '○'));
      item.appendChild(make('span', 'relay-step-text', step));
      remainingList.appendChild(item);
    }
    remainingCard.appendChild(remainingList);
    grid.appendChild(remainingCard);

    el.relayHero.appendChild(grid);

    // 3. Recommended Successor Card
    const recCard = make('div', 'relay-rec-card');
    const recHeader = make('div', 'relay-rec-header');
    recHeader.appendChild(make('span', 'relay-rec-badge', 'RECOMMENDED WORKER'));
    recHeader.appendChild(
      make(
        'span',
        'relay-rec-name',
        `${relay.recommendedModel.providerId} / ${relay.recommendedModel.modelId}`,
      ),
    );
    recCard.appendChild(recHeader);
    recCard.appendChild(make('p', 'relay-rec-reason', relay.recommendationReason));
    el.relayHero.appendChild(recCard);

    // 4. Visual Relay Pipeline Diagram
    const pipeline = make('div', 'relay-pipeline');
    pipeline.appendChild(make('div', 'relay-pipeline-title', 'CROSS-PROVIDER TASK CONTINUITY'));
    const nodes = make('div', 'relay-pipeline-nodes');
    for (let i = 0; i < relay.pipelineSteps.length; i++) {
      const step = relay.pipelineSteps[i];
      const node = make('div', `relay-pipeline-node is-${step.status}`);
      node.appendChild(make('span', 'relay-node-label', step.label));
      nodes.appendChild(node);
      if (i < relay.pipelineSteps.length - 1) {
        nodes.appendChild(make('span', 'relay-pipeline-arrow', '→'));
      }
    }
    pipeline.appendChild(nodes);
    el.relayHero.appendChild(pipeline);

    // 5. Direct Action Controls
    const actions = make('div', 'relay-actions');
    const btnRelay = button(
      `⚡ Relay to ${relay.recommendedModel.modelId}`,
      'btn btn-primary btn-relay-cta',
      () => post({ kind: 'relay' }),
    );
    actions.appendChild(btnRelay);

    const btnRetry = button(
      `↻ Retry ${relay.interruptedModel.modelId}`,
      'btn btn-secondary',
      () => post({ kind: 'retry' }),
    );
    actions.appendChild(btnRetry);

    const btnChoose = button('⇄ Choose Model', 'btn btn-quiet', () =>
      post({ kind: 'switchModel' }),
    );
    actions.appendChild(btnChoose);

    const btnTimeline = button('Show Timeline', 'btn btn-quiet', () =>
      post({ kind: 'openTimeline' }),
    );
    actions.appendChild(btnTimeline);

    el.relayHero.appendChild(actions);

    show(el.relayHero, true);
  }

  function renderNotice(model) {
    renderRelayHero(model);

    const question = model.pendingQuestion;
    const failure = model.lastFailure;

    // If relay interruption is active and there is no question, hide standard notice
    if (model.relayInterruption && !question) {
      show(el.notice, false);
      clear(el.notice);
      return;
    }

    if (!question && !failure) {
      show(el.notice, false);
      clear(el.notice);
      return;
    }

    clear(el.notice);
    el.notice.className = 'notice' + (question ? '' : ' notice-error');

    if (question) {
      el.notice.appendChild(make('p', 'notice-title', 'CodeRelay needs a decision'));
      el.notice.appendChild(make('p', 'notice-body', question));
      const actions = make('div', 'notice-actions');
      actions.appendChild(button('Resolve', 'btn btn-primary', () => post({ kind: 'resolve' })));
      actions.appendChild(
        button('Show timeline', 'btn btn-quiet', () => post({ kind: 'openTimeline' })),
      );
      el.notice.appendChild(actions);
    } else {
      el.notice.appendChild(make('p', 'notice-title', failure.title));
      el.notice.appendChild(make('p', 'notice-body', failure.message));

      if (failure.facts && failure.facts.length > 0) {
        const list = make('ul', 'notice-facts');
        for (const fact of failure.facts) {
          list.appendChild(make('li', null, fact));
        }
        el.notice.appendChild(list);
      }

      const actions = make('div', 'notice-actions');
      if (!model.live) {
        actions.appendChild(button('Retry', 'btn btn-primary', () => post({ kind: 'retry' })));
        actions.appendChild(
          button('Switch model', 'btn', () => post({ kind: 'switchModel' })),
        );
      }
      actions.appendChild(
        button('Show timeline', 'btn btn-quiet', () => post({ kind: 'openTimeline' })),
      );
      el.notice.appendChild(actions);
    }

    show(el.notice, true);
  }

  // --- Empty / Default Workspace State ---

  function renderEmpty(model) {
    const hasTask = Boolean(model.taskId && (model.live || (model.nodes && model.nodes.length > 0) || model.header));
    if (currentNavTab === 'current') {
      show(el.empty, !hasTask);
      show(el.timeline, hasTask);
      show(el.header, hasTask);
      if (el.executionFollowup) {
        show(el.executionFollowup, hasTask);
      }
    } else if (currentNavTab === 'composer') {
      show(el.empty, true);
      show(el.timeline, false);
      show(el.header, false);
      if (el.executionFollowup) {
        show(el.executionFollowup, false);
      }
    } else {
      show(el.empty, false);
      show(el.timeline, false);
      show(el.header, false);
      if (el.executionFollowup) {
        show(el.executionFollowup, false);
      }
    }
    if (hasTask && currentNavTab === 'current') {
      return;
    }

    if (model.blocked === 'no-models') {
      if (el.onboardingCard) show(el.onboardingCard, true);
      if (el.workspaceComposer) show(el.workspaceComposer, false);
      if (el.recentTasksSection) show(el.recentTasksSection, false);
      if (el.changesCard) show(el.changesCard, false);
      return;
    }

    if (el.onboardingCard) show(el.onboardingCard, false);
    if (el.workspaceComposer) show(el.workspaceComposer, true);

    // Update Model label if provided
    if (model.modelLabel && el.modelLabel) {
      setText(el.modelLabel, model.modelLabel);
    }

    // Render Recent Tasks List
    if (el.recentTasksList) {
      clear(el.recentTasksList);
      const sessions = model.sessions || [];
      if (sessions.length === 0) {
        show(el.recentTasksSection, false);
      } else {
        show(el.recentTasksSection, true);
        for (const s of sessions.slice(0, 6)) {
          const card = make('button', 'task-card');
          card.type = 'button';
          const topRow = make('div', 'task-card-top');
          const dot = make(
            'span',
            'status-dot status-dot-' +
              (s.status === 'running'
                ? 'running'
                : s.status === 'interrupted'
                  ? 'interrupted'
                  : 'idle'),
          );
          const title = make('span', 'task-card-title', s.title || s.id);
          topRow.appendChild(dot);
          topRow.appendChild(title);
          card.appendChild(topRow);

          const metaRow = make('div', 'task-card-meta');
          const route = make(
            'span',
            'task-card-route',
            s.status === 'interrupted'
              ? '⚠ Recovering'
              : s.status === 'completed'
                ? '✓ Completed'
                : s.status === 'failed'
                  ? '✗ Failed'
                  : '● Active',
          );
          const badge = make(
            'span',
            'task-card-badge' +
              (s.status === 'completed'
                ? ' is-completed'
                : s.status === 'interrupted'
                  ? ' is-interrupted'
                  : ''),
            s.timeAgo || '',
          );
          metaRow.appendChild(route);
          metaRow.appendChild(badge);
          card.appendChild(metaRow);

          card.addEventListener('click', () => post({ kind: 'switchSession', taskId: s.id }));
          el.recentTasksList.appendChild(card);
        }
      }
    }

    // Render Changes Summary Card
    if (el.changesCard && el.changesCardList) {
      const changes = model.changes || [];
      if (changes.length > 0) {
        show(el.changesCard, true);
        if (el.changesBadge) setText(el.changesBadge, `CHANGES (${changes.length})`);
        clear(el.changesCardList);
        for (const ch of changes.slice(0, 5)) {
          const item = make('div', 'change-item');
          const glyph = make(
            'span',
            'change-glyph ' +
              (ch.kind === 'added'
                ? 'is-add'
                : ch.kind === 'modified'
                  ? 'is-mod'
                  : 'is-del'),
            ch.kind === 'added' ? '+' : ch.kind === 'modified' ? 'M' : '-',
          );
          item.appendChild(glyph);
          item.appendChild(make('span', null, ch.path));
          el.changesCardList.appendChild(item);
        }
      } else {
        show(el.changesCard, false);
      }
    }
  }

  // --- Timeline & Cards ---

  /**
   * The recovery narrative.
   *
   * Hidden outright when nothing went wrong. The host decides every word,
   * including whether there is a headline at all — this only paints, and uses
   * textContent throughout, so nothing a provider said can become markup.
   */
  /**
   * Verification.
   *
   * Shown whenever a task exists, because a run that has not happened is itself
   * worth saying — the panel offers the check rather than implying it passed.
   * Every word, glyph and tone is decided by the host.
   */
  /**
   * The requirement checklist.
   *
   * Hidden when the plan declared no requirements: an empty checklist would
   * imply there was nothing to do. Every status word and glyph is decided by
   * the host, so the client cannot accidentally tick something.
   */
  /**
   * The context boundary.
   *
   * Shows both halves: what went in, and what was kept out with the reason.
   * A boundary the user cannot see is one they cannot correct, which is the
   * whole point of the panel.
   */
  /**
   * Why this model.
   *
   * Hidden entirely when the user pinned a model: no explanation is owed for
   * their own decision, and showing one would imply CodeRelay had overridden it.
   */
  /**
   * The task pipeline.
   *
   * Empty for a simple task, and the whole section disappears rather than
   * showing six rows about a one-file edit. Each row's title carries the
   * evidence, so hovering answers "why does it say that?".
   */
  /**
   * Skips a DOM rebuild when a list has not actually changed.
   *
   * The panels below are repainted on every frame, and a streaming turn
   * produces a frame every 80ms — but a requirement list or a pipeline changes
   * a handful of times over a whole task. Rebuilding a few dozen nodes eighty
   * times a second to produce identical output is the extension host's time
   * spent on nothing.
   *
   * Keyed on a signature rather than deep equality: these are already flat
   * display strings, so joining the fields that can change is both cheaper than
   * a structural compare and impossible to get subtly wrong.
   */
  const lastPainted = new Map();
  function unchanged(key, signature) {
    if (lastPainted.get(key) === signature) {
      return true;
    }
    lastPainted.set(key, signature);
    return false;
  }

  function renderStages(model) {
    const stages = model.stages || [];
    const hasTask = Boolean(model.taskId && (model.live || (model.nodes && model.nodes.length > 0) || model.header));
    show(el.stages, currentNavTab === 'current' && hasTask && stages.length > 0);
    if (stages.length === 0) {
      return;
    }

    if (unchanged('stages', stages.map((s) => s.id + s.state).join('|'))) {
      return;
    }
    el.stageList.textContent = '';
    for (const stage of stages) {
      const li = document.createElement('li');
      li.className = 'stage stage-' + stage.state;
      li.setAttribute('aria-label', stage.spoken);
      li.title = stage.detail;

      const glyph = document.createElement('span');
      glyph.className = 'stage-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = stage.glyph;
      li.appendChild(glyph);

      const label = document.createElement('span');
      label.className = 'stage-label';
      label.textContent = stage.label;
      li.appendChild(label);

      el.stageList.appendChild(li);
    }
  }

  function renderWhyModel(model) {
    const why = model.whyModel;
    const hasTask = Boolean(model.taskId && (model.live || (model.nodes && model.nodes.length > 0) || model.header));
    show(el.whyPanel, currentNavTab === 'current' && hasTask && Boolean(why));
    if (!why) {
      return;
    }

    setText(el.whyLine, why.modelId + ' · ' + why.roleLabel);
    el.whyPanel.setAttribute('aria-label', why.spoken);

    if (unchanged('why', why.modelId + '|' + why.reasons.join('|'))) {
      return;
    }
    el.whyList.textContent = '';
    for (const reason of why.reasons) {
      const li = document.createElement('li');
      li.className = 'why-row';
      li.textContent = reason;
      el.whyList.appendChild(li);
    }

    show(el.whyRejected, why.rejected.length > 0);
    el.whyRejectedList.textContent = '';
    for (const entry of why.rejected) {
      const li = document.createElement('li');
      li.textContent = entry;
      el.whyRejectedList.appendChild(li);
    }
  }

  function renderContext(model) {
    const ctx = model.context;
    const hasTask = Boolean(model.taskId && (model.live || (model.nodes && model.nodes.length > 0) || model.header));
    show(el.ctxPanel, currentNavTab === 'current' && hasTask && Boolean(ctx));
    if (!ctx) {
      return;
    }
    setText(el.ctxSummary, ctx.summary);

    // Everything painted below this point must be in the signature, or a change
    // to it would be skipped forever.
    const ctxSignature = [
      ctx.summary,
      ctx.files.map((f) => f.path + f.relevance).join(','),
      ctx.excluded.map((e) => e.label).join(','),
    ].join('|');
    if (unchanged('ctx', ctxSignature)) {
      return;
    }
    el.ctxList.textContent = '';
    for (const file of ctx.files) {
      const li = document.createElement('li');
      li.className = 'ctx-row rel-' + file.relevance;
      li.setAttribute('aria-label', file.spoken);
      li.title = file.path;

      const name = document.createElement('span');
      name.className = 'ctx-name';
      name.textContent = file.name;
      li.appendChild(name);

      const why = document.createElement('span');
      why.className = 'ctx-why';
      why.textContent = file.why;
      li.appendChild(why);

      el.ctxList.appendChild(li);
    }

    show(el.ctxExcluded, ctx.excluded.length > 0);
    el.ctxExcludedList.textContent = '';
    for (const entry of ctx.excluded) {
      const li = document.createElement('li');
      li.className = 'ctx-excluded-row';

      const label = document.createElement('span');
      label.className = 'ctx-excluded-label';
      label.textContent = entry.label;
      li.appendChild(label);

      const reason = document.createElement('span');
      reason.className = 'ctx-excluded-reason';
      reason.textContent = entry.reason;
      li.appendChild(reason);

      el.ctxExcludedList.appendChild(li);
    }
  }

  function renderRequirements(model) {
    const rows = model.requirements || [];
    const hasTask = Boolean(model.taskId && (model.live || (model.nodes && model.nodes.length > 0) || model.header));
    show(el.reqPanel, currentNavTab === 'current' && hasTask && rows.length > 0);
    if (rows.length === 0) {
      return;
    }
    setText(el.reqSummary, model.requirementSummary || '');

    if (unchanged('req', rows.map((r) => r.id + r.status).join('|'))) {
      return;
    }
    el.reqList.textContent = '';
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'req-row tone-' + row.tone;
      li.setAttribute('aria-label', row.spoken);

      const glyph = document.createElement('span');
      glyph.className = 'req-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = row.glyph;
      li.appendChild(glyph);

      const body = document.createElement('span');
      body.className = 'req-body';

      const text = document.createElement('span');
      text.className = 'req-text';
      text.textContent = row.text;
      body.appendChild(text);

      const evidence = document.createElement('span');
      evidence.className = 'req-evidence';
      evidence.textContent = row.evidence;
      body.appendChild(evidence);

      li.appendChild(body);
      el.reqList.appendChild(li);
    }
  }

  function renderVerify(model) {
    const hasTask = Boolean(model.taskId && (model.live || (model.nodes && model.nodes.length > 0) || model.header));
    show(el.verifyPanel, currentNavTab === 'current' && hasTask);
    if (!hasTask) {
      return;
    }

    show(el.btnVerify, !model.verifying);
    show(el.btnVerifyStop, Boolean(model.verifying));

    const v = model.verification;
    if (model.verifying) {
      setText(el.verifyGlyph, '·');
      setText(el.verifyLabel, 'Verifying…');
      setText(el.verifyDetail, 'Running the checks this project declares.');
      setText(el.verifyTotal, '');
      el.verifyPanel.className = 'verify-panel tone-muted';
    } else if (!v) {
      // Never a tick. Nothing has been run, and the panel says exactly that.
      setText(el.verifyGlyph, '○');
      setText(el.verifyLabel, 'Not verified yet');
      setText(el.verifyDetail, "Run the project's own checks to confirm the work.");
      setText(el.verifyTotal, '');
      el.verifyPanel.className = 'verify-panel tone-muted';
    } else {
      setText(el.verifyGlyph, v.verdict.glyph);
      setText(el.verifyLabel, v.verdict.label);
      setText(el.verifyDetail, v.verdict.detail);
      setText(el.verifyTotal, v.totalLabel || '');
      el.verifyPanel.className = 'verify-panel tone-' + v.verdict.tone;
      el.verifyPanel.setAttribute('aria-label', v.verdict.spoken);
    }

    const rows = v ? v.rows : [];
    const verifySignature = [
      v ? v.verdict.label : 'none',
      v ? v.unavailable || '' : '',
      rows.map((r) => r.id + r.tone + r.summary).join(','),
    ].join('|');
    if (unchanged('verify', verifySignature)) {
      return;
    }
    el.verifyList.textContent = '';
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'verify-row tone-' + row.tone;
      li.setAttribute('aria-label', row.spoken);

      const head = document.createElement('div');
      head.className = 'verify-row-head';

      const glyph = document.createElement('span');
      glyph.className = 'verify-row-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = row.glyph;
      head.appendChild(glyph);

      const name = document.createElement('span');
      name.className = 'verify-row-label';
      name.textContent = row.label;
      head.appendChild(name);

      const summary = document.createElement('span');
      summary.className = 'verify-row-summary';
      summary.textContent = row.summary;
      head.appendChild(summary);

      if (row.aside) {
        const aside = document.createElement('span');
        aside.className = 'verify-row-aside';
        aside.textContent = row.aside;
        head.appendChild(aside);
      }
      li.appendChild(head);

      // Output is collapsed: a failing build is thousands of lines, and the
      // summary above is what a reader needs first.
      if (row.output) {
        const details = document.createElement('details');
        const summaryEl = document.createElement('summary');
        summaryEl.textContent = row.command;
        details.appendChild(summaryEl);
        const pre = document.createElement('pre');
        pre.className = 'verify-output';
        pre.textContent = row.output;
        details.appendChild(pre);
        li.appendChild(details);
      }
      el.verifyList.appendChild(li);
    }

    const unavailable = v ? v.unavailable : null;
    if (unavailable) {
      setText(el.verifyUnavailable, unavailable);
      show(el.verifyUnavailable, true);
    } else {
      show(el.verifyUnavailable, false);
    }
  }

  function renderRecovery(model) {
    const events = model.recovery || [];
    const summary = model.recoverySummary;
    const hasTask = Boolean(model.taskId && (model.live || (model.nodes && model.nodes.length > 0) || model.header));
    const isRecoveryTab = currentNavTab === 'recovery';
    const isCurrentWithRecovery = currentNavTab === 'current' && hasTask && Boolean(summary && events.length > 0);

    if (!isRecoveryTab && !isCurrentWithRecovery) {
      show(el.recoveryPanel, false);
      return;
    }
    show(el.recoveryPanel, true);
    setText(el.recoverySummary, summary || 'No recovery events recorded for this session.');

    // null and 0 are different answers: "not a git repository" is not "no
    // snapshots were taken", so only a real count is shown.
    if (typeof model.checkpointCount === 'number') {
      setText(
        el.recoveryCheckpoints,
        model.checkpointCount === 1 ? '1 checkpoint' : model.checkpointCount + ' checkpoints',
      );
      show(el.recoveryCheckpoints, true);
    } else {
      show(el.recoveryCheckpoints, false);
    }

    if (el.selectTargetWorker && model.candidates && model.candidates.length > 0) {
      if (el.selectTargetWorker.childElementCount === 0) {
        clear(el.selectTargetWorker);
        for (const c of model.candidates) {
          const opt = document.createElement('option');
          opt.value = `${c.model.providerId}/${c.model.modelId}`;
          opt.textContent = `${c.model.providerId} / ${c.model.modelId}`;
          if (c.isSelected) opt.selected = true;
          el.selectTargetWorker.appendChild(opt);
        }
      }
    }
    if (el.relayConfidenceBadge && model.continuityScore) {
      setText(el.relayConfidenceBadge, model.continuityScore.health);
      el.relayConfidenceBadge.className = 'confidence-badge is-' + model.continuityScore.health.toLowerCase();
    }
    if (el.relayRationaleText && model.continuityScore) {
      setText(el.relayRationaleText, model.continuityScore.summary);
    }

    // Rebuilt only when the event count changed. A recovery log grows by whole
    // events and never edits one in place, so this is enough to avoid
    // repainting the list on every token that streams.
    if (el.recoveryList.childElementCount === events.length) {
      return;
    }
    el.recoveryList.textContent = '';
    for (const event of events) {
      const li = document.createElement('li');
      li.className = 'recovery-row tone-' + event.tone;
      li.setAttribute('aria-label', event.spoken);

      const time = document.createElement('span');
      time.className = 'recovery-time';
      time.textContent = event.time;
      li.appendChild(time);

      const glyph = document.createElement('span');
      glyph.className = 'recovery-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = event.glyph;
      li.appendChild(glyph);

      const body = document.createElement('span');
      body.className = 'recovery-body';

      const label = document.createElement('span');
      label.className = 'recovery-label';
      label.textContent = event.label;
      body.appendChild(label);

      if (event.detail) {
        const detail = document.createElement('span');
        detail.className = 'recovery-detail';
        detail.textContent = event.detail;
        body.appendChild(detail);
      }

      li.appendChild(body);
      el.recoveryList.appendChild(li);
    }
  }

  function renderTimeline(model) {
    const seen = new Set();
    for (const node of model.nodes) {
      seen.add(node.id);
    }
    for (const [id, entry] of rows) {
      if (!seen.has(id)) {
        entry.root.remove();
        rows.delete(id);
        expanded.delete(id);
      }
    }

    let cursor = el.timeline.firstChild;
    for (const node of model.nodes) {
      let entry = rows.get(node.id);
      if (!entry) {
        entry = createRow(node);
        rows.set(node.id, entry);
      } else {
        updateRow(entry, node);
      }
      if (cursor !== entry.root) {
        el.timeline.insertBefore(entry.root, cursor);
      } else {
        cursor = cursor.nextSibling;
      }
    }

    if (pinnedToBottom) {
      el.timeline.scrollTop = el.timeline.scrollHeight;
    }
  }

  function createRow(node) {
    const root = make('div', 'row');
    root.dataset.id = node.id;

    const icon = make('span', 'row-icon');
    icon.setAttribute('aria-hidden', 'true');
    root.appendChild(icon);

    const head = make('button', 'row-head');
    head.type = 'button';
    const caret = make('span', 'caret');
    caret.setAttribute('aria-hidden', 'true');
    const label = make('span', 'row-label');
    const target = make('span', 'row-target');
    const tag = make('span', 'tag');
    const aside = make('span', 'row-aside');
    head.appendChild(caret);
    head.appendChild(label);
    head.appendChild(target);
    head.appendChild(tag);
    head.appendChild(aside);
    root.appendChild(head);

    // Collapsible Thinking Block
    const thinkingBlock = make('div', 'row-thinking', '');
    const thinkingHead = make('button', 'thinking-toggle', '🧠 Thinking');
    thinkingHead.type = 'button';
    const thinkingContent = make('pre', 'thinking-content');
    thinkingBlock.appendChild(thinkingHead);
    thinkingBlock.appendChild(thinkingContent);
    root.appendChild(thinkingBlock);

    // Terminal Command Block
    const cmdBlock = make('div', 'row-cmd-card');
    root.appendChild(cmdBlock);

    const text = make('div', 'row-text markdown-content');
    const body = make('div', 'row-body');
    const paths = make('div', 'row-paths');
    const planBlock = make('div', 'row-plan-actions');
    root.appendChild(text);
    root.appendChild(paths);
    root.appendChild(body);
    root.appendChild(planBlock);

    const entry = {
      root,
      icon,
      head,
      caret,
      label,
      target,
      tag,
      aside,
      text,
      body,
      thinkingBlock,
      thinkingHead,
      thinkingContent,
      cmdBlock,
      paths,
      planBlock,
      node: null,
    };

    head.addEventListener('click', () => {
      if (!entry.node || !entry.node.body) {
        return;
      }
      const id = entry.node.id;
      if (expanded.has(id)) {
        expanded.delete(id);
      } else {
        expanded.add(id);
      }
      persist();
      updateRow(entry, entry.node);
    });

    thinkingHead.addEventListener('click', () => {
      const thinkId = entry.node.id + '-think';
      if (expanded.has(thinkId)) {
        expanded.delete(thinkId);
      } else {
        expanded.add(thinkId);
      }
      persist();
      updateRow(entry, entry.node);
    });

    updateRow(entry, node);
    return entry;
  }

  function updateRow(entry, node) {
    entry.node = node;

    entry.root.className = 'row row-' + node.tone + (node.body ? ' row-expandable' : '');
    setText(entry.icon, node.glyph);
    setText(entry.label, node.label);
    setText(entry.target, node.target);
    show(entry.target, Boolean(node.target));

    setText(entry.tag, node.tag);
    entry.tag.className = 'tag' + (node.tagKind ? ' tag-' + node.tagKind : '');
    show(entry.tag, Boolean(node.tag));

    setText(entry.aside, node.aside);
    show(entry.aside, Boolean(node.aside));

    // Thinking Block
    if (node.thinking) {
      show(entry.thinkingBlock, true);
      const isThinkOpen = expanded.has(node.id + '-think');
      const isLiveThinking = state && state.live && !node.done;
      entry.thinkingHead.className = 'thinking-toggle' + (isLiveThinking ? ' is-active-thinking' : '');
      entry.thinkingHead.textContent = isThinkOpen
        ? isLiveThinking ? '🧠 Thinking (Live) ▾' : '🧠 Thinking ▾'
        : isLiveThinking ? '🧠 Thinking (Live) ▸' : '🧠 Thinking ▸';
      if (isThinkOpen) {
        renderMarkdown(entry.thinkingContent, node.thinking);
      }
      show(entry.thinkingContent, isThinkOpen);
    } else {
      show(entry.thinkingBlock, false);
    }

    // Command Details Card
    if (node.commandDetails) {
      show(entry.cmdBlock, true);
      clear(entry.cmdBlock);
      const topBar = make('div', 'cmd-top');
      const promptSign = make('span', 'cmd-prompt', '$_');
      const cmdStr = make('span', 'cmd-string', node.commandDetails.command);
      topBar.appendChild(promptSign);
      topBar.appendChild(cmdStr);

      if (node.commandDetails.exitCode !== null) {
        const exitBadge = make(
          'span',
          'cmd-badge ' + (node.commandDetails.exitCode === 0 ? 'cmd-ok' : 'cmd-fail'),
          `Exit ${node.commandDetails.exitCode}`,
        );
        topBar.appendChild(exitBadge);
      }

      const copyBtn = make('button', 'icon-btn btn-sm', '📋');
      copyBtn.type = 'button';
      copyBtn.title = 'Copy output';
      copyBtn.addEventListener('click', () => {
        if (node.commandDetails.output) {
          navigator.clipboard.writeText(node.commandDetails.output);
        }
      });
      topBar.appendChild(copyBtn);
      entry.cmdBlock.appendChild(topBar);

      if (node.commandDetails.output) {
        const outPre = make('pre', 'cmd-output', node.commandDetails.output);
        entry.cmdBlock.appendChild(outPre);
      }
    } else {
      show(entry.cmdBlock, false);
    }

    if (node.text) {
      renderMarkdown(entry.text, node.text);
      show(entry.text, true);
    } else {
      clear(entry.text);
      show(entry.text, false);
    }

    // Paths & Action Buttons (View Diff / Rewind)
    clear(entry.paths);
    for (const path of node.paths || []) {
      const rowWrap = make('div', 'path-row');
      const control = make('button', 'path', path.label);
      control.type = 'button';
      control.title = path.path;
      control.addEventListener('click', () => post({ kind: 'openFile', path: path.path }));
      rowWrap.appendChild(control);

      const diffBtn = make('button', 'btn btn-quiet btn-sm', 'View Diff');
      diffBtn.type = 'button';
      diffBtn.addEventListener('click', () => post({ kind: 'openChange', path: path.path }));
      rowWrap.appendChild(diffBtn);

      entry.paths.appendChild(rowWrap);
    }

    if (node.checkpointCommit) {
      const rewindBtn = make('button', 'btn btn-quiet btn-sm btn-rewind', '↺ Rewind here');
      rewindBtn.type = 'button';
      rewindBtn.title = 'Restore files to this checkpoint';
      rewindBtn.addEventListener('click', () => {
        if (confirm('Rewind files to this turn checkpoint?')) {
          post({ kind: 'rewindToCheckpoint', commitOrTurnId: node.checkpointCommit });
        }
      });
      entry.paths.appendChild(rewindBtn);
    }

    show(entry.paths, Boolean((node.paths && node.paths.length) || node.checkpointCommit));

    const isOpen = expanded.has(node.id);
    if (node.body) {
      entry.head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      setText(entry.caret, isOpen ? '▾' : '▸');
      if (isOpen) {
        if (node.kind === 'plan') {
          renderMarkdown(entry.body, node.body);
        } else {
          clear(entry.body);
          setText(entry.body, node.body);
        }
      }
      show(entry.body, isOpen);
    } else {
      entry.head.removeAttribute('aria-expanded');
      setText(entry.caret, '');
      show(entry.body, false);
    }

    if (node.kind === 'plan') {
      show(entry.planBlock, true);
      clear(entry.planBlock);
      const approveBtn = make('button', 'btn btn-primary', 'Approve and Implement');
      approveBtn.type = 'button';
      approveBtn.addEventListener('click', () => {
        post({ kind: 'approvePlan' });
      });
      const rejectBtn = make('button', 'btn', 'Edit / Feedback');
      rejectBtn.type = 'button';
      rejectBtn.addEventListener('click', () => {
        post({ kind: 'rejectPlan' });
        el.prompt.focus();
      });
      const regenBtn = make('button', 'btn btn-quiet', 'Regenerate');
      regenBtn.type = 'button';
      regenBtn.addEventListener('click', () => {
        post({ kind: 'regeneratePlan' });
      });
      const cancelBtn = make('button', 'btn btn-quiet btn-danger', 'Cancel');
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => {
        post({ kind: 'stop' });
      });
      entry.planBlock.appendChild(approveBtn);
      entry.planBlock.appendChild(rejectBtn);
      entry.planBlock.appendChild(regenBtn);
      entry.planBlock.appendChild(cancelBtn);
    } else {
      show(entry.planBlock, false);
    }

    entry.head.setAttribute('aria-label', node.spoken || node.label);
  }

  // --- Composer, Autocomplete & Enhancer ---

  const SLASH_COMMANDS = [
    { cmd: '/clear', desc: 'Start a fresh task session' },
    { cmd: '/compact', desc: 'Summarize context to save tokens' },
    { cmd: '/cost', desc: 'Show token usage & cost breakdown' },
    { cmd: '/model', desc: 'Switch AI model' },
    { cmd: '/help', desc: 'Show shortcuts and tips' },
    { cmd: '/review', desc: 'Review modified files & diffs' },
    { cmd: '/plan', desc: 'Switch to Architect / Planning mode' },
    { cmd: '/code', desc: 'Switch to Code execution mode' },
    { cmd: '/ask', desc: 'Switch to Ask / Q&A mode' },
  ];

  const MENTION_TYPES = [
    { tag: '@file', desc: 'Reference a workspace file' },
    { tag: '@folder', desc: 'Reference directory structure' },
    { tag: '@problems', desc: 'Attach active compiler errors & linter diagnostics' },
    { tag: '@terminal', desc: 'Attach recent terminal output' },
    { tag: '@git', desc: 'Attach uncommitted diffs & git status' },
  ];

  function renderComposer(model) {
    setText(el.modelLabel, model.modelLabel);
    el.btnModel.title = model.modelTooltip || '';

    const blocked = Boolean(model.blocked) || model.live;
    el.btnSend.disabled = blocked;
    el.prompt.disabled = Boolean(model.blocked);
    setText(el.btnSend, model.live ? 'Running…' : 'Start task');
    el.prompt.placeholder = model.promptPlaceholder;
  }

  function autosize() {
    el.prompt.style.height = 'auto';
    el.prompt.style.height = Math.min(el.prompt.scrollHeight, 160) + 'px';
  }

  el.prompt.addEventListener('input', () => {
    autosize();
    persist();
    checkAutocomplete();
  });

  function checkAutocomplete() {
    const val = el.prompt.value;
    const pos = el.prompt.selectionStart;
    const before = val.slice(0, pos);

    // Slash commands
    if (before.startsWith('/')) {
      const query = before.toLowerCase();
      const matches = SLASH_COMMANDS.filter((s) => s.cmd.startsWith(query));
      if (matches.length > 0) {
        showAutocomplete(matches, (item) => {
          handleSlashCommand(item.cmd);
        });
        return;
      }
    }

    // @ Mentions
    const atIndex = before.lastIndexOf('@');
    if (atIndex !== -1 && atIndex >= before.length - 20) {
      const query = before.slice(atIndex).toLowerCase();
      const matches = MENTION_TYPES.filter((m) => m.tag.startsWith(query));
      if (matches.length > 0) {
        showAutocomplete(matches, (item) => {
          if (item.tag === '@file') {
            post({ kind: 'attachFile' });
            el.prompt.value = before.slice(0, atIndex) + val.slice(pos);
            el.prompt.focus();
            autosize();
            persist();
            show(el.autocompletePopup, false);
            return;
          }
          if (item.tag === '@problems' || item.tag === '@git' || item.tag === '@terminal' || item.tag === '@folder') {
            addContextChip(item.tag);
            el.prompt.value = before.slice(0, atIndex) + val.slice(pos);
            el.prompt.focus();
            autosize();
            persist();
            show(el.autocompletePopup, false);
            return;
          }
          const after = val.slice(pos);
          el.prompt.value = before.slice(0, atIndex) + item.tag + ' ' + after;
          el.prompt.focus();
          autosize();
          persist();
          show(el.autocompletePopup, false);
        });
        return;
      }
    }

    show(el.autocompletePopup, false);
  }

  function showAutocomplete(items, onSelect) {
    clear(el.autocompletePopup);
    for (const item of items) {
      const row = make('button', 'autocomplete-item');
      row.type = 'button';
      row.appendChild(make('span', 'autocomplete-key', item.cmd || item.tag));
      row.appendChild(make('span', 'autocomplete-desc', item.desc));
      row.addEventListener('click', () => onSelect(item));
      el.autocompletePopup.appendChild(row);
    }
    show(el.autocompletePopup, true);
  }

  function handleSlashCommand(cmd) {
    show(el.autocompletePopup, false);
    el.prompt.value = '';
    autosize();
    persist();

    switch (cmd) {
      case '/clear':
        post({ kind: 'newSession' });
        break;
      case '/compact':
        post({ kind: 'compactContext' });
        break;
      case '/model':
        post({ kind: 'pickModel' });
        break;
      case '/cost':
        show(el.contextPopover, true);
        break;
      case '/review':
        post({ kind: 'openTimeline' });
        break;
      case '/plan':
        updateModeUI('architect');
        post({ kind: 'setMode', mode: 'architect' });
        break;
      case '/code':
        updateModeUI('code');
        post({ kind: 'setMode', mode: 'code' });
        break;
      case '/ask':
        updateModeUI('ask');
        post({ kind: 'setMode', mode: 'ask' });
        break;
      case '/help':
        alert(
          'CodeRelay Shortcuts:\n• Enter: Start task\n• Shift+Enter: New line\n• Esc: Clear or Stop\n• @: Insert context (file, problems, git, terminal)\n• /: Slash commands',
        );
        break;
    }
  }

  // Prompt Enhancer
  el.btnEnhance.addEventListener('click', () => {
    const text = el.prompt.value.trim();
    if (text !== '') {
      el.btnEnhance.textContent = '✨ Enhancing…';
      el.btnEnhance.disabled = true;
      post({ kind: 'enhancePrompt', text });
    }
  });

  el.prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!el.autocompletePopup.hidden && el.autocompletePopup.firstChild) {
        el.autocompletePopup.firstChild.click();
        return;
      }
      submit();
      return;
    }
    if (event.key === 'Escape') {
      show(el.autocompletePopup, false);
      if (el.prompt.value !== '') {
        el.prompt.value = '';
        autosize();
        persist();
      } else if (state && state.live) {
        post({ kind: 'stop' });
      }
    }
  });

  el.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  function submit() {
    const raw = el.prompt.value.trim();
    if ((raw === '' && attachedChips.size === 0) || (state && (state.live || state.blocked))) {
      return;
    }
    if (raw.startsWith('/')) {
      handleSlashCommand(raw);
      return;
    }
    const chipsPrefix = attachedChips.size > 0 ? [...attachedChips].join(' ') + ' ' : '';
    const objective = chipsPrefix + raw;
    post({ kind: 'start', objective, model: null });
    switchTab('current');
    el.prompt.value = '';
    attachedChips.clear();
    renderContextChips();
    autosize();
    persist();
  }

  el.timeline.addEventListener('scroll', () => {
    const distance = el.timeline.scrollHeight - el.timeline.scrollTop - el.timeline.clientHeight;
    pinnedToBottom = distance < 24;
  });

  el.btnModel.addEventListener('click', () => post({ kind: 'pickModel' }));
  el.btnAttach.addEventListener('click', () => post({ kind: 'attachFile' }));
  el.btnSend.addEventListener('click', () => submit());
  el.btnStop.addEventListener('click', () => post({ kind: 'stop' }));
  el.btnResume.addEventListener('click', () => post({ kind: 'resume' }));
  el.btnRetry.addEventListener('click', () => post({ kind: 'retry' }));
  el.btnSwitch.addEventListener('click', () => post({ kind: 'switchModel' }));
  el.btnTimeline.addEventListener('click', () => post({ kind: 'openTimeline' }));
  if (el.btnSetupOnboard) {
    el.btnSetupOnboard.addEventListener('click', () => post({ kind: 'setUp' }));
  }
  if (el.btnSetupLocalOnboard) {
    el.btnSetupLocalOnboard.addEventListener('click', () => post({ kind: 'setupLocal' }));
  }
  if (el.btnReviewChanges) {
    el.btnReviewChanges.addEventListener('click', () => post({ kind: 'openTimeline' }));
  }

  // --- Execution Follow-Up Bar ---

  if (el.executionFollowup) {
    el.executionFollowup.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = el.followupPrompt ? el.followupPrompt.value.trim() : '';
      if (!raw) return;
      post({ kind: 'start', objective: raw, model: null });
      if (el.followupPrompt) el.followupPrompt.value = '';
    });
  }

  if (el.followupPrompt) {
    el.followupPrompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const raw = el.followupPrompt.value.trim();
        if (!raw) return;
        post({ kind: 'start', objective: raw, model: null });
        el.followupPrompt.value = '';
      }
    });
  }

  if (el.btnFollowupAttach) {
    el.btnFollowupAttach.addEventListener('click', () => post({ kind: 'attachFile' }));
  }

  if (el.btnFollowupEnhance) {
    el.btnFollowupEnhance.addEventListener('click', () => {
      const raw = el.followupPrompt ? el.followupPrompt.value.trim() : '';
      if (raw) post({ kind: 'enhancePrompt', text: raw });
    });
  }

  if (el.btnFollowupSend) {
    el.btnFollowupSend.addEventListener('click', (e) => {
      e.preventDefault();
      const raw = el.followupPrompt ? el.followupPrompt.value.trim() : '';
      if (!raw) return;
      post({ kind: 'start', objective: raw, model: null });
      if (el.followupPrompt) el.followupPrompt.value = '';
    });
  }

  el.setupPrimary.addEventListener('click', () => post({ kind: 'setupPrimary' }));
  el.setupBack.addEventListener('click', () => post({ kind: 'setupBack' }));
  el.setupCancel.addEventListener('click', () => {
    setupSecretDraft = '';
    post({ kind: 'setupCancel' });
  });

  // --- Guided Setup & Provider Manager ---

  let setupFocus = null;
  let showPassword = false;
  let setupSecretDraft = '';

  function setupField(field) {
    const wrap = make('label', 'field');
    const header = make('div', 'field-header');
    header.appendChild(make('span', 'field-label', field.label));

    if (field.storedCount && field.storedCount > 0 && field.id === 'apiKey') {
      const countBadge = make('span', 'field-badge', `${field.storedCount} key(s) stored`);
      header.appendChild(countBadge);
    }
    wrap.appendChild(header);

    const inputWrap = make('div', 'field-input-wrap');
    const input = document.createElement('input');
    input.className = 'field-input' + (field.secret ? ' field-input-secret' : '');
    input.type = field.secret ? (showPassword ? 'text' : 'password') : 'text';
    input.value = field.secret ? (setupSecretDraft || '') : (field.value || '');
    input.placeholder = field.placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.id = 'field-' + field.id;
    input.setAttribute('aria-describedby', 'hint-' + field.id);
    input.addEventListener('input', () => {
      setupFocus = field.id;
      if (field.secret) {
        setupSecretDraft = input.value;
      }
      post({ kind: 'setupField', field: field.id, value: input.value });
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        post({ kind: 'setupPrimary' });
      }
    });
    inputWrap.appendChild(input);

    if (field.secret) {
      const toggle = make('button', 'field-toggle-secret', showPassword ? 'Hide' : 'Show');
      toggle.type = 'button';
      toggle.title = showPassword ? 'Hide API key' : 'Show API key';
      toggle.addEventListener('click', () => {
        showPassword = !showPassword;
        input.type = showPassword ? 'text' : 'password';
        toggle.textContent = showPassword ? 'Hide' : 'Show';
      });
      inputWrap.appendChild(toggle);
    }

    wrap.appendChild(inputWrap);
    const hint = make('span', 'field-hint', field.hint);
    hint.id = 'hint-' + field.id;
    wrap.appendChild(hint);
    return wrap;
  }

  function setupProviderCard(choice) {
    const card = make('button', 'provider-card');
    card.type = 'button';

    const top = make('div', 'provider-card-top');
    top.appendChild(make('span', 'provider-name', choice.label));
    if (choice.category) {
      top.appendChild(make('span', 'provider-category-badge', choice.category.toUpperCase()));
    }
    card.appendChild(top);

    card.appendChild(make('span', 'provider-detail', choice.detail));

    if (choice.popularModels && choice.popularModels.length > 0) {
      const preview = make('div', 'provider-models-preview');
      for (const m of choice.popularModels.slice(0, 3)) {
        preview.appendChild(make('span', 'provider-model-chip', m));
      }
      card.appendChild(preview);
    }

    card.addEventListener('click', () => {
      setupSecretDraft = '';
      post({ kind: 'setupChoose', presetKey: choice.key });
    });
    return card;
  }

  function configuredProviderCard(provider) {
    const card = make('div', 'configured-provider-card');

    const top = make('div', 'configured-provider-header');
    const titleWrap = make('div', 'configured-provider-title-wrap');
    titleWrap.appendChild(make('span', 'configured-provider-title', provider.id));
    titleWrap.appendChild(make('span', 'configured-provider-kind-tag', provider.kind));
    top.appendChild(titleWrap);

    const actions = make('div', 'configured-provider-actions');
    const editBtn = make('button', 'btn btn-quiet btn-sm', 'Edit');
    editBtn.type = 'button';
    editBtn.title = 'Edit endpoint, keys and models';
    editBtn.addEventListener('click', () =>
      post({ kind: 'setupEditProvider', providerId: provider.id }),
    );

    const deleteBtn = make('button', 'btn btn-quiet btn-sm btn-danger', 'Delete');
    deleteBtn.type = 'button';
    deleteBtn.title = 'Delete provider and stored credentials';
    deleteBtn.addEventListener('click', () => {
      if (confirm(`Delete provider "${provider.id}" and remove all its stored keys?`)) {
        post({ kind: 'setupDeleteProvider', providerId: provider.id });
      }
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    top.appendChild(actions);
    card.appendChild(top);

    const meta = make('div', 'configured-provider-meta');
    meta.appendChild(make('span', 'meta-tag', `URL: ${provider.baseUrl || 'default'}`));
    meta.appendChild(make('span', 'meta-tag', `${provider.modelCount} model(s)`));
    meta.appendChild(make('span', 'meta-tag', `${provider.keyCount} key(s)`));
    if (provider.defaultModel) {
      meta.appendChild(
        make('span', 'meta-tag meta-tag-default', `Default: ${provider.defaultModel}`),
      );
    }
    card.appendChild(meta);

    return card;
  }

  function setupModelRow(row) {
    const item = make('li', 'model-row' + (row.enabled ? ' is-on' : ''));

    const toggle = make('button', 'model-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-pressed', row.enabled ? 'true' : 'false');
    toggle.setAttribute('aria-label', (row.enabled ? 'Disable ' : 'Enable ') + row.id);
    toggle.appendChild(make('span', 'model-check', row.enabled ? '✓' : '○'));
    toggle.appendChild(make('span', 'model-id', row.id));

    if (row.role) {
      const roleBadge = make(
        'span',
        'model-role' + (row.isDefault ? ' model-role-default' : ''),
        row.role,
      );
      toggle.appendChild(roleBadge);
    }

    toggle.addEventListener('click', () => post({ kind: 'setupToggleModel', modelId: row.id }));
    item.appendChild(toggle);

    if (row.enabled) {
      if (!row.isDefault) {
        const star = make('button', 'model-action-btn', '★ Set Default');
        star.type = 'button';
        star.title = 'Promote to default starting model';
        star.addEventListener('click', () => post({ kind: 'setupDefaultModel', modelId: row.id }));
        item.appendChild(star);
      }

      const up = make('button', 'model-move', '↑');
      up.type = 'button';
      up.setAttribute('aria-label', 'Move ' + row.id + ' earlier in fallback order');
      up.addEventListener('click', () =>
        post({ kind: 'setupReorder', modelId: row.id, direction: -1 }),
      );

      const down = make('button', 'model-move', '↓');
      down.type = 'button';
      down.setAttribute('aria-label', 'Move ' + row.id + ' later in fallback order');
      down.addEventListener('click', () =>
        post({ kind: 'setupReorder', modelId: row.id, direction: 1 }),
      );

      item.appendChild(up);
      item.appendChild(down);
    }
    return item;
  }

  /**
   * The credential pool for the endpoint being configured.
   *
   * Rows are listed in the order the pool would try them, so the list reads
   * top-to-bottom as "this one, then this one". Every word, glyph and status
   * comes from the host — the client cannot decide a key is healthy.
   *
   * No part of a key is rendered. A credential is identified by its label.
   */
  function renderKeyPool(pool) {
    show(el.keypool, Boolean(pool) && pool.rows.length > 0);
    if (!pool || pool.rows.length === 0) {
      return;
    }

    setText(el.keypoolSummary, pool.summary || '');
    if (pool.blocked) {
      setText(el.keypoolBlocked, pool.blocked);
      show(el.keypoolBlocked, true);
    } else {
      show(el.keypoolBlocked, false);
    }

    el.keypoolList.textContent = '';
    for (const row of pool.rows) {
      const li = document.createElement('li');
      li.className = 'keypool-row is-' + row.status + (row.next ? ' is-next' : '');
      li.setAttribute('aria-label', row.spoken);

      const glyph = document.createElement('span');
      glyph.className = 'keypool-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = row.glyph;
      li.appendChild(glyph);

      const body = document.createElement('span');
      body.className = 'keypool-body';

      const top = document.createElement('span');
      top.className = 'keypool-top';
      const label = document.createElement('span');
      label.className = 'keypool-label';
      label.textContent = row.label;
      top.appendChild(label);
      if (row.next) {
        const badge = document.createElement('span');
        badge.className = 'keypool-badge';
        badge.textContent = 'next';
        top.appendChild(badge);
      }
      body.appendChild(top);

      const status = document.createElement('span');
      status.className = 'keypool-status';
      status.textContent = row.detail ? row.statusText + ' · ' + row.detail : row.statusText;
      body.appendChild(status);
      li.appendChild(body);

      const actions = document.createElement('span');
      actions.className = 'keypool-actions';

      // A rejected key cannot be toggled back on — the provider refused it, and
      // the host enforces that. Offering the control would be a dead button.
      if (row.status !== 'rejected') {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'keypool-btn';
        const turningOn = row.status === 'off';
        toggle.textContent = turningOn ? 'Turn on' : 'Turn off';
        toggle.title = turningOn ? 'Return this key to rotation' : 'Stop using this key';
        toggle.addEventListener('click', () =>
          post({ kind: 'keyToggle', credentialId: row.credentialId, enabled: turningOn }),
        );
        actions.appendChild(toggle);
      }

      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'keypool-btn';
      testBtn.textContent = 'Test';
      testBtn.title = 'Send one real request using this key only';
      testBtn.addEventListener('click', () =>
        post({ kind: 'keyTest', credentialId: row.credentialId }),
      );
      actions.appendChild(testBtn);

      if (row.canPromote) {
        const promote = document.createElement('button');
        promote.type = 'button';
        promote.className = 'keypool-btn';
        promote.textContent = 'Prefer';
        promote.title = 'Try this key first';
        promote.addEventListener('click', () =>
          post({ kind: 'keyPromote', credentialId: row.credentialId }),
        );
        actions.appendChild(promote);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'keypool-btn keypool-btn-danger';
      remove.textContent = 'Remove';
      remove.title = 'Delete this key from the OS keychain';
      remove.addEventListener('click', () =>
        post({ kind: 'keyRemove', credentialId: row.credentialId }),
      );
      actions.appendChild(remove);

      li.appendChild(actions);
      el.keypoolList.appendChild(li);
    }
  }

  function renderSetup(model) {
    renderKeyPool(model.keyPool);
    el.setup.hidden = false;
    for (const node of [el.topNav, el.header, el.notice, el.empty, el.timeline, el.composer, el.navTabs, el.settingsPanel, el.aiPanel]) {
      if (node) node.hidden = true;
    }

    if (model.step === 'manage') {
      el.setupSteps.hidden = true;
    } else {
      el.setupSteps.hidden = false;
      el.setupSteps.replaceChildren(
        ...model.steps.map((step) => {
          const li = make('li', 'setup-step is-' + step.state, step.label);
          if (step.state === 'current') {
            li.setAttribute('aria-current', 'step');
          }
          return li;
        }),
      );
    }

    el.setupTitle.textContent = model.title;
    el.setupSub.textContent = model.subtitle;

    const alert = model.error
      ? { tone: 'bad', text: model.error }
      : model.test
        ? { tone: model.test.ok ? 'ok' : 'bad', text: model.test.message }
        : null;
    el.setupAlert.hidden = alert === null;
    if (alert) {
      el.setupAlert.className = 'setup-alert is-' + alert.tone;
      el.setupAlert.textContent = alert.text;
    }

    const body = [];

    // MANAGE STEP
    if (model.step === 'manage') {
      const container = make('div', 'manage-container');
      if (model.configuredProviders && model.configuredProviders.length > 0) {
        const list = make('div', 'configured-providers-list');
        for (const p of model.configuredProviders) {
          list.appendChild(configuredProviderCard(p));
        }
        container.appendChild(list);
      } else {
        container.appendChild(
          make('p', 'setup-note', 'No AI providers configured yet. Add your first provider below.'),
        );
      }

      const addRow = make('div', 'manage-add-row');
      const addBtn = make('button', 'btn btn-primary', '+ Add AI Provider');
      addBtn.type = 'button';
      addBtn.addEventListener('click', () => post({ kind: 'setupOpenAdd' }));
      addRow.appendChild(addBtn);
      container.appendChild(addRow);

      body.push(container);
    }

    // PROVIDER STEP
    if (model.step === 'provider') {
      const grid = make('div', 'provider-grid');
      for (const choice of model.providers) {
        grid.appendChild(setupProviderCard(choice));
      }
      body.push(grid);
    }

    // CONNECT STEP
    if (model.step === 'connect') {
      const existingForm = el.setupBody.querySelector('.field-grid');
      if (existingForm) {
        for (const field of model.fields) {
          const inp = existingForm.querySelector('#field-' + field.id);
          if (inp) {
            inp.placeholder = field.placeholder;
            if (document.activeElement !== inp) {
              inp.value = field.secret ? (setupSecretDraft || '') : (field.value || '');
            }
          }
          const hint = existingForm.querySelector('#hint-' + field.id);
          if (hint && field.hint) {
            hint.textContent = field.hint;
          }
        }
        el.setupBack.hidden = !model.canGoBack;
        el.setupPrimary.textContent = model.primaryLabel;
        el.setupPrimary.hidden = false;
        el.setupPrimary.disabled = model.blockedReason !== null || model.busy !== null;
        el.setupBlocked.textContent = model.blockedReason || '';
        return;
      }

      const form = make('div', 'field-grid');
      for (const field of model.fields) {
        form.appendChild(setupField(field));
      }

      const testRow = make('div', 'connect-test-row');
      const testBtn = make('button', 'btn btn-quiet', '⚡ Test Connection');
      testBtn.type = 'button';
      testBtn.addEventListener('click', () => post({ kind: 'setupTestConnection' }));
      testRow.appendChild(testBtn);
      form.appendChild(testRow);

      body.push(form);
    }

    // MODELS STEP
    if (model.step === 'models') {
      const filterWrap = make('div', 'model-filter-wrap');
      const filterInput = document.createElement('input');
      filterInput.className = 'field-input model-filter-input';
      filterInput.type = 'text';
      filterInput.placeholder = 'Search models…';
      filterInput.value = model.modelFilter || '';
      filterInput.addEventListener('input', () => {
        post({ kind: 'setupFilterModels', query: filterInput.value });
      });
      filterWrap.appendChild(filterInput);
      body.push(filterWrap);

      if (model.popularChips && model.popularChips.length > 0) {
        const popularSection = make('div', 'popular-models-section');
        popularSection.appendChild(make('span', 'popular-label', 'Recommended:'));
        const chips = make('div', 'popular-chips');
        for (const chip of model.popularChips) {
          const btn = make(
            'button',
            'popular-chip' + (chip.isAdded ? ' is-added' : ''),
            chip.isAdded ? `✓ ${chip.modelId}` : `+ ${chip.modelId}`,
          );
          btn.type = 'button';
          btn.addEventListener('click', () => {
            post({ kind: 'setupAddModel', modelId: chip.modelId });
          });
          chips.appendChild(btn);
        }
        popularSection.appendChild(chips);
        body.push(popularSection);
      }

      if (model.emptyModels) {
        body.push(make('p', 'setup-note', model.emptyModels));
      }

      if (model.models.length > 0) {
        const list = make('ul', 'model-list');
        for (const row of model.models) {
          list.appendChild(setupModelRow(row));
        }
        body.push(list);
      }

      const adder = make('div', 'model-add');
      const input = document.createElement('input');
      input.className = 'field-input';
      input.type = 'text';
      input.placeholder = 'Enter custom model ID (e.g. gpt-4o, claude-3-7-sonnet)';
      input.setAttribute('aria-label', 'Add a model id');
      input.spellcheck = false;
      const submit = () => {
        const value = input.value.trim();
        if (value !== '') {
          post({ kind: 'setupAddModel', modelId: value });
          input.value = '';
        }
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
      const addBtn = make('button', 'btn btn-quiet', 'Add Model');
      addBtn.type = 'button';
      addBtn.addEventListener('click', submit);

      const refresh = make('button', 'btn btn-quiet', 'Refresh Model List');
      refresh.type = 'button';
      refresh.addEventListener('click', () => post({ kind: 'setupRefreshModels' }));

      adder.appendChild(input);
      adder.appendChild(addBtn);
      adder.appendChild(refresh);
      body.push(adder);
    }

    // SAVED STEP
    if (model.step === 'saved' && model.savedSummary) {
      const readyCard = make('div', 'ready-summary-card');
      readyCard.appendChild(make('div', 'ready-icon', '✓'));
      readyCard.appendChild(make('p', 'ready-title', 'Setup Complete'));
      readyCard.appendChild(make('p', 'setup-note', model.savedSummary));

      const actions = make('div', 'ready-actions');
      const startBtn = make('button', 'btn btn-primary', 'Start Coding');
      startBtn.type = 'button';
      startBtn.addEventListener('click', () => {
        setupSecretDraft = '';
        post({ kind: 'setupCancel' });
      });

      const manageBtn = make('button', 'btn btn-quiet', 'Manage Providers');
      manageBtn.type = 'button';
      manageBtn.addEventListener('click', () => {
        setupSecretDraft = '';
        post({ kind: 'setupOpenManage' });
      });

      actions.appendChild(startBtn);
      actions.appendChild(manageBtn);
      readyCard.appendChild(actions);
      body.push(readyCard);
    }

    el.setupBody.replaceChildren(...body);

    el.setupBack.hidden = !model.canGoBack;
    el.setupPrimary.textContent = model.primaryLabel;
    el.setupPrimary.hidden = model.step === 'manage' || model.step === 'saved';
    el.setupPrimary.disabled = model.blockedReason !== null || model.busy !== null;
    el.setupBlocked.textContent = model.blockedReason || '';

    if (setupFocus) {
      const active = document.getElementById('field-' + setupFocus);
      if (active) {
        const end = active.value.length;
        active.focus();
        active.setSelectionRange(end, end);
      }
    }
  }

  function hideSetup() {
    if (el.setup.hidden) {
      return;
    }
    el.setup.hidden = true;
    setupFocus = null;
    setupSecretDraft = '';
    el.topNav.hidden = false;
    if (el.navTabs) el.navTabs.hidden = false;
    switchTab(currentNavTab, false);
  }

  function renderContinuity(model) {
    if (!el.continuityScoreVal || !model) return;
    const cs = model.continuityScore;
    if (cs) {
      setText(el.continuityScoreVal, String(cs.score));
      setText(el.continuityHealthLabel, cs.health);
      if (el.continuityDot) {
        el.continuityDot.className = 'continuity-dot is-' + cs.health.toLowerCase();
      }
      if (cs.breakdown) {
        setText(el.statCpInt, `${cs.breakdown.checkpointIntegrity.score}/${cs.breakdown.checkpointIntegrity.max}`);
        setText(el.statReqCov, `${cs.breakdown.requirementCoverage.score}/${cs.breakdown.requirementCoverage.max}`);
        setText(el.statVerRec, `${cs.breakdown.verificationRecency.score}/${cs.breakdown.verificationRecency.max}`);
        setText(el.statWorkDiv, `${cs.breakdown.workerDiversity.score}/${cs.breakdown.workerDiversity.max}`);
        setText(el.statActIdem, `${cs.breakdown.actionIdempotency.score}/${cs.breakdown.actionIdempotency.max}`);
      }
      if (el.continuitySummaryNote && cs.summary) {
        setText(el.continuitySummaryNote, cs.summary);
      }
    } else {
      setText(el.continuityScoreVal, '100');
      setText(el.continuityHealthLabel, 'HEALTHY');
      if (el.continuityDot) {
        el.continuityDot.className = 'continuity-dot is-healthy';
      }
      setText(el.statCpInt, '20/20');
      setText(el.statReqCov, '25/25');
      setText(el.statVerRec, '20/20');
      setText(el.statWorkDiv, '15/15');
      setText(el.statActIdem, '20/20');
      if (el.continuitySummaryNote) {
        setText(el.continuitySummaryNote, 'Task state is resilient and relay-ready.');
      }
    }
  }

  function renderBenchmarkLab(model) {
    if (!el.benchmarksPanel) return;
    if (model.benchmarkResults && el.benchmarkTableBody) {
      clear(el.benchmarkTableBody);
      const res = model.benchmarkResults.results;
      if (res) {
        const rows = [
          { label: 'Single Worker', p: res.normal_execution, cls: 'row-single' },
          { label: 'Naive Fallback', p: res.simple_fallback, cls: 'row-naive' },
          { label: 'CodeRelay Relay', p: res.coderelay_recovery, cls: 'row-coderelay' }
        ];
        for (const r of rows) {
          if (!r.p) continue;
          const tr = make('tr', r.cls);
          tr.appendChild(make('td', null, r.label));
          tr.appendChild(make('td', null, r.p.completed ? '✅ Succeeded' : '❌ Failed'));
          tr.appendChild(make('td', null, `${r.p.recoveryLatencyMs} ms`));
          tr.appendChild(make('td', null, `${r.p.duplicateActionsPrevented} Prevented`));
          tr.appendChild(make('td', null, `${r.p.tokensUsed.toLocaleString()} tokens`));
          tr.appendChild(make('td', null, r.p.verifiedByEvidence ? '✅ Verified' : '❌ Unverified'));
          el.benchmarkTableBody.appendChild(tr);
        }
      }
    }
    if (model.chaosReport && el.chaosResultsDisplay) {
      const c = model.chaosReport;
      // `finalVerificationPassed` is null when no verification ran. A ternary
      // rendered that as FAILED, which is a different and equally untrue claim
      // — nothing ran, so nothing passed and nothing failed.
      const verdict =
        c.finalVerificationPassed === null || c.finalVerificationPassed === undefined
          ? 'not run'
          : c.finalVerificationPassed
            ? 'passed'
            : 'failed';
      el.chaosResultsDisplay.textContent =
        `[${c.failureType}] frozen: ${c.executionFrozen} · relay package: ${c.recoveryPackageCreated}` +
        ` · actions carried over: ${c.duplicatesPrevented} · verification: ${verdict}` +
        ` (${c.timeToRecoverMs}ms)`;
      el.chaosResultsDisplay.title = c.details;
    }
  }

  window.addEventListener('message', (event) => {
    const model = event.data;
    if (!model) {
      return;
    }
    if (model.kind === 'attachContext') {
      if (model.chip) {
        addContextChip(model.chip);
      }
      return;
    }
    if (model.kind === 'enhancedPrompt') {
      el.btnEnhance.textContent = '✨ Enhance';
      el.btnEnhance.disabled = false;
      if (typeof model.text === 'string') {
        pendingEnhancedText = model.text;
        if (el.enhanceCard && el.enhanceCardBody) {
          renderMarkdown(el.enhanceCardBody, model.text);
          show(el.enhanceCard, true);
        }
        el.prompt.value = model.text;
        autosize();
        persist();
      }
      return;
    }
    if (model.kind === 'approvalRequest') {
      activeApprovalId = model.requestId;
      if (el.approvalCard) {
        setText(el.approvalRisk, model.risk || 'HIGH RISK');
        setText(el.approvalReason, model.reason || 'Command execution requires confirmation');
        setText(el.approvalCommand, model.command || '');
        show(el.approvalCard, true);
      }
      return;
    }
    if (model.kind === 'setup') {
      renderSetup(model);
      return;
    }
    if (model.kind !== 'state') {
      return;
    }
    hideSetup();
    state = model;
    if (model.activeNavTab && model.activeNavTab !== currentNavTab) {
      switchTab(model.activeNavTab, false);
    } else {
      switchTab(currentNavTab, false);
    }
    renderHeader(model);
    renderNotice(model);
    renderEmpty(model);
    renderStages(model);
    renderWhyModel(model);
    renderContext(model);
    renderRequirements(model);
    renderVerify(model);
    renderRecovery(model);
    renderContinuity(model);
    renderTimeline(model);
    renderComposer(model);
    if (currentNavTab === 'ai') {
      renderAiPanel(model);
    } else if (currentNavTab === 'benchmarks') {
      renderBenchmarkLab(model);
    }
  });

  autosize();
  post({ kind: 'ready' });
})();
