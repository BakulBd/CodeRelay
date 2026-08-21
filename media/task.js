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
    btnCmdMenu: document.getElementById('btn-cmd-menu'),
    commandPopover: document.getElementById('command-popover'),
    btnExport: document.getElementById('btn-export'),
    btnSound: document.getElementById('btn-sound'),
    btnOpenSetup: document.getElementById('btn-open-setup'),

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
    notice: document.getElementById('notice'),
    empty: document.getElementById('empty'),
    onboardingCard: document.getElementById('onboarding-card'),
    btnSetupOnboard: document.getElementById('btn-setup-onboard'),
    btnSetupLocalOnboard: document.getElementById('btn-setup-local-onboard'),
    workspaceComposer: document.getElementById('workspace-composer'),
    recentTasksSection: document.getElementById('recent-tasks-section'),
    recentTasksList: document.getElementById('recent-tasks-list'),
    changesCard: document.getElementById('changes-card'),
    changesBadge: document.getElementById('changes-badge'),
    changesCardList: document.getElementById('changes-card-list'),
    btnReviewChanges: document.getElementById('btn-review-changes'),
    timeline: document.getElementById('timeline'),
    executionFollowup: document.getElementById('execution-followup'),
    followupPrompt: document.getElementById('followup-prompt'),
    btnFollowupAttach: document.getElementById('btn-followup-attach'),
    btnFollowupEnhance: document.getElementById('btn-followup-enhance'),
    btnFollowupSend: document.getElementById('btn-followup-send'),

    // Composer & Autocomplete
    composer: document.getElementById('composer') || document.getElementById('workspace-composer'),
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

  document.addEventListener('click', (e) => {
    if (!el.modeWrap || !el.contextGaugeWrap) return;
    if (!document.getElementById('mode-wrap').contains(e.target)) {
      show(el.modeMenu, false);
      el.btnMode.setAttribute('aria-expanded', 'false');
    }
    if (!document.getElementById('context-gauge-wrap').contains(e.target)) {
      show(el.contextPopover, false);
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
  if (el.btnCmdMenu && el.commandPopover) {
    el.btnCmdMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = el.commandPopover.hidden;
      show(el.commandPopover, isHidden);
      show(el.modeMenu, false);
      show(el.contextPopover, false);
    });

    for (const item of el.commandPopover.querySelectorAll('.command-item')) {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        show(el.commandPopover, false);
        const cmd = item.dataset.cmd;
        if (cmd === 'openHistory') {
          show(el.sessionsDrawer, true);
          el.drawerSearch.focus();
        } else if (cmd) {
          post({ kind: cmd });
        }
      });
    }
  }

  el.btnExport.addEventListener('click', () => post({ kind: 'exportMarkdown' }));
  el.btnSound.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    setText(el.btnSound, soundEnabled ? '🔔' : '🔕');
    post({ kind: 'toggleSound', enabled: soundEnabled });
  });
  el.btnOpenSetup.addEventListener('click', () => post({ kind: 'setupOpenManage' }));

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

  function renderNotice(model) {
    const question = model.pendingQuestion;
    const failure = model.lastFailure;

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
    const hasTask = Boolean(model.taskId) && model.nodes && model.nodes.length > 0;
    show(el.empty, !hasTask);
    show(el.timeline, hasTask);
    if (el.executionFollowup) {
      show(el.executionFollowup, hasTask);
    }
    if (hasTask) {
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

  el.setupPrimary.addEventListener('click', () => post({ kind: 'setupPrimary' }));
  el.setupBack.addEventListener('click', () => post({ kind: 'setupBack' }));
  el.setupCancel.addEventListener('click', () => post({ kind: 'setupCancel' }));

  // --- Guided Setup & Provider Manager ---

  let setupFocus = null;
  let showPassword = false;

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
    input.value = field.value;
    input.placeholder = field.placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.id = 'field-' + field.id;
    input.setAttribute('aria-describedby', 'hint-' + field.id);
    input.addEventListener('input', () => {
      setupFocus = field.id;
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

    card.addEventListener('click', () => post({ kind: 'setupChoose', presetKey: choice.key }));
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

  function renderSetup(model) {
    el.setup.hidden = false;
    for (const node of [el.topNav, el.header, el.notice, el.empty, el.timeline, el.composer]) {
      node.hidden = true;
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
      startBtn.addEventListener('click', () => post({ kind: 'setupCancel' }));

      const manageBtn = make('button', 'btn btn-quiet', 'Manage Providers');
      manageBtn.type = 'button';
      manageBtn.addEventListener('click', () => post({ kind: 'setupOpenManage' }));

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
    el.topNav.hidden = false;
    el.composer.hidden = false;
  }

  window.addEventListener('message', (event) => {
    const model = event.data;
    if (!model) {
      return;
    }
    if (model.kind === 'enhancedPrompt') {
      el.btnEnhance.textContent = '✨ Enhance';
      el.btnEnhance.disabled = false;
      if (typeof model.text === 'string') {
        el.prompt.value = model.text;
        autosize();
        persist();
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
    renderHeader(model);
    renderNotice(model);
    renderEmpty(model);
    renderTimeline(model);
    renderComposer(model);
  });

  autosize();
  post({ kind: 'ready' });
})();
