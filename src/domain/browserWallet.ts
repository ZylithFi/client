import {
  localGetNullable,
  localRemove,
  localSet,
  sessionGetNullable,
  sessionRemove,
  sessionSet,
} from "./safeSessionStorage";
import { normalizeConfiguredFelt } from "./felt";
import type { WalletRuntime } from "../zylithWalletRuntime";

export type RuntimeStatus = "loading" | "ready" | "error";

let privateAccountRuntime: WalletRuntime | null = null;
let privateAccountRuntimeLoadError: string | undefined;
let selectedProvider: StarknetProvider | null = null;
let selectedAddress: string | null = null;
let selectedProviderRevision = 0;
const runtimeListeners = new Set<() => void>();

export function fmtAddr(s: string): string {
  if (!s || s.length < 10) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function walletRuntime() {
  return privateAccountRuntime;
}

export function walletRuntimeStatus(): RuntimeStatus {
  if (privateAccountRuntime) return "ready";
  if (privateAccountRuntimeLoadError) return "error";
  return "loading";
}

export function walletRuntimeLoadError() {
  return privateAccountRuntimeLoadError;
}

export function setWalletRuntime(runtime: WalletRuntime | null, loadError?: string) {
  privateAccountRuntime = runtime;
  privateAccountRuntimeLoadError = loadError;
  notifyWalletRuntimeChanged();
}

export function notifyWalletRuntimeChanged() {
  for (const listener of runtimeListeners) listener();
}

export function subscribeWalletRuntime(listener: () => void) {
  runtimeListeners.add(listener);
  return () => {
    runtimeListeners.delete(listener);
  };
}

export type StarknetProvider = NonNullable<typeof window.starknet>;
type StarknetProviderRequest = NonNullable<StarknetProvider["request"]>;
type StarknetProviderRequestInput = Parameters<StarknetProviderRequest>[0];

export type StarknetWalletOption = {
  id: string;
  name: string;
  provider: StarknetProvider;
};

type StarknetProviderWithMeta = StarknetProvider & {
  id?: string;
  name?: string;
};

type DisconnectableStarknetProvider = StarknetProvider & {
  disconnect?: () => Promise<unknown> | unknown;
};

type EventedStarknetProvider = {
  on?: (event: string, listener: (value: unknown) => void) => void;
  off?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};

export function subscribeStarknetProviderEvents(
  rawProvider: object,
  accountListener: (value: unknown) => void,
  networkListener: (value: unknown) => void,
) {
  const provider = rawProvider as EventedStarknetProvider;
  const subscribed: Array<[string, (value: unknown) => void]> = [];
  const subscribe = (event: string, listener: (value: unknown) => void) => {
    if (typeof provider.on !== "function") return;
    try {
      provider.on(event, listener);
      subscribed.push([event, listener]);
    } catch {
      // Injected wallets expose different event subsets.
    }
  };

  for (const event of ["accountsChanged", "accountChanged"]) {
    subscribe(event, accountListener);
  }
  for (const event of ["networkChanged", "chainChanged"]) {
    subscribe(event, networkListener);
  }

  return () => {
    for (const [event, listener] of subscribed) {
      try {
        provider.off?.(event, listener);
      } catch {}
      try {
        provider.removeListener?.(event, listener);
      } catch {}
    }
  };
}

const SELECTED_STARKNET_WALLET_STORAGE_KEY = "zylith:selected-starknet-wallet";
const CONNECTED_STARKNET_ADDRESS_STORAGE_KEY = "zylith:connected-starknet-address";
const WALLET_SILENT_REQUEST_TIMEOUT_MS = 2_000;
const WALLET_INTERACTIVE_REQUEST_TIMEOUT_MS = 60_000;
const WALLET_DISCONNECT_REQUEST_TIMEOUT_MS = 2_000;
const KNOWN_STARKNET_PROVIDER_KEYS = [
  "starknet_ready",
  "readyWallet",
  "ready",
  "starknet_argentX",
  "argentX",
  "starknet_xverse",
  "xverseStarknet",
  "xverse",
];

type WalletCandidate = {
  key: string;
  value: unknown;
  order: number;
};

function safeObjectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeIsArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function providerRequest(provider: StarknetProvider): StarknetProviderRequest | null {
  const request = safeObjectValue(provider, "request");
  return typeof request === "function" ? request as StarknetProviderRequest : null;
}

function providerErrorMessage(
  error: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
  budget: { remaining: number } = { remaining: 32 },
): string {
  if (depth > 8 || budget.remaining <= 0) return "";
  if (typeof error === "string") return error.slice(0, 4_096);
  if (
    typeof error === "number"
    || typeof error === "bigint"
    || typeof error === "boolean"
  ) return String(error);
  if (!error || typeof error !== "object") return "";
  if (seen.has(error)) return "";
  seen.add(error);
  budget.remaining -= 1;
  for (const key of ["message", "error", "reason", "detail", "cause"]) {
    const message = providerErrorMessage(
      safeObjectValue(error, key),
      depth + 1,
      seen,
      budget,
    );
    if (message) return message;
  }
  return "";
}

function isStarknetProvider(value: unknown): value is StarknetProvider {
  return typeof safeObjectValue(value, "request") === "function";
}

function providerSearchText(key: string, provider: StarknetProviderWithMeta): string {
  const id = safeObjectValue(provider, "id");
  const name = safeObjectValue(provider, "name");
  return `${key} ${typeof id === "string" ? id : ""} ${typeof name === "string" ? name : ""}`.toLowerCase();
}

function walletNameFor(key: string, provider: StarknetProviderWithMeta): string {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("ready") || normalized.includes("argent"))
    return "Ready X";
  if (normalized.includes("xverse")) return "Xverse";
  const name = safeObjectValue(provider, "name");
  if (typeof name === "string" && name.trim()) return name.trim();
  if (key === "starknet") return "Starknet wallet";
  return key.replace(/^starknet[_-]?/i, "") || key;
}

