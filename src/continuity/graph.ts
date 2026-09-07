/**
 * Persistent Task State Graph (DAG) for CodeRelay.
 *
 * Models are replaceable workers. The task is the durable source of truth.
 *
 * Instead of treating chat transcripts or provider-specific conversation turns
 * as state, CodeRelay tracks an explicit, model-independent graph of:
 *  - Goals
 *  - Requirements (with concrete evidence links)
 *  - Steps & Dependencies
 *  - Side-effect Tool Actions (with idempotency hashes)
 *  - Verified Checkpoints (Code + Task + Verify + Recovery State)
 *  - Verifications (Test runs, build outputs, diagnostics)
 *  - Failure & Recovery Events
 */

import type { ErrorClass, ModelRef } from '../core/types.js';

export type TaskStatus =
  | 'draft'
  | 'planning'
  | 'queued'
  | 'executing'
  | 'toolRunning'
  | 'awaitingApproval'
  | 'checkpointing'
  | 'verifying'
  | 'recovering'
  | 'relaying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type RequirementNodeStatus = 'open' | 'touched' | 'evidenced' | 'failing';
export type StepNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ActionNodeStatus = 'started' | 'succeeded' | 'failed' | 'skipped_duplicate';

export type EdgeType =
  | 'DEPENDS_ON'
  | 'IMPLEMENTS'
  | 'VERIFIED_BY'
  | 'CHECKPOINTED_AT'
  | 'RELAYED_TO'
  | 'CAUSED_BY';

export interface BaseNode {
  readonly id: string;
  readonly createdAt: number;
}

export interface GoalNode extends BaseNode {
  readonly kind: 'goal';
  readonly objective: string;
  readonly contextNotes?: string;
}

export interface RequirementNode extends BaseNode {
  readonly kind: 'requirement';
  readonly requirementId: string;
  readonly text: string;
  readonly mentions: readonly string[];
  status: RequirementNodeStatus;
  evidenceRefs: readonly string[];
}

export interface StepNode extends BaseNode {
  readonly kind: 'step';
  readonly stepNumber: number;
  readonly title: string;
  readonly description?: string;
  status: StepNodeStatus;
  assignedWorker?: ModelRef;
}

export interface ToolActionNode extends BaseNode {
  readonly kind: 'tool_action';
  readonly actionId: string;
  readonly stepId?: string;
  readonly toolName: string;
  readonly inputHash: string;
  readonly resultHash?: string;
  status: ActionNodeStatus;
  readonly paths: readonly string[];
  workspaceEvidence?: string;
}

export interface CheckpointNode extends BaseNode {
  readonly kind: 'checkpoint';
  readonly checkpointId: string;
  readonly sequenceNumber: number;
  readonly gitCommitSha?: string;
  readonly stateHash: string;
  readonly verified: boolean;
  readonly reason: string;
  readonly filesChanged: readonly string[];
  readonly workerModel?: ModelRef;
}

export interface VerificationNode extends BaseNode {
  readonly kind: 'verification';
  readonly passed: boolean;
  readonly exitCode: number;
  readonly checksCount: number;
  readonly passedCount: number;
  readonly failureCount: number;
  readonly diagnosticsCount: number;
  readonly summary: string;
}

export interface FailureEventNode extends BaseNode {
  readonly kind: 'failure_event';
  readonly failureClass: string;
  readonly worker: ModelRef;
  readonly errorText: string;
  readonly inFlightTool?: string;
}

export interface RecoveryEventNode extends BaseNode {
  readonly kind: 'recovery_event';
  readonly failureNodeId: string;
  readonly actionTaken: string;
  readonly fromWorker?: ModelRef;
  readonly toWorker?: ModelRef;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'BLOCKED';
  readonly reason: string;
}

export type TaskNode =
  | GoalNode
  | RequirementNode
  | StepNode
  | ToolActionNode
  | CheckpointNode
  | VerificationNode
  | FailureEventNode
  | RecoveryEventNode;

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly type: EdgeType;
}

