/**
 * Notification Center for CodeRelay.
 *
 * Tracks real operational events:
 * - Task completed / failed
 * - Model switched / relay triggered
 * - Provider unavailable / rate limited
 * - Checkpoint created
 * - Verification failed
 * - Approval required
 * Provides single-click navigation to related task/state.
 */

export type NotificationKind =
  | 'task_completed'
  | 'task_failed'
  | 'model_switched'
  | 'provider_unavailable'
  | 'relay_required'
  | 'checkpoint_created'
  /**
   * A checkpoint was restored, which is a different event from one being taken.
   * Conflating the two would report a rollback as routine progress.
   */
  | 'checkpoint_restored'
  | 'verification_failed'
  | 'approval_required'
  | 'model_diagnostic';

export interface NotificationEvent {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly message: string;
  readonly timestamp: string;
  readonly taskId?: string;
  readonly read: boolean;
}

export class NotificationCenter {
  private events: NotificationEvent[] = [];

  add(event: Omit<NotificationEvent, 'id' | 'timestamp' | 'read'>): NotificationEvent {
    const full: NotificationEvent = {
      ...event,
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      read: false,
    };
    this.events.unshift(full);
    if (this.events.length > 50) {
      this.events = this.events.slice(0, 50);
    }
    return full;
  }

  list(): readonly NotificationEvent[] {
    return this.events;
  }

  unreadCount(): number {
    return this.events.filter((e) => !e.read).length;
  }

  markAllRead(): void {
    this.events = this.events.map((e) => ({ ...e, read: true }));
  }

  dismiss(id: string): void {
    this.events = this.events.filter((e) => e.id !== id);
  }

  clear(): void {
    this.events = [];
  }
}