function walletIdFor(key: string, provider: StarknetProviderWithMeta): string {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("ready") || normalized.includes("argent"))
    return "ready";
  if (normalized.includes("xverse")) return "xverse";
  const id = safeObjectValue(provider, "id");
  return typeof id === "string" && id.trim() ? id.trim() : key;
}

function walletPriorityFor(key: string, provider: StarknetProviderWithMeta): number {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("ready") || normalized.includes("argent")) return 0;
  if (normalized.includes("xverse")) return 1;
  if (key === "starknet") return 4;
  return 2;
}

function isSupportedWalletCandidate(key: string, provider: StarknetProviderWithMeta): boolean {
  const normalized = providerSearchText(key, provider);
  return (
    normalized.includes("ready") ||
    normalized.includes("argent") ||
    normalized.includes("xverse")
  );
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
    for (const nestedKey of ["provider", "wallet", "starknet", "connector", "walletProvider", "starknetProvider"]) {
      const nested = safeObjectValue(value, nestedKey);
      addCandidate(`${key}_${nestedKey}`, nested);
      if (nested && typeof nested === "object") {
        addCandidate(`${key}_${nestedKey}_provider`, safeObjectValue(nested, "provider"));
        addCandidate(`${key}_${nestedKey}_starknet`, safeObjectValue(nested, "starknet"));
      }
    }
  };

  KNOWN_STARKNET_PROVIDER_KEYS.forEach(key => addRegistryEntry(key, safeWindowValue(key)));

  const providerRegistry = safeWindowValue("starknetProviders");
  if (safeIsArray(providerRegistry)) {
    providerRegistry.forEach((provider, index) => {
      const id = safeObjectValue(provider, "id");
      const name = safeObjectValue(provider, "name");
      const registryKey = typeof id === "string" && id
        ? id
        : typeof name === "string" && name
          ? name
          : index;
      addRegistryEntry(`starknet_provider_${registryKey}`, provider);
    });
  } else if (providerRegistry && typeof providerRegistry === "object") {
    let entries: Array<[string, unknown]> = [];
    try {
      entries = Object.entries(providerRegistry as Record<string, unknown>);
    } catch {}
    entries.forEach(([key, provider]) => addRegistryEntry(`starknet_provider_${key}`, provider));
  }

  for (const key of windowPropertyNames()) {
    const normalizedKey = key.toLowerCase();
    if (
      (
        key.startsWith("starknet") ||
        normalizedKey.includes("ready") ||
        normalizedKey.includes("argent") ||
        normalizedKey.includes("xverse")
      ) &&
      !candidates.some(candidate => candidate.key === key)
    ) {
      addRegistryEntry(key, safeWindowValue(key));
    }
  }
  addCandidate("starknet", safeWindowValue("starknet"));
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
  return discoverStarknetWallets();
}

