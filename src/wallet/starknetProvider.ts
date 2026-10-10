// the injected starknet wallet: connecting, chain checks, typed-data signatures and receipts.

import { hash } from "starknet";
import {
  connectStarknetProvider,
  discoverStarknetWallets,
  restoreConnectedStarknetWallet,
  selectedStarknetProvider,
} from "../domain/browserWallet";
import { type DeploymentConfig, loadDeployment } from "../domain/deployment";
import {
  normalizeConfiguredFelt,
  normalizeFeltForComparison,
  STARKNET_FIELD_PRIME,
} from "../domain/felt";
import { starknetRpc } from "../domain/runtimeHttp";
import {
  stableJsonStringify,
  type WalletSignatureMessageVersion,
} from "../domain/walletLocalCrypto";

const WALLET_SIGNATURE_REQUEST_TIMEOUT_MS = 90_000;
const STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS = 10_000;

export type TransactionReceiptStatus = {
  failed: boolean;
  notFound: boolean;
  confirmed?: boolean;
  reason?: string;
};

const CHAIN_ID_ALIASES: Record<string, string> = {
  SN_SEPOLIA: "0x534e5f5345504f4c4941",
  SN_MAIN: "0x534e5f4d41494e",
};

export type StarknetWalletCall = {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
};

/** submits one ordinary call through the connected wallet. */
export async function executeStarknetWalletCall(
  provider: StarknetInjectedProvider,
  call: StarknetWalletCall
) {
  const account = safeWalletValue(provider, "account");
  const execute = safeWalletValue(account, "execute");
  if (typeof execute === "function") {
    return withStarknetWalletRequestTimeout(
      Promise.resolve().then(() => execute.call(account, [call])),
      WALLET_SIGNATURE_REQUEST_TIMEOUT_MS
    );
  }
  const providerRequest = safeWalletValue(provider, "request");
  if (typeof providerRequest !== "function") {
    throw new Error("Selected Starknet wallet cannot submit this transaction");
  }
  return withStarknetWalletRequestTimeout(
    Promise.resolve().then(() => providerRequest.call(provider, {
      type: "wallet_addInvokeTransaction",
      params: {
        calls: [{
          contract_address: call.contractAddress,
          entry_point: call.entrypoint,
          calldata: call.calldata,
        }],
      },
    })),
    WALLET_SIGNATURE_REQUEST_TIMEOUT_MS
  );
}

export type StarknetInjectedProvider = {
  id?: string;
  name?: string;
  chainId?: unknown;
  chain_id?: unknown;
  getChainId?: () => Promise<string> | string;
  enable?: (options?: unknown) => Promise<unknown>;
  request?: (request: {
    type?: string;
    method?: string;
    params?: unknown;
  }) => Promise<unknown>;
  account?: {
    address?: string;
    getChainId?: () => Promise<string>;
    execute?: (calls: StarknetWalletCall[]) => Promise<unknown>;
    signMessage?: (typedData: unknown) => Promise<unknown>;
  };
  selectedAddress?: string;
  isConnected?: boolean;
};

declare global {
  interface Window {
    starknet?: StarknetInjectedProvider;
    starknet_ready?: StarknetInjectedProvider;
    starknet_argentX?: StarknetInjectedProvider;
    argentX?: StarknetInjectedProvider;
    starknet_xverse?: StarknetInjectedProvider;
    xverse?: StarknetInjectedProvider;
  }
}

export async function buildZylithWalletAuthTypedData(input: {
  walletAddress: string;
  chainId: string;
  deploymentId: string;
  origin: string;
  messageVersion: WalletSignatureMessageVersion;
}) {
  const origin = input.origin.trim().toLowerCase();
  if (!/^[\x20-\x7e]{1,31}$/.test(origin)) {
    throw new Error("Zylith wallet authorization origin is not a readable short string");
  }
  if (input.messageVersion !== 2 || input.deploymentId.length > 66
    || !/^0x[1-9a-f][0-9a-f]*$/.test(input.deploymentId)
    || normalizeConfiguredFelt(input.deploymentId) !== input.deploymentId) {
    throw new Error("Wallet authorization requires a canonical nonzero deployment felt.");
  }
  return {
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      ZylithSession: [
        { name: "action", type: "shortstring" },
        { name: "wallet", type: "ContractAddress" },
        { name: "origin", type: "shortstring" },
        { name: "deployment", type: "felt" },
        { name: "version", type: "u128" },
      ],
    },
    primaryType: "ZylithSession",
    domain: {
      name: "Zylith",
      version: "2",
      chainId: input.chainId,
      revision: "1",
    },
    message: {
      action: "Only sign on app.zylith.fi",
      wallet: input.walletAddress,
      origin,
      deployment: input.deploymentId,
      version: String(input.messageVersion),
    },
  };
}

