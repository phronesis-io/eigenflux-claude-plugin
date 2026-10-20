const AUTH_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

/** One gate per configured Home/server, shared by every authentication source. */
export class AuthNotificationGate {
  private inFlight = false;
  private lastDeliveredAt: number | null = null;

  reset(): void {
    this.lastDeliveredAt = null;
  }

  async deliver(send: () => Promise<void>): Promise<void> {
    if (this.inFlight || (this.lastDeliveredAt !== null &&
      Date.now() - this.lastDeliveredAt < AUTH_NOTIFICATION_COOLDOWN_MS)) return;
    this.inFlight = true;
    try {
      await send();
      this.lastDeliveredAt = Date.now();
    } finally {
      this.inFlight = false;
    }
  }
}
