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
