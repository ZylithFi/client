import { ProvingServiceProofProvider } from "@starkware-libs/starknet-privacy-sdk/browser";
import type {
  CallAndProof,
  ProofInvocation,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
  readSdkJsonResponse,
  readSdkResponseText,
} from "@zylith/sdk";
import {
  RpcProvider,
  Signer,
  constants,
  ec,
  hash,
  stark,
  type Call,
} from "starknet";
import { STARKNET_FIELD_PRIME, normalizeStrictFelt } from "../domain/felt";
import type { OhttpPolicy } from "../domain/fundingRail";
import { setPrivacyFundingStage } from "../domain/privacyFundingStage";
import { fetchWithTimeout } from "../domain/runtimeHttp";
import {
  errorMessage,
  isUserRejected,
  isWalletCallShapeError,
  isWalletRequestUnavailableError,
  markProofSubmissionStarted,
  markProofSubmissionRejected,
} from "./starknetPrivacyErrors";
import {
  paymasterExecuteUrl,
  serviceBaseUrl,
} from "./starknetPrivacyTransport";

type StarknetProviderLike = {
  request?: (request: { type?: string; params?: unknown }) => Promise<unknown>;
};

export type PrivacyBridgeDepositPlan = {
  amount: bigint;
  encodedArgs: {
    funding_commitments: string[];
    deposit_roots: string[];
    encrypted_note_activations: string[];
    note_commitments: string[];
    asset_ids: string[];
    amounts: string[];
    withdraw_authorities: string[];
  };
};

type StarknetClassHashReader = Pick<RpcProvider, "getClassHashAt">;

export type Strk20ExitClaimSignature = {
  signature_r: string;
  signature_s: string;
};

export type SubmitResidualRecoveryInput = {
  provider?: StarknetProviderLike;
  seedHex: string;
  chainId: string;
  rpcUrl: string;
  provingUrl: string;
  provingOhttpPolicy?: OhttpPolicy;
  paymasterAddress: string;
  paymasterUrl: string;
  privacyProofSignerClassHash: string;
  minProvingDelayBlocks: number;
  proofProgramCall: Call;
  settlementCall: Call;
};

export async function submitResidualRecovery(
  input: SubmitResidualRecoveryInput
): Promise<{ transactionHash: string }> {
  const rpcProvider = new RpcProvider({ nodeUrl: input.rpcUrl });
  const account = await createEmbeddedPrivacyProofAccount({
    provider: input.provider,
    seedHex: input.seedHex,
    rpcProvider,
    privacyProofSignerClassHash: input.privacyProofSignerClassHash,
    minProvingDelayBlocks: input.minProvingDelayBlocks,
  });
  const provingBlockId = await provingBlock(
    rpcProvider,
    Math.max(input.minProvingDelayBlocks, STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS)
  );
  const proof = await runProvingTransportAttempts({
    flow: "recovery",
    provingOhttpPolicy: input.provingOhttpPolicy,
    setStage: setFundingStage,
    run: async (useOhttp) => {
      const provider = createProvingProvider({
        chainId: input.chainId,
        rpcUrl: input.rpcUrl,
        proofAccountAddress: account.address,
        provingUrl: input.provingUrl,
        provingBlockId,
        provingOhttpEnabled: useOhttp,
      });
      return provider.prove(
        await proofInvocation(account, input.proofProgramCall, provider),
        provingBlockId
      );
    },
  });
  const transactionHash = await submitProofBearingCall({
    signerAddress: account.address,
    chainId: input.chainId,
    paymasterAddress: input.paymasterAddress,
    paymasterUrl: input.paymasterUrl,
    callAndProof: { call: input.settlementCall, proof },
  }).catch((error) => {
    throw markProofSubmissionStarted(error);
  });
  return { transactionHash };
}