export interface SerializedTaskGraph {
  readonly schemaVersion: number;
  readonly taskId: string;
  readonly taskStatus: TaskStatus;
  readonly currentStep: string | null;
  readonly currentWorker: ModelRef | null;
  readonly nodes: readonly TaskNode[];
  readonly edges: readonly GraphEdge[];
  readonly relevantFiles: readonly string[];
  readonly fileHashes: Readonly<Record<string, string>>;
}

export class TaskStateGraph {
  private readonly nodes = new Map<string, TaskNode>();
  private readonly edges: GraphEdge[] = [];
  private taskStatus: TaskStatus = 'draft';
  private currentStep: string | null = null;
  private currentWorker: ModelRef | null = null;
  private relevantFiles = new Set<string>();
  private fileHashes = new Map<string, string>();

  constructor(public readonly taskId: string) {}

  getStatus(): TaskStatus {
    return this.taskStatus;
  }

  setStatus(status: TaskStatus): void {
    this.taskStatus = status;
  }

  getCurrentStep(): string | null {
    return this.currentStep;
  }

  setCurrentStep(stepId: string | null): void {
    this.currentStep = stepId;
  }

  getCurrentWorker(): ModelRef | null {
    return this.currentWorker;
  }

  setCurrentWorker(worker: ModelRef | null): void {
    this.currentWorker = worker;
  }

  addNode(node: TaskNode): void {
    this.nodes.set(node.id, node);
  }

  getNode<T extends TaskNode = TaskNode>(id: string): T | undefined {
    return this.nodes.get(id) as T | undefined;
  }

  getAllNodes(): readonly TaskNode[] {
    return Array.from(this.nodes.values());
  }

