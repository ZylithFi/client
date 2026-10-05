const RELOAD_MARKER = "zylith.client-bundle-reload";
const RELOAD_WINDOW_MS = 60_000;

type ReloadStorage = Pick<Storage, "getItem" | "setItem">;

export function isStaleClientBundleError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|module script failed to load/i.test(message);
}

export function reloadStaleClientBundle(
  storage: ReloadStorage,
  reload: () => void,
  now = Date.now(),
): boolean {
  let previous = 0;
  try {
    const stored = storage.getItem(RELOAD_MARKER);
    previous = stored && /^\d+$/.test(stored) ? Number(stored) : 0;
  } catch {
    return false;
  }
  if (Number.isSafeInteger(previous) && previous > 0 && now - previous < RELOAD_WINDOW_MS) {
    return false;
  }
  try {
    storage.setItem(RELOAD_MARKER, String(now));
    reload();
    return true;
  } catch {
    return false;
  }
}