async function proofInvocation(
  account: EmbeddedPrivacyProofAccount,
  call: Call,
  provider: ProvingServiceProofProvider
): Promise<ProofInvocation> {
  const details = await provider.getDefaultDetails();
  const rawCalldata = call.calldata ?? [];
  if (!Array.isArray(rawCalldata)) {
    throw new Error("Proof-program calldata must already be Cairo encoded");
  }
  const calldata = rawCalldata.map((value) => feltHex(value as string));
  const invokeCalldata = [
    "0x1",
    feltHex(call.contractAddress),
    feltHex(hash.getSelectorFromName(call.entrypoint)),
    feltHex(calldata.length),
    ...calldata,
  ];
  const signature = await account.signer.signTransaction([call], {
    walletAddress: account.address,
    cairoVersion: "1",
    ...details,
  } as never);
  const bounds = details.resourceBounds;
  if (!bounds) throw new Error("Proof service did not provide resource bounds");
  return {
    type: "INVOKE",
    sender_address: feltHex(account.address),
    calldata: invokeCalldata,
    signature: stark.formatSignature(signature),
    nonce: feltHex(details.nonce ?? 0n),
    resource_bounds: {
      l1_gas: {
        max_amount: feltHex(bounds.l1_gas.max_amount),
        max_price_per_unit: feltHex(bounds.l1_gas.max_price_per_unit),
      },
      l2_gas: {
        max_amount: feltHex(bounds.l2_gas.max_amount),
        max_price_per_unit: feltHex(bounds.l2_gas.max_price_per_unit),
      },
      l1_data_gas: {
        max_amount: feltHex(bounds.l1_data_gas?.max_amount ?? 0n),
        max_price_per_unit: feltHex(bounds.l1_data_gas?.max_price_per_unit ?? 0n),
      },
    },
    tip: feltHex(details.tip ?? 0n),
    paymaster_data: (details.paymasterData ?? []).map(feltHex),
    account_deployment_data: (details.accountDeploymentData ?? []).map(feltHex),
    nonce_data_availability_mode: details.nonceDataAvailabilityMode ?? "L1",
    fee_data_availability_mode: details.feeDataAvailabilityMode ?? "L1",
    version: "0x3",
  };
}

function feltHex(value: string | number | bigint): string {
  return `0x${BigInt(value).toString(16)}`;
}

export function privacyBridgeDepositCalldata(plan: PrivacyBridgeDepositPlan) {
  return [
    plan.encodedArgs.funding_commitments,
    plan.encodedArgs.deposit_roots,
    plan.encodedArgs.encrypted_note_activations,
    plan.encodedArgs.note_commitments,
    plan.encodedArgs.asset_ids,
    plan.encodedArgs.amounts,
    plan.encodedArgs.withdraw_authorities,
  ];
}

export function flattenCairoSpanCalldata(spans: string[][]): string[] {
  return spans.flatMap((span) => [String(span.length), ...span]);
}

export function privacyBridgeDepositFlatCalldata(
  plan: PrivacyBridgeDepositPlan
) {
  return flattenCairoSpanCalldata(privacyBridgeDepositCalldata(plan));
}

export function privacyBridgeStrk20ExitClaimCalldata(input: {
  exitCommitment: string;
  openNoteId: string;
  claimRecipient: string;
}) {
  return [
    [],
    [input.exitCommitment, input.openNoteId, input.claimRecipient],
    [],
    [],
    [],
    [],
    [],
  ];
}

export function privacyBridgeStrk20ExitClaimFlatCalldata(input: {
  exitCommitment: string;
  openNoteId: string;
  claimRecipient: string;
}) {
  return flattenCairoSpanCalldata(privacyBridgeStrk20ExitClaimCalldata(input));
}

export function privacyBridgeStrk20ExitAuthorizationCall(input: {
  bridgeAddress: string;
  exitCommitment: string;
  openNoteId: string;
  claimRecipient: string;
  signature: Strk20ExitClaimSignature;
}) {
  return {
    contractAddress: input.bridgeAddress,
    entrypoint: "authorize_strk20_exit_claim",
    calldata: [
      input.exitCommitment,
      input.openNoteId,
      input.claimRecipient,
      input.signature.signature_r,
      input.signature.signature_s,
    ],
  };
}

const STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS = 10;
const STARKNET_PRIVACY_SETUP_READY_TIMEOUT_MS = 10 * 60_000;
const STARKNET_PRIVACY_SETUP_READY_POLL_MS = 3_000;
const STARKNET_PRIVACY_PROOF_REQUEST_TIMEOUT_MS = 10 * 60_000;
const STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS = 12 * 60_000;
export const STARKNET_PRIVACY_OHTTP_EXECUTE_TIMEOUT_MS =
  STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS;
const STARKNET_PRIVACY_WALLET_EXECUTE_TIMEOUT_MS = 12 * 60_000;
const STARKNET_PRIVACY_RELAY_REQUEST_TIMEOUT_MS = 3 * 60_000;

export async function runProvingTransportAttempts<T>(input: {
  flow: "deposit" | "withdrawal" | "recovery";
  provingOhttpPolicy?: OhttpPolicy;
  setStage: (stage: string) => void;
  run: (useOhttp: boolean) => Promise<T>;
}): Promise<T> {
  const runWithDeadline = (useOhttp: boolean, timeoutMs: number) =>
    withTimeout(
      input.run(useOhttp),
      timeoutMs,
      `Private ${input.flow} proof generation timed out before the proof service returned.`
    );

  const policy = input.provingOhttpPolicy ?? "disabled";
  if (policy === "disabled") {
    return runWithDeadline(false, STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS);
  }

  try {
    return await runWithDeadline(
      true,
      STARKNET_PRIVACY_OHTTP_EXECUTE_TIMEOUT_MS
    );
  } catch (error) {
    if (policy === "required") throw error;
    if (!shouldRetryDirectProvingTransport(error)) throw error;
    input.setStage(
      `Private ${input.flow} proof continuing over direct HTTPS because best-effort OHTTP is unavailable`
    );
    return runWithDeadline(false, STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS);
  }
}

function createProvingProvider(input: {
  chainId: string;
  rpcUrl: string;
  privacyPoolAddress?: string;
  proofAccountAddress?: string;
  provingUrl: string;
  provingBlockId: number;
  provingOhttpEnabled: boolean;
}) {
  return new ProvingServiceProofProvider(
    serviceBaseUrl(input.provingUrl),
    starknetPrivacySdkChainId(input.chainId),
    {
      blockIdentifier: input.provingBlockId,
      requestTimeoutMs: STARKNET_PRIVACY_PROOF_REQUEST_TIMEOUT_MS,
      nodeUrl: input.rpcUrl,
      poolAddress: input.proofAccountAddress ?? input.privacyPoolAddress,
      ohttp: input.provingOhttpEnabled,
    }
  );
}

export function shouldRetryDirectProvingTransport(error: unknown) {
  const message = errorMessage(error);
  return (
    /proof generation timed out before the proof service returned/i.test(
      message
    ) ||
    /ohttp|decapsulation|signal is aborted|aborted without reason|aborterror|timeouterror|operation was aborted|failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
      message
    )
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function postFundingRelayJson<T>(
  url: string,
  body: unknown,
  timeoutMessage: string
): Promise<T> {
  const deadline = Date.now() + STARKNET_PRIVACY_RELAY_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      STARKNET_PRIVACY_RELAY_REQUEST_TIMEOUT_MS
    );
  } catch (error) {
    if (errorMessage(error) === "Runtime request timed out") {
      throw new Error(timeoutMessage);
    }
    if (isFundingRelayNetworkError(error)) {
      throw new Error(
        "Private relay request failed. Check your connection and retry."
      );
    }
    throw error;
  }
  if (!response.ok) {
    const text = await readSdkResponseText(response, {
      maxBytes: DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
      timeoutMs: Math.max(1, deadline - Date.now()),
      label: "Private relay error response",
    }).catch(() => "");
    const detail = sanitizeFundingRelayErrorBody(text);
    throw markProofSubmissionRejected(new Error(
      detail || `Private relay request failed with HTTP ${response.status}`
    ));
  }
  return (await readSdkJsonResponse(response, {
    timeoutMs: Math.max(1, deadline - Date.now()),
    label: "Private relay response",
  })) as T;
}

