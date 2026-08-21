/**
 * The Models tree: what CodeRelay can route to, and whether it can right now.
 *
 * Every row comes from `buildCandidates`, which is the same function the router
 * uses. Nothing here has its own idea of which models exist, what they can do or
 * whether a key is usable — a second opinion would eventually disagree with the
 * router, and the view would then be confidently wrong about why a model was
 * skipped.
 *
 * That also means there is no model table in this file. Capabilities are declared
 * in settings for the reasons `catalog.ts` sets out, so what is displayed is what
 * the user told CodeRelay, never a guess this extension shipped.
 *
 * Availability is the useful column, and it is stated in words: "2 keys ready",
 * "cooling 38s", "no credential". A user whose task will not start needs to know
 * which of those three it is, because each has a different fix.
 */
import {
  EventEmitter,
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  type Event,
  type TreeDataProvider,
} from 'vscode';
import type { ModelRef } from '../../core/types.js';
import type { Candidate } from '../../policy/route.js';
import type { ProviderConfig } from '../../providers/catalog.js';

/** A provider grouping, or one model under it. */
export type ModelNode =
  | {
      readonly kind: 'provider';
      readonly id: string;
      readonly config: ProviderConfig | null;
      readonly candidates: readonly Candidate[];
    }
  | {
      readonly kind: 'model';
      readonly candidate: Candidate;
      readonly selected: boolean;
    };

/** What a caller must supply. Read on demand so settings edits appear at once. */
export interface ModelsTreeDeps {
  /** Candidates from `buildCandidates`, or null when configuration is unusable. */
  readonly candidates: () => readonly Candidate[];
  readonly provider: (providerId: string) => ProviderConfig | null;
  /** The model the selected task is on, so the tree can mark it. */
  readonly current: () => ModelRef | null;
}

export class ModelsTreeProvider implements TreeDataProvider<ModelNode> {
  private readonly changed = new EventEmitter<ModelNode | undefined>();
  readonly onDidChangeTreeData: Event<ModelNode | undefined> = this.changed.event;

  constructor(private readonly deps: ModelsTreeDeps) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: ModelNode): TreeItem {
    return node.kind === 'provider' ? providerItem(node) : modelItem(node);
  }

  getChildren(node?: ModelNode): ModelNode[] {
    const candidates = this.deps.candidates();

    if (node === undefined) {
      // Grouped by provider, in configuration order, because that is the order
      // the user wrote them in and therefore the order they expect to read.
      const byProvider = new Map<string, Candidate[]>();
      for (const candidate of candidates) {
        const bucket = byProvider.get(candidate.model.providerId);
        if (bucket === undefined) {
          byProvider.set(candidate.model.providerId, [candidate]);
        } else {
          bucket.push(candidate);
        }
      }
      return [...byProvider].map(([id, list]) => ({
        kind: 'provider' as const,
        id,
        config: this.deps.provider(id),
        candidates: list,
      }));
    }

    if (node.kind === 'provider') {
      const current = this.deps.current();
      return node.candidates.map((candidate) => ({
        kind: 'model' as const,
        candidate,
        selected: current !== null && sameRef(current, candidate.model),
      }));
    }

    return [];
  }

  /** The model a tree selection refers to. */
  static modelOf(node: unknown): ModelRef | null {
    if (typeof node === 'object' && node !== null && 'kind' in node) {
      const typed = node as ModelNode;
      return typed.kind === 'model' ? typed.candidate.model : null;
    }
    return null;
  }

  /**
   * The provider a tree selection sits under.
   *
   * A context-menu command receives the node object, not the string a palette
   * invocation would pass, so a command that wants a provider id has to unwrap
   * one. Resolving a model row to its parent as well means "Add Model" does the
   * expected thing wherever in the group it was invoked from.
   */
  static providerIdOf(node: unknown): string | null {
    if (typeof node === 'string') return node;
    if (typeof node === 'object' && node !== null && 'kind' in node) {
      const typed = node as ModelNode;
      return typed.kind === 'provider' ? typed.id : typed.candidate.model.providerId;
    }
    return null;
  }
}

function sameRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}


function providerItem(node: Extract<ModelNode, { kind: 'provider' }>): TreeItem {
  const item = new TreeItem(node.id, TreeItemCollapsibleState.Expanded);
  item.id = `provider:${node.id}`;
  item.iconPath = new ThemeIcon('server-environment');

  // The wire protocol, not the vendor: the distinction `catalog.ts` makes, and
  // the one that explains why "nvidia" and "openrouter" are both `openai`.
  const config = node.config;
  item.description =
    config === null ? `${node.candidates.length} model(s)` : `${config.kind} · ${node.candidates.length} model(s)`;

  if (config !== null) {
    const tooltip = new MarkdownString();
    // The base URL is configuration, not a secret; keys live in SecretStorage and
    // never reach this view. Untrusted values are not treated as markdown.
    tooltip.appendMarkdown(`**${escapeMarkdown(node.id)}**\n\n`);
    tooltip.appendMarkdown(`Protocol: \`${escapeMarkdown(config.kind)}\`\n\n`);
    tooltip.appendMarkdown(`Endpoint: \`${escapeMarkdown(config.baseUrl)}\`\n\n`);
    tooltip.appendMarkdown(`Auth: \`${escapeMarkdown(config.auth ?? 'bearer')}\``);
    item.tooltip = tooltip;
  }

  item.contextValue = 'coderelay.provider';
  return item;
}

