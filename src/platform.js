export function isIosDevice(navigatorLike = globalThis.navigator) {
  const userAgent = String(navigatorLike?.userAgent || "");
  const platform = String(navigatorLike?.platform || "");
  return /iPad|iPhone|iPod/.test(userAgent) ||
    (platform === "MacIntel" && Number(navigatorLike?.maxTouchPoints || 0) > 1);
}

export function isStandaloneDisplay(
  navigatorLike = globalThis.navigator,
  matchMediaLike = globalThis.matchMedia,
) {
  if (navigatorLike?.standalone === true) return true;
  try {
    return typeof matchMediaLike === "function" &&
      matchMediaLike("(display-mode: standalone)").matches === true;
  } catch {
    return false;
  }
}

export function requiresIosHomeScreen(
  navigatorLike = globalThis.navigator,
  matchMediaLike = globalThis.matchMedia,
) {
  return isIosDevice(navigatorLike) && !isStandaloneDisplay(navigatorLike, matchMediaLike);
}

export function isAndroidDevice(navigatorLike = globalThis.navigator) {
  return /Android/i.test(String(navigatorLike?.userAgent || ""));
}

export function embeddedBrowserName(navigatorLike = globalThis.navigator) {
  const userAgent = String(navigatorLike?.userAgent || "");
  const signatures = [
    [/Messenger|FBAN|FBAV|FB_IAB|FBIOS/i, "Messenger or Facebook"],
    [/Instagram/i, "Instagram"],
    [/TikTok|BytedanceWebview/i, "TikTok"],
    [/LinkedInApp/i, "LinkedIn"],
    [/Line\//i, "LINE"],
    [/Snapchat/i, "Snapchat"],
    [/Pinterest/i, "Pinterest"],
    [/\bGSA\//i, "the Google app"],
  ];

  for (const [pattern, name] of signatures) {
    if (pattern.test(userAgent)) return name;
  }
  if (isAndroidDevice(navigatorLike) &&
      (/;\s*wv\)/i.test(userAgent) || /\bVersion\/4\.0\b.*\bChrome\//i.test(userAgent))) {
    return "this app";
  }
  return null;
}

export function requiresExternalBrowser(
  navigatorLike = globalThis.navigator,
  matchMediaLike = globalThis.matchMedia,
) {
  return !isStandaloneDisplay(navigatorLike, matchMediaLike) &&
    embeddedBrowserName(navigatorLike) !== null;
}

export function androidChromeIntentUrl(publicUrl) {
  const target = new URL(publicUrl);
  if (!/^https?:$/.test(target.protocol)) {
    throw new TypeError("The external-browser target must use HTTP or HTTPS.");
  }
  target.hash = "";
  const scheme = target.protocol.slice(0, -1);
  return `intent://${target.host}${target.pathname}${target.search}` +
    `#Intent;scheme=${scheme};package=com.android.chrome;end`;
}
