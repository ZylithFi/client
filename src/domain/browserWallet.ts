export type RuntimeStatus = "loading" | "ready" | "error";

export function fmtAddr(s: string): string {
  if (!s || s.length < 10) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function walletRuntime() {
  return window.zylithWallet ?? null;
}

export function walletRuntimeStatus(): RuntimeStatus {
  if (window.zylithWallet) return "ready";
  if (window.zylithWalletLoadError) return "error";
  return "loading";
}

export type StarknetProvider = NonNullable<typeof window.starknet>;

export type StarknetWalletOption = {
  id: string;
  name: string;
  provider: StarknetProvider;
};

type StarknetProviderWithMeta = StarknetProvider & {
  id?: string;
  name?: string;
};

type WindowWithSelectedWallet = Window & {
  zylithSelectedStarknetProvider?: StarknetProvider;
  zylithSelectedStarknetAddress?: string;
};

const SELECTED_STARKNET_WALLET_STORAGE_KEY = "zylith:selected-starknet-wallet";
const CONNECTED_STARKNET_ADDRESS_STORAGE_KEY = "zylith:connected-starknet-address";
const KNOWN_STARKNET_PROVIDER_KEYS = [
  "starknet_braavos",
  "braavosStarknet",
  "braavos",
  "starknet_argentX",
  "argentX",
  "starknet_argent",
  "argent",
  "starknet_ready",
  "readyWallet",
  "ready",
];

type WalletCandidate = {
  key: string;
  value: unknown;
  order: number;
};

function isStarknetProvider(value: unknown): value is StarknetProvider {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StarknetProvider>;
  return typeof candidate.request === "function" || typeof candidate.enable === "function";
}

function providerSearchText(key: string, provider: StarknetProviderWithMeta): string {
  return `${key} ${provider.id ?? ""} ${provider.name ?? ""}`.toLowerCase();
}

function walletNameFor(key: string, provider: StarknetProviderWithMeta): string {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("braavos")) return "Braavos";
  if (normalized.includes("argent")) return "Argent X";
  if (normalized.includes("ready")) return provider.name?.trim() || "Ready";
  if (provider.name?.trim()) return provider.name.trim();
  if (key === "starknet") return "Starknet wallet";
  return key.replace(/^starknet[_-]?/i, "") || key;
}

function walletIdFor(key: string, provider: StarknetProviderWithMeta): string {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("braavos")) return "braavos";
  if (normalized.includes("argent")) return "argent-x";
  if (normalized.includes("ready")) return "ready";
  return provider.id?.trim() || key;
}

function walletPriorityFor(key: string, provider: StarknetProviderWithMeta): number {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("braavos")) return 0;
  if (normalized.includes("argent")) return 1;
  if (key === "starknet") return 4;
  if (normalized.includes("ready")) return 5;
  return 2;
}

function isSupportedWalletCandidate(key: string, provider: StarknetProviderWithMeta): boolean {
  const normalized = providerSearchText(key, provider);
  return normalized.includes("braavos") ||
    normalized.includes("argent") ||
    normalized.includes("ready");
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in locked-down browsers. The in-memory provider still works for this session.
  }
}

function safeLocalStorageRemove(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in locked-down browsers. The in-memory provider still works for this session.
  }
}

function collectWindowWalletCandidates(): WalletCandidate[] {
  const win = window as unknown as Window & Record<string, unknown>;
  const candidates: WalletCandidate[] = [];
  const safeWindowValue = (key: string) => {
    try {
      return win[key];
    } catch {
      return undefined;
    }
  };
  const windowPropertyNames = () => {
    try {
      return Object.getOwnPropertyNames(win);
    } catch {
      return Object.keys(win);
    }
  };
  const addCandidate = (key: string, value: unknown) => {
    candidates.push({ key, value, order: candidates.length });
  };
  const addRegistryEntry = (key: string, value: unknown) => {
    addCandidate(key, value);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const nestedKey of ["provider", "wallet", "starknet", "connector", "walletProvider", "starknetProvider"]) {
      addCandidate(`${key}_${nestedKey}`, record[nestedKey]);
      const nested = record[nestedKey];
      if (nested && typeof nested === "object") {
        const nestedRecord = nested as Record<string, unknown>;
        addCandidate(`${key}_${nestedKey}_provider`, nestedRecord.provider);
        addCandidate(`${key}_${nestedKey}_starknet`, nestedRecord.starknet);
      }
    }
  };

  KNOWN_STARKNET_PROVIDER_KEYS.forEach(key => addRegistryEntry(key, safeWindowValue(key)));

  const providerRegistry = win.starknetProviders;
  if (Array.isArray(providerRegistry)) {
    providerRegistry.forEach((provider, index) => {
      const meta = provider as StarknetProviderWithMeta;
      addRegistryEntry(`starknet_provider_${meta?.id || meta?.name || index}`, provider);
    });
  } else if (providerRegistry && typeof providerRegistry === "object") {
    Object.entries(providerRegistry as Record<string, unknown>).forEach(([key, provider]) => {
      addRegistryEntry(`starknet_provider_${key}`, provider);
    });
  }

  for (const key of windowPropertyNames()) {
    if (
      (key.startsWith("starknet") || /braavos|argent/i.test(key)) &&
      !candidates.some(candidate => candidate.key === key)
    ) {
      addRegistryEntry(key, safeWindowValue(key));
    }
  }
  addCandidate("starknet", window.starknet);
  return candidates;
}