/**
 * One model row.
 *
 * The description answers "can this run now?" and the tooltip answers "what can
 * it do?". Splitting them that way keeps the list scannable while the declared
 * capabilities — which are long, and which the user wrote — stay one hover away.
 */
function modelItem(node: Extract<ModelNode, { kind: 'model' }>): TreeItem {
  const { candidate, selected } = node;
  const caps = candidate.capabilities;

  const item = new TreeItem(candidate.model.modelId, TreeItemCollapsibleState.None);
  item.id = `model:${candidate.model.providerId}/${candidate.model.modelId}`;

  const availability = describeAvailability(candidate);
  item.description = selected ? `${availability.text} · in use` : availability.text;

  // Icon says available/unavailable; the description says which and why. Never
  // colour alone, and the accessible label repeats it for a screen reader.
  item.iconPath = selected
    ? new ThemeIcon('circle-filled', new ThemeColor('charts.blue'))
    : new ThemeIcon(availability.icon, availability.colour === null ? undefined : new ThemeColor(availability.colour));
  item.accessibilityInformation = {
    label: `${candidate.model.providerId} ${candidate.model.modelId}, ${availability.text}${
      selected ? ', currently in use' : ''
    }`,
  };

  const tooltip = new MarkdownString();
  tooltip.appendMarkdown(`**${escapeMarkdown(candidate.model.modelId)}**\n\n`);
  tooltip.appendMarkdown(`${escapeMarkdown(availability.detail)}\n\n`);
  tooltip.appendMarkdown('| Declared capability | Value |\n| --- | --- |\n');
  tooltip.appendMarkdown(`| Context window | ${caps.contextWindow.toLocaleString('en-US')} |\n`);
  tooltip.appendMarkdown(`| Max output | ${caps.maxOutput.toLocaleString('en-US')} |\n`);
  tooltip.appendMarkdown(`| Tool calling | ${caps.toolCalling ? 'yes' : 'no'} |\n`);
  tooltip.appendMarkdown(`| Parallel tool calls | ${caps.parallelToolCalls ? 'yes' : 'no'} |\n`);
  tooltip.appendMarkdown(`| Vision | ${caps.vision ? 'yes' : 'no'} |\n`);
  tooltip.appendMarkdown(`| Reasoning | ${caps.reasoning} |\n`);
  if (caps.costPerMTokIn > 0 || caps.costPerMTokOut > 0) {
    tooltip.appendMarkdown(
      `| Cost / Mtok | $${caps.costPerMTokIn} in · $${caps.costPerMTokOut} out |\n`,
    );
  }
  tooltip.appendMarkdown('\nCapabilities are what you declared in settings, not what CodeRelay guessed.');
  item.tooltip = tooltip;

  item.contextValue = 'coderelay.model';
  item.command = {
    command: 'coderelay.selectModel',
    title: 'Select Model',
    arguments: [candidate.model],
  };
  return item;
}

/**
 * Whether a model can be used right now, and why not if it cannot.
 *
 * The three cases are genuinely different problems: add a key, wait, or nothing.
 * Collapsing them into "unavailable" would leave the user with no next action.
 */
function describeAvailability(candidate: Candidate): {
  text: string;
  detail: string;
  icon: string;
  colour: string | null;
} {
  const ready = candidate.readyCredentialIds.length;
  if (ready > 0) {
    return {
      text: ready === 1 ? '1 key ready' : `${ready} keys ready`,
      detail: 'Ready to use.',
      icon: 'pass',
      colour: 'testing.iconPassed',
    };
  }
  if (candidate.coolingRetryAfterMs !== null) {
    const seconds = Math.ceil(candidate.coolingRetryAfterMs / 1_000);
    return {
      text: `cooling ${seconds}s`,
      detail:
        `Every key for this provider is rate limited or cooling down. It becomes usable ` +
        `again in about ${seconds} seconds; CodeRelay will pick it up without a restart.`,
      icon: 'watch',
      colour: 'notificationsWarningIcon.foreground',
    };
  }
  return {
    text: 'no credential',
    detail:
      'No usable key is stored for this provider. Run "CodeRelay: Add API Key" — it goes ' +
      'straight into the OS keychain and is never written to settings.',
    icon: 'circle-slash',
    colour: 'notificationsErrorIcon.foreground',
  };
}

/**
 * Escapes markdown control characters.
 *
 * A model id and a base URL both come from user settings rather than from this
 * extension, so neither is trusted to be inert inside a `MarkdownString`. An
 * underscore in a model name would otherwise silently italicise half a tooltip.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (match) => `\\${match}`);
}
