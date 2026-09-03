import {
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

const SELECTED_STARKNET_WALLET_STORAGE_KEY = "zylith:selected-starknet-wallet";
const CONNECTED_STARKNET_ADDRESS_STORAGE_KEY = "zylith:connected-starknet-address";
const WALLET_SILENT_REQUEST_TIMEOUT_MS = 2_000;
const WALLET_INTERACTIVE_REQUEST_TIMEOUT_MS = 60_000;
const WALLET_DISCONNECT_REQUEST_TIMEOUT_MS = 2_000;
const KNOWN_STARKNET_PROVIDER_KEYS = [
  "starknet_ready",
  "readyWallet",
  "ready",
  "starknet_xverse",
  "xverseStarknet",
  "xverse",
];

type WalletCandidate = {
  key: string;
  value: unknown;
  order: number;
};

function isStarknetProvider(value: unknown): value is StarknetProvider {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StarknetProvider>;
  return typeof candidate.request === "function";
}

function providerSearchText(key: string, provider: StarknetProviderWithMeta): string {
  return `${key} ${provider.id ?? ""} ${provider.name ?? ""}`.toLowerCase();
}

function walletNameFor(key: string, provider: StarknetProviderWithMeta): string {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("ready")) return "Ready X";
  if (normalized.includes("xverse")) return "Xverse";
  if (provider.name?.trim()) return provider.name.trim();
  if (key === "starknet") return "Starknet wallet";
  return key.replace(/^starknet[_-]?/i, "") || key;
}

function walletIdFor(key: string, provider: StarknetProviderWithMeta): string {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("ready")) return "ready";
  if (normalized.includes("xverse")) return "xverse";
  return provider.id?.trim() || key;
}

function walletPriorityFor(key: string, provider: StarknetProviderWithMeta): number {
  const normalized = providerSearchText(key, provider);
  if (normalized.includes("ready")) return 0;
  if (normalized.includes("xverse")) return 1;
  if (key === "starknet") return 4;
  return 2;
}

function isSupportedWalletCandidate(key: string, provider: StarknetProviderWithMeta): boolean {
  const normalized = providerSearchText(key, provider);
  return normalized.includes("ready") || normalized.includes("xverse");
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
    const normalizedKey = key.toLowerCase();
    if (
      (
        key.startsWith("starknet") ||
        normalizedKey.includes("ready") ||
        normalizedKey.includes("xverse")
      ) &&
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
  return discoverStarknetWallets();
}

export function injectedStarknet(): StarknetProvider | null {
  return discoverStarknetWallets()[0]?.provider ?? null;
}

export function selectedStarknetProvider(): StarknetProvider | null {
  if (selectedProvider) return selectedProvider;
  const storedId = sessionGetNullable(SELECTED_STARKNET_WALLET_STORAGE_KEY);
  const wallets = discoverStarknetWallets();
  const wallet = wallets.find(option => option.id === storedId) ?? null;
  if (wallet) {
    selectedProvider = wallet.provider;
  }
  return wallet?.provider ?? null;
}

function addressFromUnknown(value: unknown): string | null {
  if (typeof value === "string") return normalizeConfiguredFelt(value) || null;
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
  selectedProvider = provider;
  if (address) selectedAddress = address;
  if (walletId && walletId !== "selected") {
    sessionSet(SELECTED_STARKNET_WALLET_STORAGE_KEY, walletId);
  }
  if (address) sessionSet(CONNECTED_STARKNET_ADDRESS_STORAGE_KEY, address);
}

export function connectedStarknetAddress(): string | null {
  const provider = selectedStarknetProvider();
  if (!provider) return null;
  return addressFromProviderResult(null, provider)
    ?? selectedAddress
    ?? null;
}

export async function restoreConnectedStarknetWallet(): Promise<string | null> {
  const storedId = sessionGetNullable(SELECTED_STARKNET_WALLET_STORAGE_KEY);
  if (!storedId) return connectedStarknetAddress();

  let provider = selectedStarknetProvider();
  let walletId = storedId;
  if (!provider) {
    const wallets = await discoverStarknetWalletsAsync().catch(() => []);
    const wallet = wallets.find(option => option.id === storedId) ?? null;
    if (!wallet) return null;
    provider = wallet.provider;
    walletId = wallet.id;
    selectedProvider = provider;
  }

  const exposedAddress = addressFromProviderResult(null, provider);
  if (exposedAddress) {
    rememberSelectedProvider(provider, walletId, exposedAddress);
    return exposedAddress;
  }

  if (provider.request) {
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
  selectedProvider = null;
  selectedAddress = null;
  sessionRemove(SELECTED_STARKNET_WALLET_STORAGE_KEY);
  sessionRemove(CONNECTED_STARKNET_ADDRESS_STORAGE_KEY);
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
          rememberSelectedProvider(provider, walletId, address);
          return address;
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

function isWalletRequestTimeout(error: unknown): boolean {
  return error instanceof Error && /Starknet wallet request timed out/i.test(error.message);
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
  if (!provider.request) return Promise.resolve(null);
  return withWalletProviderTimeout(provider.request.call(provider, request), timeoutMs);
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