export function sanitizeFundingRelayErrorBody(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  let detail = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    const value = parsed.error ?? parsed.detail ?? parsed.message;
    if (typeof value === "string" && value.trim()) detail = value.trim();
  } catch {}
  return detail
    .replace(/"calldata"\s*:\s*\[[^\]]*\]/g, '"calldata":[...]')
    .replace(/"signature"\s*:\s*\[[^\]]*\]/g, '"signature":[...]')
    .replace(/0x[0-9a-fA-F]{33,}/g, "<felt>")
    .replace(/\b[0-9]{32,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function isFundingRelayNetworkError(error: unknown): boolean {
  const message = errorMessage(error);
  const name = safeWalletValue(error, "name");
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /signal is aborted|aborted without reason|aborterror|timeouterror|operation was aborted|failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
      message
    )
  );
}

function setFundingStage(stage: string) {
  setPrivacyFundingStage(stage);
}

export async function executeWalletCall(
  provider: StarknetProviderLike,
  call: Call
) {
  if (typeof safeWalletValue(provider, "request") !== "function") {
    throw new Error("Selected Starknet wallet cannot approve private deposits");
  }
  return requestWalletInvoke(provider, call);
}

async function requestWalletInvoke(provider: StarknetProviderLike, call: Call) {
  const walletRequestCall = {
    contract_address: call.contractAddress,
    entry_point: call.entrypoint,
    calldata: call.calldata ?? [],
  };
  try {
    const providerRequest = safeWalletValue(provider, "request");
    if (typeof providerRequest !== "function") return undefined;
    const request = Promise.resolve().then(() => providerRequest.call(provider, {
      type: "wallet_addInvokeTransaction",
      params: { calls: [walletRequestCall] },
    }));
    return await withTimeout(
      request,
      STARKNET_PRIVACY_WALLET_EXECUTE_TIMEOUT_MS,
      "Wallet approval timed out before the connected Starknet wallet returned a transaction hash."
    );
  } catch (error) {
    if (isUserRejected(error)) throw error;
    if (
      !isWalletCallShapeError(error) &&
      !isWalletRequestUnavailableError(error)
    ) {
      throw error;
    }
    const message = errorMessage(error);
    throw new Error(
      message || "Selected Starknet wallet rejected the deposit transaction shape",
      { cause: error },
    );
  }
}

