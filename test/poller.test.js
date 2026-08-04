import assert from "node:assert/strict";
import { test } from "node:test";

import { ForegroundPoller } from "../src/poller.js";

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("polling runs only in the foreground and refreshes on visibility", async () => {
  let listener = null;
  const visibility = {
    hidden: false,
    addEventListener(name, callback) { if (name === "visibilitychange") listener = callback; },
    removeEventListener(name, callback) { if (name === "visibilitychange" && listener === callback) listener = null; },
  };
  let polls = 0;
  let timer = null;
  let nextTimerId = 1;
  const poller = new ForegroundPoller({
    poll: async () => { polls += 1; },
    intervalMs: 30_000,
    visibility,
    setTimer(callback, delay) {
      assert.equal(delay, 30_000);
      timer = { id: nextTimerId += 1, callback };
      return timer.id;
    },
    clearTimer(id) { if (timer?.id === id) timer = null; },
  });

  poller.start();
  await nextTurn();
  assert.equal(polls, 1);
  assert.ok(timer);

  visibility.hidden = true;
  listener();
  assert.equal(timer, null);

  visibility.hidden = false;
  listener();
  await nextTurn();
  assert.equal(polls, 2);
  assert.ok(timer);

  poller.stop();
  assert.equal(timer, null);
  assert.equal(listener, null);
});

test("a hidden app does not poll at startup", async () => {
  const visibility = { hidden: true, addEventListener() {}, removeEventListener() {} };
  let polls = 0;
  const poller = new ForegroundPoller({ poll: async () => { polls += 1; }, visibility });
  poller.start();
  await nextTurn();
  assert.equal(polls, 0);
  poller.stop();
});

function transient(retryAfterMs = null) {
  return Object.assign(new Error("temporary"), { transient: true, retryAfterMs });
}

function timerHarness() {
  let current = null;
  let nextId = 0;
  const delays = [];
  return {
    delays,
    setTimer(callback, delay) {
      current = { id: ++nextId, callback };
      delays.push(delay);
      return current.id;
    },
    clearTimer(id) {
      if (current?.id === id) current = null;
    },
    async fire() {
      assert.ok(current, "expected a scheduled poll");
      const callback = current.callback;
      current = null;
      callback();
      await nextTurn();
    },
    hasTimer() { return current !== null; },
  };
}

test("transient failures back off exponentially and success restores 30-second polling", async () => {
  const outcomes = [transient(), transient(), transient(), null];
  const timers = timerHarness();
  const poller = new ForegroundPoller({
    poll: async () => {
      const outcome = outcomes.shift();
      if (outcome) throw outcome;
    },
    intervalMs: 30_000,
    visibility: { hidden: false, addEventListener() {}, removeEventListener() {} },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => 0.5,
  });

  poller.start();
  await nextTurn();
  await timers.fire();
  await timers.fire();
  await timers.fire();
  assert.deepEqual(timers.delays, [30_000, 60_000, 120_000, 30_000]);
  poller.stop();
});

test("Retry-After is honored within the bounded backoff cap", async () => {
  const outcomes = [transient(90_000), transient(), transient(), transient()];
  const timers = timerHarness();
  const poller = new ForegroundPoller({
    poll: async () => { throw outcomes.shift(); },
    intervalMs: 30_000,
    maxBackoffMs: 120_000,
    visibility: { hidden: false, addEventListener() {}, removeEventListener() {} },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => 0.5,
  });

  poller.start();
  await nextTurn();
  await timers.fire();
  await timers.fire();
  await timers.fire();
  assert.deepEqual(timers.delays, [90_000, 60_000, 120_000, 120_000]);
  poller.stop();
});

test("returning to the foreground resets transient backoff before an immediate refresh", async () => {
  let listener = null;
  const visibility = {
    hidden: false,
    addEventListener(name, callback) { if (name === "visibilitychange") listener = callback; },
    removeEventListener() {},
  };
  const timers = timerHarness();
  const poller = new ForegroundPoller({
    poll: async () => { throw transient(); },
    intervalMs: 30_000,
    visibility,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => 0.5,
  });

  poller.start();
  await nextTurn();
  await timers.fire();
  assert.deepEqual(timers.delays, [30_000, 60_000]);

  visibility.hidden = true;
  listener();
  assert.equal(timers.hasTimer(), false);
  visibility.hidden = false;
  listener();
  await nextTurn();
  assert.deepEqual(timers.delays, [30_000, 60_000, 30_000]);
  poller.stop();
});
