/**
 * Task Execution Lock & Concurrency Guards.
 *
 * Prevents race conditions such as duplicate tool execution, simultaneous model switches,
 * or concurrent checkpoint creations on the same task ledger.
 */

export class TaskExecutionLock {
  private readonly activeLocks = new Set<string>();

  acquire(taskId: string): boolean {
    if (this.activeLocks.has(taskId)) {
      return false;
    }
    this.activeLocks.add(taskId);
    return true;
  }

  release(taskId: string): void {
    this.activeLocks.delete(taskId);
  }

  isLocked(taskId: string): boolean {
    return this.activeLocks.has(taskId);
  }

  async withLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    if (!this.acquire(taskId)) {
      throw new Error(`Task ${taskId} is currently locked by another operation.`);
    }
    try {
      return await action();
    } finally {
      this.release(taskId);
    }
  }
}