async function withRpcRetry<T>(
  operation: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function submitProofBearingCall(input: {
  signerAddress: string;
  chainId: string;
  paymasterAddress?: string;
  paymasterUrl?: string;
  callAndProof: CallAndProof;
  authorizationCall?: Call;
}) {
  const call = input.callAndProof.call as Call;
  const proofDetails = proofDetailsForCall(input.callAndProof);

  if (!input.paymasterAddress || !input.paymasterUrl) {
    throw new Error("Transaction relay is not configured.");
  }
  const json = await postFundingRelayJson<{
    transaction_hash?: string;
    transactionHash?: string;
  }>(
    paymasterExecuteUrl(input.paymasterUrl),
    {
      chain_id: input.chainId,
      signer_address: input.signerAddress,
      paymaster_address: input.paymasterAddress,
      call: {
        contract_address: call.contractAddress,
        entrypoint: call.entrypoint,
        calldata: call.calldata ?? [],
      },
      ...(input.authorizationCall
        ? {
            authorization_call: {
              contract_address: input.authorizationCall.contractAddress,
              entrypoint: input.authorizationCall.entrypoint,
              calldata: input.authorizationCall.calldata ?? [],
            },
          }
        : {}),
      relay_nonce: randomFelt(),
      proof: proofDetails.proof,
      proof_facts: proofDetails.proofFacts,
    },
    "Transaction relay request timed out before returning a transaction hash"
  );
  const hash = json.transaction_hash ?? json.transactionHash;
  const normalizedHash = normalizeStrictFelt(hash);
  if (!normalizedHash || normalizedHash === "0x0")
    throw new Error("Transaction relay did not return a transaction hash");
  return normalizedHash;
}

type EmbeddedPrivacyProofAccount = {
  address: string;
  signer: Signer;
  privateKey: string;
};

async function createEmbeddedPrivacyProofAccount(input: {
  provider?: StarknetProviderLike;
  seedHex: string;
  rpcProvider: RpcProvider;
  privacyProofSignerClassHash?: string;
  minProvingDelayBlocks: number;
}): Promise<EmbeddedPrivacyProofAccount> {
  if (!input.privacyProofSignerClassHash) {
    throw new Error("Private deposit signer deployment is not configured");
  }
  const privateKey = await derivePrivacyProofSignerPrivateKey(input.seedHex);
  const signer = new Signer(privateKey);
  const publicKey = normalizeAddress(await signer.getPubKey());
  const salt = await derivePrivacyProofSignerSalt(input.seedHex);
  const existingAddress = await ensurePrivacyProofSignerContract({
    signerPublicKey: publicKey,
    salt,
    classHash: input.privacyProofSignerClassHash,
    provider: input.provider,
    rpcProvider: input.rpcProvider,
    minProvingDelayBlocks: input.minProvingDelayBlocks,
  });
  return {
    address: existingAddress,
    signer,
    privateKey,
  };
}

async function ensurePrivacyProofSignerContract(input: {
  signerPublicKey: string;
  salt: string;
  classHash: string;
  provider?: StarknetProviderLike;
  rpcProvider: RpcProvider;
  minProvingDelayBlocks: number;
}) {
  const expectedAddress = normalizeAddress(hash.calculateContractAddressFromHash(
    input.salt,
    input.classHash,
    [input.signerPublicKey],
    0,
  ));
  if (!expectedAddress) {
    throw new Error("Private signer configuration produced an invalid address");
  }
  const existingClassHash = await input.rpcProvider
    .getClassHashAt(expectedAddress, "pre_confirmed")
    .catch(() => input.rpcProvider.getClassHashAt(expectedAddress, "latest"))
    .catch(() => null);
  if (existingClassHash) {
    if (!sameFelt(existingClassHash, input.classHash)) {
      throw new Error("Private signer address has an unexpected class");
    }
    return expectedAddress;
  }
  if (!input.provider) {
    throw new Error("Connect a Starknet wallet to deploy the private signer");
  }
  await executeWalletCall(input.provider, {
    contractAddress: constants.UDC.ADDRESS,
    entrypoint: constants.UDC.ENTRYPOINT,
    calldata: [input.classHash, input.salt, "0x0", "0x1", input.signerPublicKey],
  });
  await waitForStateAndProvingDelay(
    input.rpcProvider,
    () => isClassDeployed(input.rpcProvider, expectedAddress),
    input.minProvingDelayBlocks,
    "embedded proof signer deployment"
  );
  return expectedAddress;
}

function proofDetailsForCall(callAndProof: CallAndProof) {
  const proofFacts = callAndProof.proof.proofFacts ?? [];
  if (!callAndProof.proof.data || proofFacts.length === 0) {
    throw new Error("Private deposit proof service did not return proof facts");
  }
  return {
    proof: callAndProof.proof.data,
    proofFacts,
  };
}

async function provingBlock(provider: RpcProvider, minDelayBlocks: number) {
  const latest = await withRpcRetry(() => provider.getBlockNumber());
  return Math.max(0, latest - Math.max(0, minDelayBlocks));
}

async function waitForStateAndProvingDelay(
  provider: RpcProvider,
  isReady: () => Promise<boolean>,
  minProvingDelayBlocks: number,
  label: string
) {
  const deadline = Date.now() + STARKNET_PRIVACY_SETUP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isReady().catch(() => false)) {
      const visibleBlock = await provider.getBlockNumber().catch(() => null);
      if (visibleBlock === null) {
        await new Promise((resolve) =>
          setTimeout(resolve, STARKNET_PRIVACY_SETUP_READY_POLL_MS)
        );
        continue;
      }
      await waitForBlock(
        provider,
        visibleBlock + Math.max(0, minProvingDelayBlocks),
        deadline,
        label
      );
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, STARKNET_PRIVACY_SETUP_READY_POLL_MS)
    );
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function isClassDeployed(
  provider: StarknetClassHashReader,
  contractAddress: string
) {
  const preConfirmed = await provider
    .getClassHashAt(contractAddress, "pre_confirmed")
    .catch(() => null);
  const classHash =
    preConfirmed ??
    (await provider
      .getClassHashAt(contractAddress, "latest")
      .catch(() => null));
  return Boolean(classHash);
}