function walletOptionsFromCandidates(candidates: WalletCandidate[]): StarknetWalletOption[] {

  const seenIds = new Set<string>();
  const seenProviders = new Set<StarknetProvider>();
  const wallets: StarknetWalletOption[] = [];

  for (const { key, value: candidate } of candidates
    .filter(({ value }) => isStarknetProvider(value))
    .sort((left, right) => {
      const leftProvider = left.value as StarknetProviderWithMeta;
      const rightProvider = right.value as StarknetProviderWithMeta;
      const leftPriority = walletPriorityFor(left.key, leftProvider);
      const rightPriority = walletPriorityFor(right.key, rightProvider);
      return leftPriority === rightPriority ? left.order - right.order : leftPriority - rightPriority;
    })) {
    if (!isStarknetProvider(candidate) || seenProviders.has(candidate)) continue;
    const provider = candidate as StarknetProviderWithMeta;
    if (!isSupportedWalletCandidate(key, provider)) continue;
    const id = walletIdFor(key, provider);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    seenProviders.add(candidate);
    wallets.push({
      id,
      name: walletNameFor(key, provider),
      provider: candidate,
    });
  }

  return wallets;
}

export function discoverStarknetWallets(): StarknetWalletOption[] {
  return walletOptionsFromCandidates(collectWindowWalletCandidates());
}

export async function discoverStarknetWalletsAsync(): Promise<StarknetWalletOption[]> {
  const candidates: WalletCandidate[] = [];
  try {
    const { getStarknet } = await import("@starknet-io/get-starknet-core");
    const bridge = getStarknet();
    const availableWallets = await bridge.getAvailableWallets().catch(() => []);
    availableWallets.forEach((wallet, index) => {
      candidates.push({
        key: `get_starknet_${wallet.id || wallet.name || index}`,
        value: wallet,
        order: candidates.length,
      });
    });
  } catch {
    // Manual injected-provider discovery below remains the fallback.
  }
  candidates.push(...collectWindowWalletCandidates().map(candidate => ({
    ...candidate,
    order: candidates.length + candidate.order,
  })));
  return walletOptionsFromCandidates(candidates);
}

export function injectedStarknet(): StarknetProvider | null {
  return discoverStarknetWallets()[0]?.provider ?? null;
}

export function selectedStarknetProvider(): StarknetProvider | null {
  const selected = (window as WindowWithSelectedWallet).zylithSelectedStarknetProvider;
  if (selected) return selected;
  const storedId = safeLocalStorageGet(SELECTED_STARKNET_WALLET_STORAGE_KEY);
  const wallets = discoverStarknetWallets();
  const wallet = wallets.find(option => option.id === storedId) ?? null;
  if (wallet) {
    (window as WindowWithSelectedWallet).zylithSelectedStarknetProvider = wallet.provider;
  }
  return wallet?.provider ?? null;
}

function addressFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const address = addressFromUnknown(item);
      if (address) return address;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["address", "selectedAddress"]) {
    const address = addressFromUnknown(record[key]);
    if (address) return address;
  }
  const account = record.account;
  if (account && typeof account === "object") {
    const address = addressFromUnknown((account as Record<string, unknown>).address);
    if (address) return address;
  }
  const accounts = record.accounts;
  if (accounts) return addressFromUnknown(accounts);
  return null;
}

function addressFromProviderResult(
  result: unknown,
  provider: StarknetProvider,
): string | null {
  return addressFromUnknown(result)
    ?? addressFromUnknown(provider.account)
    ?? addressFromUnknown((provider as { selectedAddress?: string }).selectedAddress);
}

function rememberSelectedProvider(provider: StarknetProvider, walletId?: string, address?: string) {
  (window as WindowWithSelectedWallet).zylithSelectedStarknetProvider = provider;
  if (address) (window as WindowWithSelectedWallet).zylithSelectedStarknetAddress = address;
  if (walletId) safeLocalStorageSet(SELECTED_STARKNET_WALLET_STORAGE_KEY, walletId);
  if (address) safeLocalStorageSet(CONNECTED_STARKNET_ADDRESS_STORAGE_KEY, address);
}

export function connectedStarknetAddress(): string | null {
  const provider = selectedStarknetProvider();
  if (!provider) return null;
  return addressFromProviderResult(null, provider)
    ?? (window as WindowWithSelectedWallet).zylithSelectedStarknetAddress
    ?? null;
}