  addEdge(from: string, to: string, type: EdgeType): void {
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      return;
    }
    const exists = this.edges.some((e) => e.from === from && e.to === to && e.type === type);
    if (!exists) {
      this.edges.push({ from, to, type });
    }
  }

  getEdges(): readonly GraphEdge[] {
    return this.edges;
  }

  trackFile(path: string, hash?: string): void {
    this.relevantFiles.add(path);
    if (hash) {
      this.fileHashes.set(path, hash);
    }
  }

  getRelevantFiles(): readonly string[] {
    return Array.from(this.relevantFiles);
  }

  getFileHashes(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.fileHashes.entries());
  }

  // --- Specialized Graph Queries ---

  getGoal(): GoalNode | undefined {
    for (const node of this.nodes.values()) {
      if (node.kind === 'goal') return node;
    }
    return undefined;
  }

  getRequirements(): readonly RequirementNode[] {
    const list: RequirementNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === 'requirement') list.push(node);
    }
    return list;
  }

  getSteps(): readonly StepNode[] {
    const list: StepNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === 'step') list.push(node);
    }
    return list.sort((a, b) => a.stepNumber - b.stepNumber);
  }

  getRemainingSteps(): readonly StepNode[] {
    return this.getSteps().filter((s) => s.status === 'pending' || s.status === 'running');
  }

  getCompletedSteps(): readonly StepNode[] {
    return this.getSteps().filter((s) => s.status === 'completed');
  }

  getToolActions(): readonly ToolActionNode[] {
    const list: ToolActionNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === 'tool_action') list.push(node);
    }
    return list;
  }

  getCheckpoints(): readonly CheckpointNode[] {
    const list: CheckpointNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === 'checkpoint') list.push(node);
    }
    return list.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  getLatestCheckpoint(): CheckpointNode | undefined {
    const list = this.getCheckpoints();
    return list[list.length - 1];
  }

  getLatestVerifiedCheckpoint(): CheckpointNode | undefined {
    const list = this.getCheckpoints().filter((c) => c.verified);
    return list[list.length - 1];
  }

  getVerifications(): readonly VerificationNode[] {
    const list: VerificationNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === 'verification') list.push(node);
    }
    return list;
  }

  getFailures(): readonly FailureEventNode[] {
    const list: FailureEventNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === 'failure_event') list.push(node);
    }
    return list;
  }

  getRecoveries(): readonly RecoveryEventNode[] {
    const list: RecoveryEventNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === 'recovery_event') list.push(node);
    }
    return list;
  }

  /**
   * Has a side-effect tool action with matching inputHash already succeeded?
   */
  hasCompletedAction(toolName: string, inputHash: string): ToolActionNode | undefined {
    for (const node of this.nodes.values()) {
      if (
        node.kind === 'tool_action' &&
        node.toolName === toolName &&
        node.inputHash === inputHash &&
        node.status === 'succeeded'
      ) {
        return node;
      }
    }
    return undefined;
  }

  getLatestVerification(): VerificationNode | undefined {
    const list = this.getVerifications();
    return list[list.length - 1];
  }

  getCompletedActions(): readonly ToolActionNode[] {
    const list: ToolActionNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind === 'tool_action') {
        list.push(node);
      }
    }
    return list;
  }

  recordFailure(options: {
    failureClass: string;
    worker: ModelRef;
    errorText: string;
    inFlightTool?: string;
  }): FailureEventNode {
    const node: FailureEventNode = {
      id: `fail_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      kind: 'failure_event',
      failureClass: options.failureClass,
      worker: options.worker,
      errorText: options.errorText,
      inFlightTool: options.inFlightTool
    };
    this.addNode(node);
    return node;
  }

  recordRecovery(options: {
    failureNodeId: string;
    actionTaken: string;
    fromWorker?: ModelRef;
    toWorker?: ModelRef;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'BLOCKED';
    reason: string;
  }): RecoveryEventNode {
    const node: RecoveryEventNode = {
      id: `recov_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      kind: 'recovery_event',
      failureNodeId: options.failureNodeId,
      actionTaken: options.actionTaken,
      fromWorker: options.fromWorker,
      toWorker: options.toWorker,
      confidence: options.confidence,
      reason: options.reason
    };
    this.addNode(node);
    this.addEdge(node.id, options.failureNodeId, 'CAUSED_BY');
    return node;
  }

  recordVerification(options: {
    passed: boolean;
    exitCode: number;
    checksCount: number;
    passedCount: number;
    failureCount: number;
    diagnosticsCount: number;
    summary: string;
  }): VerificationNode {
    const node: VerificationNode = {
      id: `verify_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      kind: 'verification',
      passed: options.passed,
      exitCode: options.exitCode,
      checksCount: options.checksCount,
      passedCount: options.passedCount,
      failureCount: options.failureCount,
      diagnosticsCount: options.diagnosticsCount,
      summary: options.summary
    };
    this.addNode(node);
    return node;
  }

  setTaskStatus(status: TaskStatus): void {
    this.setStatus(status);
  }

  getTaskStatus(): TaskStatus {
    return this.getStatus();
  }

  /**
   * Serializes the graph to JSON without secrets or sensitive credentials.
   */
  toJSON(): SerializedTaskGraph {
    return this.serialize();
  }

  /**
   * Serializes the graph to JSON without secrets or sensitive credentials.
   */
  serialize(): SerializedTaskGraph {
    return {
      schemaVersion: 3,
      taskId: this.taskId,
      taskStatus: this.taskStatus,
      currentStep: this.currentStep,
      currentWorker: this.currentWorker,
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
      relevantFiles: Array.from(this.relevantFiles),
      fileHashes: Object.fromEntries(this.fileHashes.entries()),
    };
  }

  /**
   * Restores a task graph from serialized payload.
   */
  static deserialize(data: SerializedTaskGraph): TaskStateGraph {
    const graph = new TaskStateGraph(data.taskId);
    graph.setStatus(data.taskStatus);
    graph.setCurrentStep(data.currentStep);
    graph.setCurrentWorker(data.currentWorker);

    for (const node of data.nodes || []) {
      graph.addNode(node);
    }
    for (const edge of data.edges || []) {
      graph.addEdge(edge.from, edge.to, edge.type);
    }
    for (const file of data.relevantFiles || []) {
      graph.trackFile(file);
    }
    if (data.fileHashes) {
      for (const [f, h] of Object.entries(data.fileHashes)) {
        graph.trackFile(f, h);
      }
    }
    return graph;
  }
}