export async function requestStarknetWalletTypedSignature(
  provider: StarknetInjectedProvider,
  typedData: unknown
) {
  const providerRequest = safeWalletValue(provider, "request");
  if (typeof providerRequest === "function") {
    const requests = [
      { type: "wallet_signTypedData", params: typedData },
      { method: "wallet_signTypedData", params: typedData },
      { method: "starknet_signTypedData", params: typedData },
    ];
    for (const request of requests) {
      try {
        const result = await withWalletSignatureTimeout(
          Promise.resolve().then(() => providerRequest.call(provider, request))
        );
        if (result !== null && result !== undefined) return result;
      } catch (error) {
        if (isWalletSignatureProviderTimeout(error)) {
          throw new Error(
            "Wallet signature request timed out. Open your Starknet wallet, approve the signature, and retry."
          );
        }
        if (
          isUserRejectedWalletError(error) ||
          !isWalletSignRequestShapeError(error)
        ) {
          throw error;
        }
      }
    }
  }
  const account = safeWalletValue(provider, "account");
  const signMessage = safeWalletValue(account, "signMessage");
  if (typeof signMessage === "function") {
    try {
      return await withWalletSignatureTimeout(
        Promise.resolve().then(() => signMessage.call(account, typedData))
      );
    } catch (error) {
      if (isWalletSignatureProviderTimeout(error)) {
        throw new Error(
          "Wallet signature request timed out. Open your Starknet wallet, approve the signature, and retry."
        );
      }
      if (isWalletSignRequestShapeError(error)) {
        throw new Error("Selected Starknet wallet cannot sign Zylith messages");
      }
      throw error;
    }
  }
  throw new Error("Selected Starknet wallet cannot sign Zylith messages");
}

async function withWalletSignatureTimeout<T>(request: Promise<T>): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(
        new Error(
          "Wallet signature request timed out. Open your Starknet wallet, approve the signature, and retry."
        )
      );
    }, WALLET_SIGNATURE_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function isWalletSignRequestShapeError(error: unknown) {
  return /method not found|not supported|unsupported|not implemented|unknown method|invalid input|invalid_union|typed.?data|sign.?message/i.test(
    walletErrorMessage(error)
  );
}

