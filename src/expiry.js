const MAX_TIMER_DELAY_MS = 2_147_483_647;

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
  return value;
}

/**
 * Owns one expiring snapshot deadline at a time.
 *
 * `onExpire` may await a conditional storage clear. It must perform any
 * synchronous UI mutation through the supplied `commit` guard:
 *
 *   onExpire: async ({ isCurrent, commit }) => {
 *     const cleared = await clearOnlyTheExpectedCachedEnvelope();
 *     if (cleared && isCurrent()) commit(() => clearExpiredDashboard());
 *   }
 *
 * Scheduling or invalidating while that callback is pending changes the
 * epoch, causing the stale commit to return false without invoking its action.
 */
export class ExpiryController {
  constructor({
    now = () => Date.now(),
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (id) => globalThis.clearTimeout(id),
    onExpire,
  } = {}) {
    this.now = requireFunction(now, "now");
    this.setTimer = requireFunction(setTimer, "setTimer");
    this.clearTimer = requireFunction(clearTimer, "clearTimer");
    this.onExpire = requireFunction(onExpire, "onExpire");
    this.epoch = 0;
    this.deadline = null;
    this.timer = null;
    this.inFlight = new Map();
  }

  get active() {
    return this.deadline !== null;
  }

  get expiresAtMs() {
    return this.deadline?.expiresAtMs ?? null;
  }

  schedule(expiresAtMs) {
    if (!Number.isFinite(expiresAtMs)) {
      throw new TypeError("expiresAtMs must be a finite epoch timestamp.");
    }
    this._clearTimer();
    this.epoch += 1;
    const state = Object.freeze({ epoch: this.epoch, expiresAtMs });
    this.deadline = state;
    return this._check(state.epoch);
  }

  /** Rechecks the deadline after visibility/pageshow or another wake event. */
  wake() {
    if (!this.deadline) return Promise.resolve(false);
    return this._check(this.deadline.epoch);
  }

  invalidate() {
    this._clearTimer();
    this.epoch += 1;
    this.deadline = null;
    return this.epoch;
  }

  cancel() {
    return this.invalidate();
  }

  _isCurrent(state) {
    return this.deadline !== null && this.epoch === state.epoch &&
      this.deadline.epoch === state.epoch && this.deadline.expiresAtMs === state.expiresAtMs;
  }

  _clearTimer() {
    if (!this.timer) return;
    this.clearTimer(this.timer.id);
    this.timer = null;
  }

  _arm(state, remainingMs) {
    if (!this._isCurrent(state)) return false;
    this._clearTimer();
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.ceil(remainingMs)));
    const epoch = state.epoch;
    const id = this.setTimer(() => {
      if (this.timer?.epoch === epoch) this.timer = null;
      const pending = this._check(epoch);
      // Native timer dispatch cannot observe the returned promise. Attach a
      // rejection handler to avoid an unhandled rejection while still
      // returning it for deterministic injected timer harnesses.
      pending.catch(() => {});
      return pending;
    }, delay);
    this.timer = { epoch, id };
    return true;
  }

  _check(epoch) {
    const state = this.deadline;
    if (!state || state.epoch !== epoch || !this._isCurrent(state)) return Promise.resolve(false);

    const currentTime = Number(this.now());
    if (!Number.isFinite(currentTime)) {
      return Promise.reject(new TypeError("now() must return a finite epoch timestamp."));
    }
    const remainingMs = state.expiresAtMs - currentTime;
    if (remainingMs > 0) {
      this._arm(state, remainingMs);
      return Promise.resolve(false);
    }
    return this._expire(state);
  }

  _expire(state) {
    if (!this._isCurrent(state)) return Promise.resolve(false);
    if (this.inFlight.has(state.epoch)) return this.inFlight.get(state.epoch);
    this._clearTimer();

    const promise = this._runExpiration(state);
    this.inFlight.set(state.epoch, promise);
    promise.then(
      () => {
        if (this.inFlight.get(state.epoch) === promise) this.inFlight.delete(state.epoch);
      },
      () => {
        if (this.inFlight.get(state.epoch) === promise) this.inFlight.delete(state.epoch);
      },
    );
    return promise;
  }

  async _runExpiration(state) {
    // The timer may have been queued before a replacement schedule/cancel.
    if (!this._isCurrent(state)) return false;

    let committed = false;
    const isCurrent = () => this._isCurrent(state);
    const commit = (action) => {
      requireFunction(action, "expiration commit action");
      if (committed || !isCurrent()) return false;
      if (action.constructor?.name === "AsyncFunction") {
        throw new TypeError("Expiration commit actions must be synchronous.");
      }
      const result = action();
      if (result && typeof result.then === "function") {
        throw new TypeError("Expiration commit actions must be synchronous.");
      }
      committed = true;
      return true;
    };

    await this.onExpire(Object.freeze({
      commit,
      epoch: state.epoch,
      expiresAtMs: state.expiresAtMs,
      isCurrent,
    }));

    // A newer schedule may have been installed while onExpire awaited its
    // conditional storage transaction. Never retire that newer deadline.
    if (!this._isCurrent(state)) return false;
    this._clearTimer();
    this.deadline = null;
    this.epoch += 1;
    return committed;
  }
}
