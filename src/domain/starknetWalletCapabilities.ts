type WalletCapabilityProvider = {
  request?: (request: { type: string; params: unknown }) => Promise<unknown>;
};

const MINIMUM_STRK20_WALLET_API = [0, 10, 3] as const;
const CAPABILITY_TIMEOUT_MS = 10_000;
const walletApiVersions = new WeakMap<object, Promise<string>>();

export async function requirePrivateStrk20Support(
  provider: WalletCapabilityProvider,
): Promise<string> {
  if (!provider || typeof provider !== "object" || typeof provider.request !== "function") {
    throw new Error("The selected wallet does not support private STRK20 actions.");
  }
  const cached = walletApiVersions.get(provider);
  if (cached) return cached;
  const pending = withTimeout(
    Promise.resolve().then(() =>
      provider.request!({ type: "wallet_supportedWalletApi", params: undefined })),
  )
    .then(selectPrivateWalletApiVersion)
    .catch((error) => {
      walletApiVersions.delete(provider);
      throw error;
    });
  walletApiVersions.set(provider, pending);
  return pending;
}

function selectPrivateWalletApiVersion(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new Error("The wallet returned malformed capability information.");
  }
  const compatible = value
    .filter((version): version is string => typeof version === "string")
    .map((version) => ({ version, parsed: parseWalletApiVersion(version) }))
    .filter((entry): entry is { version: string; parsed: [number, number, number] } =>
      entry.parsed !== null && compareVersion(entry.parsed, MINIMUM_STRK20_WALLET_API) >= 0)
    .sort((left, right) => compareVersion(right.parsed, left.parsed));
  if (!compatible[0]) {
    throw new Error("The selected wallet does not support private STRK20 actions.");
  }
  return compatible[0].version;
}

function parseWalletApiVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] as [number, number, number];
  return parsed.every(Number.isSafeInteger) ? parsed : null;
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
) {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

async function withTimeout<T>(request: Promise<T>) {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error("The wallet timed out while checking private STRK20 support.")),
      CAPABILITY_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}
