export class ForegroundPoller {
  constructor({
    poll,
    intervalMs = 30_000,
    maxBackoffMs = 5 * 60_000,
    jitterRatio = 0.2,
    random = Math.random,
    visibility = globalThis.document,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
  }) {
    this.poll = poll;
    this.intervalMs = intervalMs;
    this.maxBackoffMs = Math.max(intervalMs, maxBackoffMs);
    this.jitterRatio = Math.max(0, Math.min(1, jitterRatio));
    this.random = random;
    this.visibility = visibility;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.active = false;
    this.running = false;
    this.timer = null;
    this.transientFailures = 0;
    this.onVisibilityChange = this.onVisibilityChange.bind(this);
  }

  resetBackoff() {
    this.transientFailures = 0;
  }

  transientDelay(error) {
    this.transientFailures += 1;
    const exponent = Math.min(this.transientFailures - 1, 30);
    const exponential = Math.min(this.maxBackoffMs, this.intervalMs * (2 ** exponent));
    const draw = Number(this.random());
    const normalized = Number.isFinite(draw) ? Math.max(0, Math.min(1, draw)) : 0.5;
    const jittered = Math.round(exponential * (1 + ((normalized * 2) - 1) * this.jitterRatio));
    const retryAfter = Number(error?.retryAfterMs);
    const serverDelay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 0;
    return Math.min(this.maxBackoffMs, Math.max(this.intervalMs, jittered, serverDelay));
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.resetBackoff();
    this.visibility?.addEventListener?.("visibilitychange", this.onVisibilityChange);
    if (!this.visibility?.hidden) void this.runNow();
  }

  stop() {
    this.active = false;
    this.resetBackoff();
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.visibility?.removeEventListener?.("visibilitychange", this.onVisibilityChange);
  }

  onVisibilityChange() {
    if (!this.active) return;
    if (this.visibility?.hidden) {
      if (this.timer !== null) this.clearTimer(this.timer);
      this.timer = null;
      return;
    }
    this.resetBackoff();
    void this.runNow();
  }

  schedule(delayMs = this.intervalMs) {
    if (!this.active || this.visibility?.hidden) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.runNow();
    }, delayMs);
  }

  async runNow() {
    if (!this.active || this.running || this.visibility?.hidden) return;
    this.running = true;
    let delayMs = this.intervalMs;
    try {
      await this.poll();
      this.resetBackoff();
    } catch (error) {
      if (error?.transient === true) {
        delayMs = this.transientDelay(error);
      } else {
        this.resetBackoff();
      }
    } finally {
      this.running = false;
      this.schedule(delayMs);
    }
  }
}
