import assert from "node:assert/strict";
import { test } from "node:test";

import {
  androidChromeIntentUrl,
  embeddedBrowserName,
  isIosDevice,
  isStandaloneDisplay,
  requiresExternalBrowser,
  requiresIosHomeScreen,
} from "../src/platform.js";

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

test("known social in-app browsers and generic Android WebViews require an external browser", () => {
  const embeddedAgents = [
    ["Mozilla/5.0 (Linux; Android 15) [FB_IAB/FB4A;FBAV/500.0]", "Messenger or Facebook"],
    ["Mozilla/5.0 (iPhone) Instagram 350.0.0", "Instagram"],
    ["Mozilla/5.0 (Linux; Android 15) BytedanceWebview TikTok", "TikTok"],
    ["Mozilla/5.0 (iPhone) LinkedInApp", "LinkedIn"],
    ["Mozilla/5.0 (Linux; Android 15) Line/14.0", "LINE"],
    ["Mozilla/5.0 (iPhone) Snapchat", "Snapchat"],
    ["Mozilla/5.0 (Linux; Android 15; Device Build/X; wv) Version/4.0 Chrome/130.0 Mobile Safari/537.36", "this app"],
  ];

  for (const [userAgent, expectedName] of embeddedAgents) {
    const navigatorLike = { userAgent };
    assert.equal(embeddedBrowserName(navigatorLike), expectedName);
    assert.equal(requiresExternalBrowser(navigatorLike, () => ({ matches: false })), true);
  }
});

test("normal browsers and installed apps are not blocked as embedded browsers", () => {
  const chrome = { userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36" };
  const safari = { userAgent: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" };
  const standaloneMessenger = {
    userAgent: "Mozilla/5.0 (Linux; Android 15) [FB_IAB/FB4A;FBAV/500.0]",
  };
  const standaloneDisplay = (query) => ({ matches: query === "(display-mode: standalone)" });

  assert.equal(embeddedBrowserName(chrome), null);
  assert.equal(embeddedBrowserName(safari), null);
  assert.equal(requiresExternalBrowser(chrome, () => ({ matches: false })), false);
  assert.equal(requiresExternalBrowser(safari, () => ({ matches: false })), false);
  assert.equal(requiresExternalBrowser(standaloneMessenger, standaloneDisplay), false);
});

test("Chrome intent uses only the supplied public HTTP URL and removes fragments", () => {
  assert.equal(
    androidChromeIntentUrl("https://abiemann.github.io/RobinhoodEquityTradingDashboardViewer/#private-key"),
    "intent://abiemann.github.io/RobinhoodEquityTradingDashboardViewer/#Intent;scheme=https;package=com.android.chrome;end",
  );
  assert.throws(() => androidChromeIntentUrl("javascript:alert(1)"), /HTTP or HTTPS/);
});