function isWalletSignatureProviderTimeout(error: unknown) {
  return /^(?:error:\s*)?timeout$/i.test(walletErrorMessage(error).trim());
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return `0x${bytesToHex(new Uint8Array(digest))}`;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

function isWalletCallShapeError(error: unknown) {
  const message = walletErrorMessage(error);
  return /invalid_union|invalid input|contractAddress|contract_address|entrypoint|entry_point/i.test(
    message
  );
}

export function isUserRejectedWalletError(error: unknown) {
  return /user rejected|user denied|user abort|rejected by user|cancelled|canceled/i.test(
    walletErrorMessage(error)
  );
}

function isWalletRequestUnavailableError(error: unknown) {
  return /method not found|not supported|unsupported|not implemented|unknown method|wallet_addInvokeTransaction/i.test(
    walletErrorMessage(error)
  );
}

const MAX_WALLET_VALUE_DEPTH = 8;
const MAX_WALLET_VALUE_NODES = 32;

function safeWalletValue(value: unknown, key: string): unknown {
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

function runtimeAddressFromUnknown(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
  budget: { remaining: number } = { remaining: MAX_WALLET_VALUE_NODES },
): string | null {
  if (depth > MAX_WALLET_VALUE_DEPTH || budget.remaining <= 0) return null;
  if (typeof value === "string") return normalizeConfiguredFelt(value) || null;
  if (safeIsArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    budget.remaining -= 1;
    for (const item of value) {
      const address = runtimeAddressFromUnknown(item, depth + 1, seen, budget);
      if (address) return address;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  budget.remaining -= 1;
  return (
    runtimeAddressFromUnknown(safeWalletValue(value, "address"), depth + 1, seen, budget) ??
    runtimeAddressFromUnknown(safeWalletValue(value, "selectedAddress"), depth + 1, seen, budget) ??
    runtimeAddressFromUnknown(safeWalletValue(value, "account"), depth + 1, seen, budget) ??
    runtimeAddressFromUnknown(safeWalletValue(value, "accounts"), depth + 1, seen, budget)
  );
}

export function connectedProviderAddress(provider: StarknetInjectedProvider) {
  return (
    runtimeAddressFromUnknown(safeWalletValue(safeWalletValue(provider, "account"), "address")) ??
    runtimeAddressFromUnknown(safeWalletValue(provider, "selectedAddress"))
  );
}

/**
 * the wallet the user connected, and only that wallet. another installed wallet is never
 * prompted or selected here: doing so would link a second account to this session.
 */
export async function selectInjectedStarknetProvider(
  expectedAddress?: string | null,
  assertCurrent: () => void = () => undefined,
) {
  assertCurrent();
  const provider = selectedStarknetProvider();
  if (!provider) {
    throw new Error("Connect a Starknet wallet before submitting this transaction");
  }
  const deployment = await loadDeployment();
  assertCurrent();
  // re-read the wallet account silently before every state-changing action; provider events can
  // arrive late, so the cached address alone is not an authorization boundary.
  let address = await restoreConnectedStarknetWallet().catch(() => null);
  assertCurrent();
  if (!address) {
    const walletId = discoverStarknetWallets().find((option) => option.provider === provider)?.id;
    assertCurrent();
    address = await connectStarknetProvider(provider as never, walletId);
    assertCurrent();
  }
  if (!address) {
    throw new Error("Unlock your Starknet wallet and retry.");
  }
  if (
    expectedAddress
    && normalizeFeltForComparison(address) !== normalizeFeltForComparison(expectedAddress)
  ) {
    throw new Error("Connected Starknet wallet changed. Reconnect the wallet you authorized and retry.");
  }
  const account = safeWalletValue(provider, "account");
  if (
    typeof safeWalletValue(account, "execute") !== "function"
    && typeof safeWalletValue(provider, "request") !== "function"
  ) {
    throw new Error("Selected Starknet wallet cannot submit this transaction");
  }
  await ensureWalletChain(provider as never, deployment, assertCurrent);
  assertCurrent();
  return provider;
}

export async function ensureWalletChain(
  provider: StarknetInjectedProvider,
  deployment: Pick<DeploymentConfig, "chain_id" | "network" | "rpc_url">,
  assertCurrent: () => void = () => undefined,
) {
  const expected = normalizeRuntimeChainId(deployment.chain_id);
  if (!expected) {
    throw new Error("Deployment manifest is missing the Starknet chain ID.");
  }
  assertCurrent();
  const current = await requestWalletChainId(provider);
  assertCurrent();
  if (normalizeRuntimeChainId(current) === expected) return;
  assertCurrent();
  await requestWalletChainSwitch(provider, expected);
  assertCurrent();
  const switched = await requestWalletChainId(provider);
  assertCurrent();
  if (normalizeRuntimeChainId(switched) === expected) return;
  validateWalletChainMatch(deployment.chain_id, switched, deployment.network);
}

/** reads the connected wallet network without requesting a network change. */
export async function readStarknetWalletChainId(
  provider: StarknetInjectedProvider
) {
  return normalizeRuntimeChainId(await requestWalletChainId(provider));
}

export function validateWalletChainMatch(
  deploymentChainId: unknown,
  walletChainId: unknown,
  deploymentNetwork?: string
) {
  const expected = normalizeRuntimeChainId(deploymentChainId);
  const actual = normalizeRuntimeChainId(walletChainId);
  if (!expected) {
    throw new Error("Deployment manifest is missing the Starknet chain ID.");
  }
  if (!actual) {
    throw new Error("Connected Starknet wallet did not report its network.");
  }
  if (actual === expected) return;
  const networkName =
    deploymentNetwork === "sepolia"
      ? "Starknet Sepolia"
      : deploymentNetwork === "mainnet"
        ? "Starknet Mainnet"
      : deploymentNetwork || "the configured Starknet network";
  throw new Error(
    `Wrong Starknet network. Switch to ${networkName} in your wallet and retry.`
  );
}

async function requestWalletChainSwitch(
  provider: StarknetInjectedProvider,
  chainId: string
): Promise<boolean> {
  const providerRequest = safeWalletValue(provider, "request");
  if (typeof providerRequest !== "function") return false;
  const requests = [
    { type: "wallet_switchStarknetChain", params: { chainId } },
    { method: "wallet_switchStarknetChain", params: { chainId } },
  ];
  for (const request of requests) {
    try {
      await withStarknetWalletRequestTimeout(
        providerRequest.call(provider, request),
        STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
      );
      return true;
    } catch (error) {
      if (isUserRejectedWalletError(error)) throw error;
      if (
        !isWalletRequestUnavailableError(error) &&
        !isWalletCallShapeError(error)
      ) throw error;
    }
  }
  return false;
}

async function requestWalletChainId(
  provider: StarknetInjectedProvider
): Promise<string | null> {
  const providerRequest = safeWalletValue(provider, "request");
  if (typeof providerRequest === "function") {
    const requests = [
      { type: "wallet_requestChainId" },
      { method: "wallet_requestChainId" },
      { type: "starknet_chainId" },
      { method: "starknet_chainId" },
    ];
    for (const request of requests) {
      const result = await withStarknetWalletRequestTimeout(
        Promise.resolve().then(() => providerRequest.call(provider, request)),
        STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
      ).catch(() => null);
      const chainId = chainIdFromUnknown(result);
      if (chainId) return chainId;
    }
  }
  const getChainId = safeWalletValue(provider, "getChainId");
  if (typeof getChainId === "function") {
    const value = await withStarknetWalletRequestTimeout(
      Promise.resolve().then(() => getChainId.call(provider)),
      STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
    ).catch(() => null);
    const chainId = chainIdFromUnknown(value);
    if (chainId) return chainId;
  }
  const account = safeWalletValue(provider, "account");
  const accountGetChainId = safeWalletValue(account, "getChainId");
  if (typeof accountGetChainId === "function") {
    const value = await withStarknetWalletRequestTimeout(
      Promise.resolve().then(() => accountGetChainId.call(account)),
      STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
    ).catch(() => null);
    const chainId = chainIdFromUnknown(value);
    if (chainId) return chainId;
  }
  const providerChainId = safeWalletValue(provider, "chainId");
  if (typeof providerChainId === "function") {
    const value = await withStarknetWalletRequestTimeout(
      Promise.resolve().then(() => providerChainId.call(provider)),
      STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
    ).catch(() => null);
    const chainId = chainIdFromUnknown(value);
    if (chainId) return chainId;
  }
  return (
    chainIdFromUnknown(providerChainId) ??
    chainIdFromUnknown(safeWalletValue(provider, "chain_id"))
  );
}

async function withStarknetWalletRequestTimeout<T>(
  request: Promise<T | undefined> | undefined,
  timeoutMs: number
): Promise<T | undefined> {
  if (!request) return undefined;
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error("Starknet wallet request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function chainIdFromUnknown(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
  budget: { remaining: number } = { remaining: MAX_WALLET_VALUE_NODES },
): string | null {
  if (depth > MAX_WALLET_VALUE_DEPTH || budget.remaining <= 0) return null;
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return `0x${value.toString(16)}`;
  if (safeIsArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    budget.remaining -= 1;
    for (const item of value) {
      const chainId = chainIdFromUnknown(item, depth + 1, seen, budget);
      if (chainId) return chainId;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  budget.remaining -= 1;
  return (
    chainIdFromUnknown(safeWalletValue(value, "chainId"), depth + 1, seen, budget) ??
    chainIdFromUnknown(safeWalletValue(value, "chain_id"), depth + 1, seen, budget) ??
    chainIdFromUnknown(safeWalletValue(value, "id"), depth + 1, seen, budget) ??
    chainIdFromUnknown(safeWalletValue(value, "result"), depth + 1, seen, budget) ??
    chainIdFromUnknown(safeWalletValue(value, "data"), depth + 1, seen, budget) ??
    chainIdFromUnknown(safeWalletValue(value, "network"), depth + 1, seen, budget)
  );
}

function normalizeRuntimeChainId(value: unknown): string | null {
  const chainId = chainIdFromUnknown(value);
  if (!chainId) return null;
  const trimmed = chainId.trim();
  if (!trimmed) return null;
  const alias = CHAIN_ID_ALIASES[trimmed.toUpperCase()];
  if (alias) return alias;
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

export function walletErrorMessage(error: unknown) {
  return boundedWalletErrorMessage(error);
}

function boundedWalletErrorMessage(
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
    const message = boundedWalletErrorMessage(
      safeWalletValue(error, key),
      depth + 1,
      seen,
      budget,
    );
    if (message) return message;
  }
  return "";
}

export async function fetchTransactionReceiptStatus(
  transactionHash: string,
  deployment: Pick<DeploymentConfig, "chain_id" | "network" | "rpc_url">
): Promise<TransactionReceiptStatus | null> {
  const rpcUrl = deployment.rpc_url;
  if (!rpcUrl || !/^https?:\/\//i.test(rpcUrl)) return null;

  type ReceiptResponse = {
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown };
  };
  let receipt: ReceiptResponse = await starknetRpc<ReceiptResponse>(
    rpcUrl,
    "starknet_getTransactionReceipt",
    { transaction_hash: transactionHash }
  ).catch(async () =>
    starknetRpc<ReceiptResponse>(rpcUrl, "starknet_getTransactionReceipt", [
      transactionHash,
    ])
  );
  if (
    receipt.error &&
    /invalid.?params|invalid.?request/i.test(receipt.error.message ?? "")
  ) {
    receipt = await starknetRpc<ReceiptResponse>(
      rpcUrl,
      "starknet_getTransactionReceipt",
      [transactionHash]
    );
  }

  if (receipt.error) {
    const message = `${receipt.error.message ?? ""} ${JSON.stringify(
      receipt.error.data ?? ""
    )}`;
    if (/not.?found|unknown/i.test(message) || receipt.error.code === 29) {
      return { failed: false, notFound: true };
    }
    return null;
  }

  const result = receipt.result;
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const executionStatus = String(
    record.execution_status ?? record.executionStatus ?? record.status ?? ""
  ).toUpperCase();
  const finalityStatus = String(
    record.finality_status ?? record.finalityStatus ?? record.status ?? ""
  ).toUpperCase();
  const revertReason =
    typeof record.revert_reason === "string"
      ? record.revert_reason
      : typeof record.revertReason === "string"
      ? record.revertReason
      : undefined;
  if (
    /REVERT|REJECT/.test(executionStatus) ||
    /REVERT|REJECT/.test(finalityStatus)
  ) {
    return {
      failed: true,
      notFound: false,
      reason: revertReason || "Deposit transaction reverted.",
    };
  }
  const confirmed = /ACCEPTED_ON_L1|ACCEPTED_ON_L2/.test(finalityStatus);
  return { failed: false, notFound: false, confirmed };
}

/** the id a wallet-signature vault is bound to: the chain and the contracts holding its notes. */
export async function walletAuthDeploymentId(
  deployment: DeploymentConfig,
  messageVersion: WalletSignatureMessageVersion,
) {
  if (messageVersion !== 2) throw new Error("Unsupported wallet signature message version.");
  const digest = await sha256Hex(
    stableJsonStringify({
      chain_id: deployment.chain_id,
      exchange: normalizeFeltForComparison(deployment.contracts.exchange),
      privacy_deposit_bridge: normalizeFeltForComparison(deployment.contracts.privacy_deposit_bridge),
      funding_primary: deployment.funding.primary,
      auth_message_version: messageVersion,
    })
  );
  // the producer names the same 248-bit public deployment context the wallet has always signed.
  const value = BigInt(`0x${digest.slice(2, 64)}`);
  if (value === 0n || value >= STARKNET_FIELD_PRIME) throw new Error("Invalid wallet authorization deployment felt.");
  return `0x${value.toString(16)}`;
}

/** a view call against the latest block. */
export async function starknetCall(rpcUrl: string, contract: string, entrypoint: string, calldata: string[]) {
  const response = await starknetRpc<{ result?: string[]; error?: { message?: string } }>(rpcUrl, "starknet_call", {
    request: { contract_address: contract, entry_point_selector: hash.getSelectorFromName(entrypoint), calldata },
    block_id: "latest",
  });
  if (!response.result) throw new Error(response.error?.message ?? `${entrypoint} call failed`);
  return response.result;
}