export function injectedStarknet(): StarknetProvider | null {
  return discoverStarknetWallets()[0]?.provider ?? null;
}

export function selectedStarknetProvider(): StarknetProvider | null {
  if (selectedProvider) return selectedProvider;
  const storedId = persistedWalletId();
  const wallets = discoverStarknetWallets();
  const wallet = wallets.find(option => option.id === storedId) ?? null;
  if (wallet) {
    selectedProvider = wallet.provider;
  }
  return wallet?.provider ?? null;
}

function persistedWalletId() {
  return localGetNullable(SELECTED_STARKNET_WALLET_STORAGE_KEY)
    ?? sessionGetNullable(SELECTED_STARKNET_WALLET_STORAGE_KEY);
}

const MAX_PROVIDER_VALUE_DEPTH = 8;
const MAX_PROVIDER_VALUE_NODES = 32;

function addressFromUnknown(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
  budget: { remaining: number } = { remaining: MAX_PROVIDER_VALUE_NODES },
): string | null {
  if (depth > MAX_PROVIDER_VALUE_DEPTH || budget.remaining <= 0) return null;
  if (typeof value === "string") return normalizeConfiguredFelt(value) || null;
  if (safeIsArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    budget.remaining -= 1;
    for (const item of value) {
      const address = addressFromUnknown(item, depth + 1, seen, budget);
      if (address) return address;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  budget.remaining -= 1;
  for (const key of ["address", "selectedAddress"]) {
    const address = addressFromUnknown(safeObjectValue(value, key), depth + 1, seen, budget);
    if (address) return address;
  }
  const account = safeObjectValue(value, "account");
  if (account && typeof account === "object") {
    const address = addressFromUnknown(
      safeObjectValue(account, "address"),
      depth + 1,
      seen,
      budget,
    );
    if (address) return address;
  }
  const accounts = safeObjectValue(value, "accounts");
  if (accounts) return addressFromUnknown(accounts, depth + 1, seen, budget);
  return null;
}

function addressFromProviderResult(
  result: unknown,
  provider: StarknetProvider,
): string | null {
  return addressFromUnknown(result)
    ?? addressFromUnknown(safeObjectValue(provider, "account"))
    ?? addressFromUnknown(safeObjectValue(provider, "selectedAddress"));
}

function rememberSelectedProvider(
  provider: StarknetProvider,
  walletId?: string,
  address?: string,
  expectedRevision?: number,
) {
  if (expectedRevision !== undefined && expectedRevision !== selectedProviderRevision) return false;
  selectedProvider = provider;
  if (address) selectedAddress = address;
  if (walletId && walletId !== "selected") {
    localSet(SELECTED_STARKNET_WALLET_STORAGE_KEY, walletId);
    sessionSet(SELECTED_STARKNET_WALLET_STORAGE_KEY, walletId);
  }
  if (address) sessionSet(CONNECTED_STARKNET_ADDRESS_STORAGE_KEY, address);
  return true;
}

export function connectedStarknetAddress(): string | null {
  const provider = selectedStarknetProvider();
  if (!provider) return null;
  return addressFromProviderResult(null, provider)
    ?? selectedAddress
    ?? null;
}

export function applyStarknetAccountsChanged(value: unknown): string | null {
  const address = addressFromUnknown(value);
  if (!address) {
    clearSelectedStarknetProvider();
    return null;
  }
  selectedAddress = address;
  sessionSet(CONNECTED_STARKNET_ADDRESS_STORAGE_KEY, address);
  return address;
}

export async function restoreConnectedStarknetWallet(): Promise<string | null> {
  const revision = selectedProviderRevision;
  const storedId = persistedWalletId();
  if (!storedId) return connectedStarknetAddress();

  let provider = selectedStarknetProvider();
  let walletId = storedId;
  if (!provider) {
    const wallets = await discoverStarknetWalletsAsync().catch(() => []);
    const wallet = wallets.find(option => option.id === storedId) ?? null;
    if (!wallet) return null;
    provider = wallet.provider;
    walletId = wallet.id;
  }

  const exposedAddress = addressFromProviderResult(null, provider);
  if (exposedAddress) {
    return rememberSelectedProvider(provider, walletId, exposedAddress, revision)
      ? exposedAddress
      : null;
  }

  if (providerRequest(provider)) {
    const silentAttempts: StarknetProviderRequestInput[] = [
      { type: "wallet_requestAccounts", params: { silent_mode: true } },
    ];
    for (const request of silentAttempts) {
      try {
        const result = await requestWalletProvider(
          provider,
          request,
          WALLET_SILENT_REQUEST_TIMEOUT_MS,
        );
        const address = addressFromProviderResult(result, provider);
        if (address) {
          return rememberSelectedProvider(provider, walletId, address, revision)
            ? address
            : null;
        }
      } catch {
        // silent reconnect is best-effort. we must not open wallet ui on page load.
      }
    }
  }

  return null;
}

export function clearSelectedStarknetProvider({
  disconnectWallet = false,
}: { disconnectWallet?: boolean } = {}) {
  const provider = selectedStarknetProvider() as DisconnectableStarknetProvider | null;
  if (disconnectWallet) {
    void disconnectProviderSession(provider);
  }
  selectedProviderRevision += 1;
  selectedProvider = null;
  selectedAddress = null;
  sessionRemove(SELECTED_STARKNET_WALLET_STORAGE_KEY);
  sessionRemove(CONNECTED_STARKNET_ADDRESS_STORAGE_KEY);
  localRemove(SELECTED_STARKNET_WALLET_STORAGE_KEY);
  localRemove(CONNECTED_STARKNET_ADDRESS_STORAGE_KEY);
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
  const revision = ++selectedProviderRevision;
  let lastError: unknown = null;

  if (providerRequest(provider)) {
    const attempts: StarknetProviderRequestInput[] = [
      { type: "wallet_requestAccounts", params: { silent_mode: false } },
    ];
    for (const request of attempts) {
      try {
        const result = await requestWalletProvider(
          provider,
          request,
          WALLET_INTERACTIVE_REQUEST_TIMEOUT_MS,
        );
        const address = addressFromProviderResult(result, provider);
        if (address) {
          return rememberSelectedProvider(provider, walletId, address, revision)
            ? address
            : null;
        }
      } catch (error) {
        lastError = error;
        if (isUserRejectedRequest(error)) throw error;
        if (isWalletRequestTimeout(error)) throw error;
      }
    }
  }

  const currentAddress = addressFromProviderResult(null, provider);
  if (currentAddress) {
    return rememberSelectedProvider(provider, walletId, currentAddress, revision)
      ? currentAddress
      : null;
  }
  if (lastError) throw lastError;
  return null;
}

function isUserRejectedRequest(error: unknown): boolean {
  const message = providerErrorMessage(error);
  return /user rejected|user denied|user abort|rejected by user|cancelled by user|canceled by user/i.test(message);
}

function isWalletRequestTimeout(error: unknown): boolean {
  try {
    return error instanceof Error && /Starknet wallet request timed out/i.test(error.message);
  } catch {
    return false;
  }
}

async function disconnectProviderSession(
  provider: DisconnectableStarknetProvider | null,
) {
  if (!provider) return;
  try {
    const disconnect = safeObjectValue(provider, "disconnect");
    const result = typeof disconnect === "function"
      ? (disconnect as () => Promise<unknown> | unknown).call(provider)
      : undefined;
    if (result && typeof (result as Promise<unknown>).then === "function") {
      await result;
    }
  } catch {
    // wallet disconnect is best-effort. zylith still clears its selected provider state locally.
  }
  if (providerRequest(provider)) {
    const attempts: StarknetProviderRequestInput[] = [
      { type: "wallet_disconnect" },
    ];
    for (const request of attempts) {
      await requestWalletProvider(
        provider,
        request,
        WALLET_DISCONNECT_REQUEST_TIMEOUT_MS,
      ).catch(() => undefined);
    }
  }
}

function requestWalletProvider(
  provider: StarknetProvider,
  request: StarknetProviderRequestInput,
  timeoutMs: number,
) {
  const providerRequestMethod = providerRequest(provider);
  if (!providerRequestMethod) return Promise.resolve(null);
  let response: ReturnType<StarknetProviderRequest>;
  try {
    response = providerRequestMethod.call(provider, request);
  } catch (error) {
    return Promise.reject(error);
  }
  return withWalletProviderTimeout(response, timeoutMs);
}

async function withWalletProviderTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error("Starknet wallet request timed out. Unlock your wallet and retry."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}
