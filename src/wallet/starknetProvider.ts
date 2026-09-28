// the injected starknet wallet: connecting, chain checks, typed-data signatures and receipts.

import { hash } from "starknet";
import {
  connectStarknetProvider,
  discoverStarknetWallets,
  selectedStarknetProvider,
} from "../domain/browserWallet";
import { type DeploymentConfig, loadDeployment } from "../domain/deployment";
import { normalizeFeltForComparison } from "../domain/felt";
import { starknetRpc } from "../domain/runtimeHttp";
import { stableJsonStringify, type WalletSignatureMessageVersion } from "../domain/walletLocalCrypto";

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

type StarknetWalletCall = {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
};

type WalletRequestInvokeCall = {
  contract_address: string;
  entry_point: string;
  calldata: string[];
};

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
        { name: "origin", type: "felt" },
        { name: "deployment", type: "felt" },
        { name: "version", type: "u128" },
      ],
    },
    primaryType: "ZylithSession",
    domain: {
      name: "Zylith",
      version: "1",
      chainId: input.chainId,
      revision: "1",
    },
    message: {
      action: "Authorize",
      wallet: input.walletAddress,
      origin: await feltHashForText(input.origin),
      deployment: feltFromHexHash(input.deploymentId),
      version: "1",
    },
  };
}