export async function restoreConnectedStarknetWallet(): Promise<string | null> {
  const storedId = safeLocalStorageGet(SELECTED_STARKNET_WALLET_STORAGE_KEY);
  if (!storedId) return connectedStarknetAddress();

  let provider = selectedStarknetProvider();
  let walletId = storedId;
  if (!provider) {
    const wallets = await discoverStarknetWalletsAsync().catch(() => []);
    const wallet = wallets.find(option => option.id === storedId) ?? null;
    if (!wallet) return null;
    provider = wallet.provider;
    walletId = wallet.id;
    (window as WindowWithSelectedWallet).zylithSelectedStarknetProvider = provider;
  }

  const exposedAddress = addressFromProviderResult(null, provider);
  if (exposedAddress) {
    rememberSelectedProvider(provider, walletId, exposedAddress);
    return exposedAddress;
  }

  if (provider.request) {
    const silentAttempts = [
      { type: "wallet_requestAccounts", params: { silent_mode: true } },
      { type: "wallet_requestAccounts", params: { silentMode: true } },
      { method: "wallet_requestAccounts", params: [{ silent_mode: true }] },
      { method: "starknet_requestAccounts", params: [{ silent_mode: true }] },
    ];
    for (const request of silentAttempts) {
      try {
        const result = await provider.request(request);
        const address = addressFromProviderResult(result, provider);
        if (address) {
          rememberSelectedProvider(provider, walletId, address);
          return address;
        }
      } catch {
        // Silent reconnect is best-effort. We must not open wallet UI on page load.
      }
    }
  }

  return null;
}

export function clearSelectedStarknetProvider({
  disconnectWallet = false,
}: { disconnectWallet?: boolean } = {}) {
  const provider = selectedStarknetProvider() as (StarknetProvider & {
    disconnect?: () => Promise<unknown> | unknown;
  }) | null;
  if (disconnectWallet) {
    void disconnectProviderSession(provider);
  }
  (window as WindowWithSelectedWallet).zylithSelectedStarknetProvider = undefined;
  (window as WindowWithSelectedWallet).zylithSelectedStarknetAddress = undefined;
  safeLocalStorageRemove(SELECTED_STARKNET_WALLET_STORAGE_KEY);
  safeLocalStorageRemove(CONNECTED_STARKNET_ADDRESS_STORAGE_KEY);
}

export function disconnectStarknetProvider() {
  clearSelectedStarknetProvider({ disconnectWallet: true });
}

export async function connectStarknetProvider(
  providerOverride?: StarknetProvider,
  walletId?: string,
): Promise<string | null> {
  const provider = providerOverride ?? injectedStarknet();
  if (!provider) return null;
  let lastError: unknown = null;

  if (provider.request) {
    const attempts = [
      { type: "wallet_requestAccounts", params: { silent_mode: false } },
      { type: "wallet_requestAccounts", params: { silentMode: false } },
      { type: "wallet_requestAccounts" },
      { method: "wallet_requestAccounts", params: [] },
      { method: "starknet_requestAccounts", params: [] },
    ];
    for (const request of attempts) {
      try {
        const result = await provider.request(request);
        const address = addressFromProviderResult(result, provider);
        if (address) {
          rememberSelectedProvider(provider, walletId, address);
          return address;
        }
      } catch (error) {
        lastError = error;
        if (isUserRejectedRequest(error)) throw error;
      }
    }
  }

  if (provider.enable) {
    try {
      const result = await (provider.enable as ((o?: unknown) => Promise<unknown>))();
      const address = addressFromProviderResult(result, provider);
      if (address) {
        rememberSelectedProvider(provider, walletId, address);
        return address;
      }
    } catch (error) {
      lastError = error;
      if (isUserRejectedRequest(error)) throw error;
    }
  }

  const currentAddress = addressFromProviderResult(null, provider);
  if (currentAddress) {
    rememberSelectedProvider(provider, walletId, currentAddress);
    return currentAddress;
  }
  if (lastError) throw lastError;
  return null;
}

function isUserRejectedRequest(error: unknown): boolean {
  let message = "";
  if (error instanceof Error) message = error.message;
  else if (typeof error === "string") message = error;
  else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  }
  return /user rejected|user denied|user abort|rejected by user|cancelled by user|canceled by user/i.test(message);
}

async function disconnectProviderSession(
  provider: (StarknetProvider & { disconnect?: () => Promise<unknown> | unknown }) | null,
) {
  if (!provider) return;
  try {
    const result = provider.disconnect?.();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      await result;
    }
  } catch {
    // Wallet disconnect is best-effort. Zylith still clears its selected provider state locally.
  }
  if (provider.request) {
    const attempts = [
      { type: "wallet_disconnect" },
      { method: "wallet_disconnect" },
      { type: "wallet_requestAccounts", params: { silent_mode: true, disconnect: true } },
      { method: "wallet_revokePermissions", params: [{ starknet_accounts: {} }] },
    ];
    for (const request of attempts) {
      await provider.request(request).catch(() => undefined);
    }
  }
}
