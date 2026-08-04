import assert from "node:assert/strict";
import { test } from "node:test";

import { isIosDevice, isStandaloneDisplay, requiresIosHomeScreen } from "../src/platform.js";

test("iPhone and iPad browser sessions must install before pairing", () => {
  const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" };
  const ipadDesktopUa = { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 };
  const browserDisplay = () => ({ matches: false });

  assert.equal(isIosDevice(iphone), true);
  assert.equal(isIosDevice(ipadDesktopUa), true);
  assert.equal(requiresIosHomeScreen(iphone, browserDisplay), true);
  assert.equal(requiresIosHomeScreen(ipadDesktopUa, browserDisplay), true);
});

test("installed iOS and standalone Android sessions may pair", () => {
  const installedIphone = {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    standalone: true,
  };
  const android = { userAgent: "Mozilla/5.0 (Linux; Android 15)" };
  const standaloneDisplay = (query) => ({ matches: query === "(display-mode: standalone)" });

  assert.equal(isStandaloneDisplay(installedIphone, () => ({ matches: false })), true);
  assert.equal(requiresIosHomeScreen(installedIphone, () => ({ matches: false })), false);
  assert.equal(requiresIosHomeScreen(android, standaloneDisplay), false);
});

test("desktop Safari is not mistaken for touch-capable iPadOS", () => {
  const desktopSafari = {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    platform: "MacIntel",
    maxTouchPoints: 0,
  };
  assert.equal(isIosDevice(desktopSafari), false);
  assert.equal(requiresIosHomeScreen(desktopSafari, () => ({ matches: false })), false);
});