export async function requestStarknetWalletTypedSignature(
  provider: StarknetInjectedProvider,
  typedData: unknown
) {
  if (provider.request) {
    const requests = [
      { type: "wallet_signTypedData", params: typedData },
      { method: "wallet_signTypedData", params: typedData },
      { method: "starknet_signTypedData", params: typedData },
    ];
    for (const request of requests) {
      try {
        const result = await withWalletSignatureTimeout(
          provider.request.call(provider, request)
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
  if (typeof provider.account?.signMessage === "function") {
    try {
      return await withWalletSignatureTimeout(
        provider.account.signMessage(typedData)
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

async function feltHashForText(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return `0x${bytesToHex(new Uint8Array(digest).slice(0, 31))}`;
}

function feltFromHexHash(value: string) {
  const normalized = value.trim().replace(/^0x/i, "").toLowerCase();
  return `0x${normalized.slice(0, 62) || "0"}`;
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

function runtimeAddressFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const address = runtimeAddressFromUnknown(item);
      if (address) return address;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return (
    runtimeAddressFromUnknown(record.address) ??
    runtimeAddressFromUnknown(record.selectedAddress) ??
    runtimeAddressFromUnknown(record.account) ??
    runtimeAddressFromUnknown(record.accounts)
  );
}

export function connectedProviderAddress(provider: StarknetInjectedProvider) {
  return (
    runtimeAddressFromUnknown(provider.account?.address) ??
    runtimeAddressFromUnknown(provider.selectedAddress)
  );
}

export async function selectInjectedStarknetProvider() {
  const preferredProvider = selectedStarknetProvider();
  const discovered = discoverStarknetWallets();
  const deployment = await loadDeployment();
  const preferredWallet = preferredProvider
    ? discovered.find(({ provider }) => provider === preferredProvider) ?? null
    : null;
  const orderedProviders = preferredProvider
    ? [
        { id: preferredWallet?.id, provider: preferredProvider },
        ...discovered.filter(({ provider }) => provider !== preferredProvider),
      ]
    : discovered;
  for (const { id, provider } of orderedProviders) {
    try {
      await connectStarknetProvider(provider as never, id);
    } catch (error) {
      if (isUserRejectedWalletError(error)) throw error;
      continue;
    }
    if (provider.account?.execute || provider.request) {
      await ensureWalletChain(provider, deployment);
      return provider;
    }
  }
  throw new Error(
    "Connect a Starknet wallet before submitting this transaction"
  );
}

export async function ensureWalletChain(
  provider: StarknetInjectedProvider,
  deployment: Pick<DeploymentConfig, "chain_id" | "network" | "rpc_url">
) {
  const expected = normalizeRuntimeChainId(deployment.chain_id);
  if (!expected) {
    throw new Error("Deployment manifest is missing the Starknet chain ID.");
  }
  const current = await requestWalletChainId(provider);
  if (normalizeRuntimeChainId(current) === expected) return;
  const switchAccepted = await requestWalletChainSwitch(provider, expected);
  const switched = await requestWalletChainId(provider);
  if (normalizeRuntimeChainId(switched) === expected) return;
  if (
    !normalizeRuntimeChainId(current) &&
    !normalizeRuntimeChainId(switched) &&
    switchAccepted
  ) {
    return;
  }
  validateWalletChainMatch(deployment.chain_id, switched, deployment.network);
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
      : deploymentNetwork || "the configured Starknet network";
  throw new Error(
    `Wrong Starknet network. Switch to ${networkName} in your wallet and retry.`
  );
}

async function requestWalletChainSwitch(
  provider: StarknetInjectedProvider,
  chainId: string
): Promise<boolean> {
  if (!provider.request) return false;
  const requests = [
    { type: "wallet_switchStarknetChain", params: { chainId } },
    { method: "wallet_switchStarknetChain", params: { chainId } },
  ];
  for (const request of requests) {
    try {
      await withStarknetWalletRequestTimeout(
        provider.request.call(provider, request),
        STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
      );
      return true;
    } catch (error) {
      if (isUserRejectedWalletError(error)) throw error;
      if (
        !isWalletRequestUnavailableError(error) &&
        !isWalletCallShapeError(error)
      ) {
        return true;
      }
    }
  }
  return false;
}

async function requestWalletChainId(
  provider: StarknetInjectedProvider
): Promise<string | null> {
  if (provider.request) {
    const requests = [
      { type: "wallet_requestChainId" },
      { method: "wallet_requestChainId" },
      { type: "starknet_chainId" },
      { method: "starknet_chainId" },
    ];
    for (const request of requests) {
      const result = await withStarknetWalletRequestTimeout(
        provider.request.call(provider, request),
        STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
      ).catch(() => null);
      const chainId = chainIdFromUnknown(result);
      if (chainId) return chainId;
    }
  }
  if (provider.getChainId) {
    const value = await withStarknetWalletRequestTimeout(
      Promise.resolve(provider.getChainId()),
      STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
    ).catch(() => null);
    const chainId = chainIdFromUnknown(value);
    if (chainId) return chainId;
  }
  if (provider.account?.getChainId) {
    const value = await withStarknetWalletRequestTimeout(
      provider.account.getChainId(),
      STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
    ).catch(() => null);
    const chainId = chainIdFromUnknown(value);
    if (chainId) return chainId;
  }
  if (typeof provider.chainId === "function") {
    const value = await withStarknetWalletRequestTimeout(
      Promise.resolve((provider.chainId as () => unknown)()),
      STARKNET_WALLET_CHAIN_REQUEST_TIMEOUT_MS
    ).catch(() => null);
    const chainId = chainIdFromUnknown(value);
    if (chainId) return chainId;
  }
  return (
    chainIdFromUnknown(provider.chainId) ??
    chainIdFromUnknown(provider.chain_id)
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

function chainIdFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return `0x${value.toString(16)}`;
  if (Array.isArray(value)) {
    for (const item of value) {
      const chainId = chainIdFromUnknown(item);
      if (chainId) return chainId;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return (
    chainIdFromUnknown(record.chainId) ??
    chainIdFromUnknown(record.chain_id) ??
    chainIdFromUnknown(record.id) ??
    chainIdFromUnknown(record.result) ??
    chainIdFromUnknown(record.data) ??
    chainIdFromUnknown(record.network)
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
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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
  const confirmed =
    /ACCEPTED|SUCCEEDED/.test(executionStatus) ||
    /ACCEPTED|SUCCEEDED/.test(finalityStatus);
  return { failed: false, notFound: false, confirmed };
}

/** the id a wallet-signature vault is bound to: the chain and the contracts holding its notes. */
export async function walletAuthDeploymentId(
  deployment: DeploymentConfig,
  messageVersion: WalletSignatureMessageVersion
) {
  return sha256Hex(
    stableJsonStringify({
      chain_id: deployment.chain_id,
      exchange: normalizeFeltForComparison(deployment.contracts.exchange),
      privacy_deposit_bridge: normalizeFeltForComparison(deployment.contracts.privacy_deposit_bridge),
      funding_primary: deployment.funding.primary,
      auth_message_version: messageVersion,
    })
  );
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