async function waitForBlock(
  provider: RpcProvider,
  targetBlock: number,
  deadline: number,
  label: string
) {
  if (!Number.isFinite(targetBlock) || targetBlock <= 0) return;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label} proving delay`);
    }
    const latest = await provider.getBlockNumber().catch(() => null);
    if (latest !== null && latest >= targetBlock) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

function randomFelt() {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(30));
    if (!bytes.some((byte) => byte !== 0)) continue;
    return `0x${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")}`;
  }
}

export function starknetPrivacySdkChainId(
  chainId: string
): constants.StarknetChainId {
  const normalized = chainId.trim().toLowerCase();
  if (normalized === "sn_sepolia" || normalized === "0x534e5f5345504f4c4941") {
    return constants.StarknetChainId.SN_SEPOLIA;
  }
  if (normalized === "sn_main" || normalized === "0x534e5f4d41494e") {
    return constants.StarknetChainId.SN_MAIN;
  }
  throw new Error("Unsupported Starknet chain ID for private funding");
}

function sameFelt(left: unknown, right: unknown) {
  const normalizedLeft = normalizeAddress(left);
  const normalizedRight = normalizeAddress(right);
  return normalizedLeft !== "" && normalizedLeft === normalizedRight;
}

function normalizeAddress(value: unknown) {
  if (typeof value === "bigint") {
    if (value < 0n || value >= STARKNET_FIELD_PRIME) return "";
    return `0x${value.toString(16)}`;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return "";
    return normalizeAddress(BigInt(value));
  }
  return normalizeStrictFelt(value);
}

function safeWalletValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

async function derivePrivacyProofSignerPrivateKey(seedHex: string) {
  const value = await deriveFeltFromSeed(
    seedHex,
    "proof-signer",
    ec.starkCurve.CURVE.n
  );
  return `0x${value.toString(16)}`;
}

async function derivePrivacyProofSignerSalt(seedHex: string) {
  const value = await deriveFeltFromSeed(
    seedHex,
    "proof-signer-salt",
    STARKNET_FIELD_PRIME
  );
  return `0x${value.toString(16)}`;
}

async function deriveFeltFromSeed(
  seedHex: string,
  label: string,
  modulus: bigint
) {
  const digest = await sha256SeedDomain(
    `zylith/starknet-privacy/${label}/`,
    seedHex
  );
  try {
    return (BigInt(`0x${bytesToHex(digest)}`) % (modulus - 1n)) + 1n;
  } finally {
    digest.fill(0);
  }
}

async function sha256SeedDomain(domain: string, seedHex: string) {
  const domainBytes = new TextEncoder().encode(domain);
  const seedBytes = new TextEncoder().encode(seedHex);
  const input = new Uint8Array(domainBytes.length + seedBytes.length);
  input.set(domainBytes);
  input.set(seedBytes, domainBytes.length);
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  } finally {
    seedBytes.fill(0);
    input.fill(0);
  }
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}
