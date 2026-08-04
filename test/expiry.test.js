import assert from "node:assert/strict";
import { test } from "node:test";

import { ExpiryController } from "../src/expiry.js";

class FakeClock {
  constructor(now = 0) {
    this.time = now;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimer = (callback, delay) => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, delay, due: this.time + delay });
    return id;
  };

  clearTimer = (id) => {
    this.timers.delete(id);
  };

  onlyTimer() {
    assert.equal(this.timers.size, 1);
    return [...this.timers.entries()][0];
  }

  async fire(id, { advance = false } = {}) {
    const timer = this.timers.get(id);
    assert.ok(timer, `timer ${id} must exist`);
    this.timers.delete(id);
    if (advance) this.time = Math.max(this.time, timer.due);
    return timer.callback();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function controller(clock, onExpire) {
  return new ExpiryController({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire,
  });
}

test("schedule arms the deadline and an early timer firing reschedules the remainder", async () => {
  const clock = new FakeClock(1_000);
  const actions = [];
  const expiry = controller(clock, async ({ commit, expiresAtMs }) => {
    commit(() => actions.push(expiresAtMs));
  });

  assert.equal(await expiry.schedule(1_500), false);
  assert.equal(expiry.active, true);
  assert.equal(expiry.expiresAtMs, 1_500);
  const [firstId, first] = clock.onlyTimer();
  assert.equal(first.delay, 500);

  clock.time = 1_200;
  assert.equal(await clock.fire(firstId), false);
  const [secondId, second] = clock.onlyTimer();
  assert.equal(second.delay, 300);
  assert.deepEqual(actions, []);

  clock.time = 1_500;
  assert.equal(await clock.fire(secondId), true);
  assert.deepEqual(actions, [1_500]);
  assert.equal(expiry.active, false);
  assert.equal(clock.timers.size, 0);
});

test("wake expires an overdue deadline even when the queued timer never fired", async () => {
  const clock = new FakeClock(10);
  let calls = 0;
  const expiry = controller(clock, async ({ commit }) => {
    commit(() => { calls += 1; });
  });

  await expiry.schedule(20);
  assert.equal(clock.timers.size, 1);
  clock.time = 25;
  assert.equal(await expiry.wake(), true);
  assert.equal(calls, 1);
  assert.equal(expiry.active, false);
  assert.equal(clock.timers.size, 0);
});

test("invalidate and cancel make already-queued timer callbacks harmless", async () => {
  const clock = new FakeClock(0);
  let calls = 0;
  const expiry = controller(clock, async ({ commit }) => {
    calls += 1;
    commit(() => { calls += 100; });
  });

  await expiry.schedule(100);
  const [, first] = clock.onlyTimer();
  expiry.invalidate();
  assert.equal(expiry.active, false);
  clock.time = 100;
  assert.equal(await first.callback(), false);

  await expiry.schedule(200);
  const [, second] = clock.onlyTimer();
  expiry.cancel();
  clock.time = 200;
  assert.equal(await second.callback(), false);
  assert.equal(calls, 0);
});

test("pending expiration A cannot commit after replacement deadline B is scheduled", async () => {
  const clock = new FakeClock(100);
  const aStarted = deferred();
  const releaseA = deferred();
  const actions = [];
  const expiry = controller(clock, async ({ commit, expiresAtMs, isCurrent }) => {
    if (expiresAtMs === 100) {
      aStarted.resolve();
      await releaseA.promise;
      assert.equal(isCurrent(), false);
      assert.equal(commit(() => actions.push("A")), false);
      return;
    }
    assert.equal(isCurrent(), true);
    assert.equal(commit(() => actions.push("B")), true);
  });

  const pendingA = expiry.schedule(100);
  await aStarted.promise;
  clock.time = 110;
  assert.equal(await expiry.schedule(200), false);
  releaseA.resolve();
  assert.equal(await pendingA, false);
  assert.deepEqual(actions, []);
  assert.equal(expiry.expiresAtMs, 200);

  clock.time = 200;
  assert.equal(await expiry.wake(), true);
  assert.deepEqual(actions, ["B"]);
  assert.equal(expiry.active, false);
});

test("duplicate wakes share one in-flight expiration callback", async () => {
  const clock = new FakeClock(50);
  const release = deferred();
  let calls = 0;
  const expiry = controller(clock, async ({ commit }) => {
    calls += 1;
    await release.promise;
    commit(() => {});
  });

  const first = expiry.schedule(50);
  const second = expiry.wake();
  assert.equal(first, second);
  assert.equal(calls, 1);
  release.resolve();
  assert.equal(await first, true);
  assert.equal(calls, 1);
});

test("a callback that awaits can observe invalidation and cannot commit afterward", async () => {
  const clock = new FakeClock(0);
  const started = deferred();
  const release = deferred();
  let acted = false;
  const expiry = controller(clock, async ({ commit, isCurrent }) => {
    started.resolve();
    await release.promise;
    assert.equal(isCurrent(), false);
    assert.equal(commit(() => { acted = true; }), false);
  });

  const pending = expiry.schedule(0);
  await started.promise;
  expiry.invalidate();
  release.resolve();
  assert.equal(await pending, false);
  assert.equal(acted, false);
});

test("commit refuses asynchronous UI actions", async () => {
  const clock = new FakeClock(0);
  let called = false;
  const expiry = controller(clock, async ({ commit }) => {
    commit(async () => { called = true; });
  });

  await assert.rejects(
    () => expiry.schedule(0),
    /must be synchronous/,
  );
  assert.equal(called, false);
  expiry.cancel();
});

test("invalid deadlines and clock values fail explicitly", async () => {
  const clock = new FakeClock(0);
  const expiry = controller(clock, async () => {});
  assert.throws(() => expiry.schedule(Number.NaN), /finite epoch timestamp/);

  clock.time = Number.NaN;
  await assert.rejects(() => expiry.schedule(1), /now\(\) must return a finite/);
  expiry.cancel();
});
