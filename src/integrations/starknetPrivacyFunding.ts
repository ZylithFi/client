import {
  createEmptyRegistry,
  createPrivateTransfers,
  IndexerDiscoveryProvider,
  MAX_VIEWING_KEY,
  Open,
  ProvingServiceProofProvider,
} from "@starkware-libs/starknet-privacy-sdk/browser";
import type {
  CallAndProof,
  PrivateRegistry,
  Warning,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
  readSdkJsonResponse,
  readSdkResponseText,
} from "@zylith/sdk";
import { RpcProvider, Signer, constants, ec, hash, type Call } from "starknet";
import { STARKNET_FIELD_PRIME, normalizeStrictFelt } from "../domain/felt";
import {
  CONNECTED_WALLET_NOT_ACTIVATED_ERROR,
  ETH_DEPOSIT_FEE_HEADROOM_ERROR,
} from "../domain/privateDepositErrors";
import { setPrivacyFundingStage } from "../domain/privacyFundingStage";
import { fetchWithTimeout } from "../domain/runtimeHttp";
import {
  errorMessage,
  isProofBlockTooRecent,
  isProofExpired,
  isProofProviderContractVisibilityLag,
  isProofProviderServiceBusy,
  isProofProviderTransientNetworkError,
  isUserRejected,
  isWalletCallShapeError,
  isWalletRequestUnavailableError,
  summarizeFundingError,
} from "./starknetPrivacyErrors";
import {
  paymasterExecuteUrl,
  paymasterPrivacySignerEnsureUrl,
  paymasterPrivacySignerRelayUrl,
  serviceBaseUrl,
  transactionHashFromResult,
} from "./starknetPrivacyTransport";
import { runProofDelayRetryLoop } from "./starknetPrivacyProofRetry";

type StarknetProviderLike = {
  account?: {
    address?: string;
    walletProvider?: unknown;
  };
  selectedAddress?: string;
  accounts?: unknown;
  request?: (request: {
    type?: string;
    params?: unknown;
  }) => Promise<unknown>;
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

export type SubmitPrivacyBridgeDepositInput = {
  provider: StarknetProviderLike;
  seedHex: string;
  chainId: string;
  rpcUrl: string;
  privacyPoolAddress: string;
  bridgeAddress: string;
  tokenAddress: string;
  discoveryUrl: string;
  provingUrl: string;
  provingOhttpEnabled?: boolean;
  paymasterAddress?: string;
  paymasterUrl?: string;
  privacyProofSignerClassHash?: string;
  minProvingDelayBlocks: number;
  sdkRegistry?: PrivateRegistry;
  plan: PrivacyBridgeDepositPlan;
};

export type WarmUpStarknetPrivacyFundingInput = {
  seedHex: string;
  chainId: string;
  rpcUrl: string;
  privacyPoolAddress: string;
  tokenAddresses: string[];
  paymasterUrl?: string;
  privacyProofSignerClassHash?: string;
  minProvingDelayBlocks: number;
};

export type WarmUpStarknetPrivacyFundingResult = {
  signerAddress: string;
  approvalTransactionHashes: string[];
};

export type SubmitPrivacyBridgeDepositResult = {
  transactionHash: string;
  sdkRegistry: PrivateRegistry;
};

export type Strk20ExitClaimSignature = {
  signature_r: string;
  signature_s: string;
};

export type SubmitPrivacyOpenNoteWithdrawalInput = {
  seedHex: string;
  chainId: string;
  rpcUrl: string;
  privacyPoolAddress: string;
  bridgeAddress: string;
  tokenAddress: string;
  discoveryUrl: string;
  provingUrl: string;
  provingOhttpEnabled?: boolean;
  paymasterAddress?: string;
  paymasterUrl?: string;
  privacyProofSignerClassHash?: string;
  minProvingDelayBlocks: number;
  sdkRegistry?: PrivateRegistry;
  exitCommitment: string;
  signExitClaim: (openNoteId: string) => Strk20ExitClaimSignature;
};

export type SubmitPrivacyOpenNoteWithdrawalResult = {
  transactionHash: string;
  openNoteId: string;
  sdkRegistry: PrivateRegistry;
};

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

export function privacyBridgeDepositInvokeCall(input: {
  bridgeAddress: string;
  plan: PrivacyBridgeDepositPlan;
}) {
  return {
    contractAddress: input.bridgeAddress,
    entrypoint: "privacy_invoke",
    calldata: privacyBridgeDepositCalldata(input.plan),
  };
}

export function privacyBridgeStrk20ExitClaimCalldata(input: {
  exitCommitment: string;
  openNoteId: string;
  signature: Strk20ExitClaimSignature;
}) {
  return [
    [],
    [
      input.exitCommitment,
      input.openNoteId,
      input.signature.signature_r,
      input.signature.signature_s,
    ],
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
  signature: Strk20ExitClaimSignature;
}) {
  return flattenCairoSpanCalldata(privacyBridgeStrk20ExitClaimCalldata(input));
}

export function privacyBridgeStrk20ExitClaimInvokeCall(input: {
  bridgeAddress: string;
  exitCommitment: string;
  openNoteId: string;
  signature: Strk20ExitClaimSignature;
}) {
  return {
    contractAddress: input.bridgeAddress,
    entrypoint: "privacy_invoke",
    calldata: privacyBridgeStrk20ExitClaimCalldata(input),
  };
}

const STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS = 10;
export const STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS = [
  10, 16, 24, 32, 48, 64, 96,
] as const;
const STARKNET_PRIVACY_REPLAY_GUARD_ATOMS = 1n;
const STARKNET_ETH_TOKEN_ADDRESS =
  "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
export const CONNECTED_WALLET_ETH_FEE_RESERVE_ATOMS = 5_000_000_000_000n;
const STARKNET_PRIVACY_REUSABLE_APPROVAL_AMOUNT = (1n << 128n) - 1n;
const STARKNET_PRIVACY_SETUP_READY_TIMEOUT_MS = 10 * 60_000;
const STARKNET_PRIVACY_SETUP_READY_POLL_MS = 3_000;
const STARKNET_PRIVACY_PROOF_REQUEST_TIMEOUT_MS = 10 * 60_000;
const STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS = 12 * 60_000;
export const STARKNET_PRIVACY_OHTTP_EXECUTE_TIMEOUT_MS =
  STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS;
const STARKNET_PRIVACY_WALLET_EXECUTE_TIMEOUT_MS = 12 * 60_000;
const STARKNET_PRIVACY_RELAY_REQUEST_TIMEOUT_MS = 3 * 60_000;
const WALLET_ACCOUNT_SILENT_REQUEST_TIMEOUT_MS = 2_000;
const WALLET_ACCOUNT_INTERACTIVE_REQUEST_TIMEOUT_MS = 60_000;

export async function warmUpStarknetPrivacyFunding(
  input: WarmUpStarknetPrivacyFundingInput
): Promise<WarmUpStarknetPrivacyFundingResult> {
  if (!input.paymasterUrl || !input.privacyProofSignerClassHash) {
    throw new Error("Private deposit signer warmup is not configured");
  }
  const rpcProvider = new RpcProvider({ nodeUrl: input.rpcUrl });
  const delayBlocks = Math.max(
    input.minProvingDelayBlocks,
    STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS
  );
  const account = await createEmbeddedPrivacyProofAccount({
    seedHex: input.seedHex,
    rpcProvider,
    paymasterUrl: input.paymasterUrl,
    privacyProofSignerClassHash: input.privacyProofSignerClassHash,
    minProvingDelayBlocks: delayBlocks,
  });
  const approvalTransactionHashes: string[] = [];
  for (const tokenAddress of [
    ...new Set(input.tokenAddresses.map(normalizeAddress).filter(Boolean)),
  ]) {
    const txHash = await ensureReusablePrivacyPoolApproval({
      rpcProvider,
      account,
      chainId: input.chainId,
      tokenAddress,
      privacyPoolAddress: input.privacyPoolAddress,
      paymasterUrl: input.paymasterUrl,
      allowanceThreshold: STARKNET_PRIVACY_REPLAY_GUARD_ATOMS,
    });
    if (txHash) {
      approvalTransactionHashes.push(txHash);
      await waitForStateAndProvingDelay(
        rpcProvider,
        () =>
          readTokenAllowance(
            rpcProvider,
            tokenAddress,
            account.address,
            input.privacyPoolAddress
          ).then(
            (allowance) => allowance >= STARKNET_PRIVACY_REPLAY_GUARD_ATOMS
          ),
        delayBlocks,
        "deposit session warmup approval"
      );
    }
  }
  return {
    signerAddress: account.address,
    approvalTransactionHashes,
  };
}

export async function submitPrivacyBridgeDeposit(
  input: SubmitPrivacyBridgeDepositInput
): Promise<SubmitPrivacyBridgeDepositResult> {
  const depositorAddress = await resolveConnectedStarknetAddress(
    input.provider
  );
  if (!depositorAddress) {
    throw new Error("Connect a Starknet wallet before depositing");
  }
  const sdkDepositAmount =
    input.plan.amount + STARKNET_PRIVACY_REPLAY_GUARD_ATOMS;
  return submitPrivacyBridgeDepositViaProver(input, sdkDepositAmount);
}

async function submitPrivacyBridgeDepositViaProver(
  input: SubmitPrivacyBridgeDepositInput,
  sdkDepositAmount: bigint
): Promise<SubmitPrivacyBridgeDepositResult> {
  const rpcProvider = new RpcProvider({ nodeUrl: input.rpcUrl });
  const txDelayBlocks = Math.max(
    input.minProvingDelayBlocks,
    STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS
  );
  const proofDelayScheduleBlocks = STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS;
  const account = await runFundingStage(
    "Private deposit signer setup failed",
    () =>
      createEmbeddedPrivacyProofAccount({
        seedHex: input.seedHex,
        rpcProvider,
        paymasterUrl: input.paymasterUrl,
        privacyProofSignerClassHash: input.privacyProofSignerClassHash,
        minProvingDelayBlocks: txDelayBlocks,
      })
  );
  const depositorAddress = await resolveConnectedStarknetAddress(
    input.provider
  );
  if (!depositorAddress) {
    throw new Error("Connect a Starknet wallet before depositing");
  }
  await runFundingStage("Private deposit funding setup failed", () =>
    ensureEmbeddedPrivacyAccountReady({
      provider: input.provider,
      rpcProvider,
      sourceOwner: depositorAddress,
      account,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      privacyPoolAddress: input.privacyPoolAddress,
      amount: sdkDepositAmount,
      paymasterUrl: input.paymasterUrl,
      minProvingDelayBlocks: txDelayBlocks,
    })
  );
  const discoveryProvider = new IndexerDiscoveryProvider(
    serviceBaseUrl(input.discoveryUrl),
    input.privacyPoolAddress
  );
  await runFundingStage("Private deposit service check failed", () =>
    requireHealthyDiscovery(discoveryProvider, input.discoveryUrl)
  );
  const sdkRegistry = input.sdkRegistry ?? createEmptyRegistry();
  return runProofDelayRetryLoop({
    proofDelayScheduleBlocks,
    retryStagePrefix: "Private deposit",
    fallbackErrorMessage: "Private deposit proof submission failed",
    classifier: {
      isProofBlockTooRecent,
      isProofExpired,
      isContractVisibilityLag: async (error) =>
        isProofProviderContractVisibilityLag(error) &&
        (await isClassDeployed(rpcProvider, input.privacyPoolAddress).catch(
          () => false
        )),
      isProviderBusy: isProofProviderServiceBusy,
      isProviderTransient: isProofProviderTransientNetworkError,
    },
    setStage: setFundingStage,
    runAttempt: async (proofDelayBlocks) => {
      const provingBlockId = await runFundingStage(
        "Private deposit proof setup failed",
        () => provingBlock(rpcProvider, proofDelayBlocks)
      );
      const execution = await runFundingStage(
        "Private deposit proof failed",
        () =>
          executeWithProvingTransportFallback({
            flow: "deposit",
            chainId: input.chainId,
            rpcUrl: input.rpcUrl,
            privacyPoolAddress: input.privacyPoolAddress,
            provingUrl: input.provingUrl,
            provingBlockId,
            provingOhttpEnabled: input.provingOhttpEnabled,
            execute: (provingProvider) => {
              const transfers = createPrivateTransfers({
                account: account as never,
                viewingKeyProvider: {
                  getViewingKey: async () => derivePrivacyViewingKey(input.seedHex),
                },
                provingProvider,
                discoveryProvider,
                poolContractAddress: input.privacyPoolAddress,
              });
              return transfers
                .build({
                autoRegister: true,
                autoSetup: true,
                autoDiscover: { notes: "refresh", channels: "refresh" },
                registry: sdkRegistry,
                registryConst: true,
                })
                .with(input.tokenAddress, (token) =>
                  token
                    .deposit({ amount: sdkDepositAmount })
                    .withdraw({
                      recipient: input.bridgeAddress,
                      amount: input.plan.amount,
                    })
                )
                .surplusTo(account.address)
                .invoke(({ withdrawals }) => {
                  const withdrawal = withdrawals.find(
                    (entry) =>
                      sameFelt(entry.recipient, input.bridgeAddress) &&
                      sameFelt(entry.token, input.tokenAddress) &&
                      entry.amount === input.plan.amount
                  );
                  if (!withdrawal) {
                    throw new Error(
                      "Private deposit bridge action was not built correctly"
                    );
                  }
                  return privacyBridgeDepositInvokeCall({
                    bridgeAddress: input.bridgeAddress,
                    plan: input.plan,
                  });
                })
                .execute({ provingBlockId });
            },
          })
      );
      assertNoSdkPrivacyWarnings(execution.warnings, "deposit");

      const transactionHash = await runFundingStage(
        "Private deposit submission failed",
        () =>
          submitProofBearingCall({
            signerAddress: account.address,
            chainId: input.chainId,
            paymasterAddress: input.paymasterAddress,
            paymasterUrl: input.paymasterUrl,
            callAndProof: execution.callAndProof,
          })
      );
      return {
        transactionHash,
        sdkRegistry: execution.registry,
      };
    },
  });
}

export async function submitPrivacyOpenNoteWithdrawal(
  input: SubmitPrivacyOpenNoteWithdrawalInput
): Promise<SubmitPrivacyOpenNoteWithdrawalResult> {
  const rpcProvider = new RpcProvider({ nodeUrl: input.rpcUrl });
  const txDelayBlocks = Math.max(
    input.minProvingDelayBlocks,
    STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS
  );
  const proofDelayScheduleBlocks = STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS;
  const account = await runFundingStage(
    "Private withdrawal signer setup failed",
    () =>
      createEmbeddedPrivacyProofAccount({
        seedHex: input.seedHex,
        rpcProvider,
        paymasterUrl: input.paymasterUrl,
        privacyProofSignerClassHash: input.privacyProofSignerClassHash,
        minProvingDelayBlocks: txDelayBlocks,
      })
  );
  const discoveryProvider = new IndexerDiscoveryProvider(
    serviceBaseUrl(input.discoveryUrl),
    input.privacyPoolAddress
  );
  await runFundingStage("Private withdrawal service check failed", () =>
    requireHealthyDiscovery(discoveryProvider, input.discoveryUrl)
  );
  const sdkRegistry = input.sdkRegistry ?? createEmptyRegistry();
  let claimedOpenNoteId = "";
  return runProofDelayRetryLoop({
    proofDelayScheduleBlocks,
    retryStagePrefix: "Private withdrawal",
    fallbackErrorMessage: "Private withdrawal proof submission failed",
    classifier: {
      isProofBlockTooRecent,
      isProofExpired,
      isContractVisibilityLag: async (error) =>
        isProofProviderContractVisibilityLag(error) &&
        (await isClassDeployed(rpcProvider, input.privacyPoolAddress).catch(
          () => false
        )),
      isProviderBusy: isProofProviderServiceBusy,
      isProviderTransient: isProofProviderTransientNetworkError,
    },
    setStage: setFundingStage,
    runAttempt: async (proofDelayBlocks) => {
      const provingBlockId = await runFundingStage(
        "Private withdrawal proof setup failed",
        () => provingBlock(rpcProvider, proofDelayBlocks)
      );
      const execution = await runFundingStage(
        "Private withdrawal proof failed",
        () =>
          executeWithProvingTransportFallback({
            flow: "withdrawal",
            chainId: input.chainId,
            rpcUrl: input.rpcUrl,
            privacyPoolAddress: input.privacyPoolAddress,
            provingUrl: input.provingUrl,
            provingBlockId,
            provingOhttpEnabled: input.provingOhttpEnabled,
            execute: (provingProvider) => {
              const transfers = createPrivateTransfers({
                account: account as never,
                viewingKeyProvider: {
                  getViewingKey: async () => derivePrivacyViewingKey(input.seedHex),
                },
                provingProvider,
                discoveryProvider,
                poolContractAddress: input.privacyPoolAddress,
              });
              return transfers
                .build({
                autoRegister: true,
                autoSetup: true,
                autoDiscover: { notes: "refresh", channels: "refresh" },
                registry: sdkRegistry,
                registryConst: true,
                })
                .with(input.tokenAddress, (token) =>
                  token.transfer({
                    recipient: account.address,
                    amount: Open,
                  })
                )
                .invoke(({ openNotes }) => {
                  const openNote = openNotes.find((entry) =>
                    sameFelt(entry.token, input.tokenAddress)
                  );
                  if (!openNote) {
                    throw new Error(
                      "Private withdrawal open note was not built correctly"
                    );
                  }
                  const openNoteId = normalizeAddress(openNote.noteId);
                  const signature = input.signExitClaim(openNoteId);
                  claimedOpenNoteId = openNoteId;
                  return privacyBridgeStrk20ExitClaimInvokeCall({
                    bridgeAddress: input.bridgeAddress,
                    exitCommitment: input.exitCommitment,
                    openNoteId,
                    signature,
                  });
                })
                .execute({ provingBlockId });
            },
          })
      );
      assertNoSdkPrivacyWarnings(execution.warnings, "withdrawal");

      const transactionHash = await runFundingStage(
        "Private withdrawal submission failed",
        () =>
          submitProofBearingCall({
            signerAddress: account.address,
            chainId: input.chainId,
            paymasterAddress: input.paymasterAddress,
            paymasterUrl: input.paymasterUrl,
            callAndProof: execution.callAndProof,
          })
      );
      return {
        transactionHash,
        openNoteId: claimedOpenNoteId,
        sdkRegistry: execution.registry,
      };
    },
  });
}

async function requireHealthyDiscovery(
  discoveryProvider: IndexerDiscoveryProvider,
  discoveryUrl: string
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await isDiscoveryHealthyWithFallback(discoveryProvider, discoveryUrl)) {
      return;
    }
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  throw new Error("Discovery service is not healthy");
}

export async function isDiscoveryHealthyWithFallback(
  discoveryProvider: Pick<IndexerDiscoveryProvider, "isHealthy">,
  discoveryUrl: string
): Promise<boolean> {
  if (await discoveryProvider.isHealthy().catch(() => false)) return true;
  try {
    const response = await fetchWithTimeout(
      `${serviceBaseUrl(discoveryUrl)}/health`,
      { headers: { accept: "application/json" } },
      20_000
    );
    if (!response.ok) return false;
    const body = (await readSdkJsonResponse(response, {
      timeoutMs: 5_000,
      label: "Discovery health response",
    }).catch(() => null)) as { status?: unknown } | null;
    return body?.status === "OK";
  } catch {
    return false;
  }
}

async function runFundingStage<T>(
  stage: string,
  operation: () => Promise<T>
): Promise<T> {
  const activity = stage.replace(/\s+failed$/i, "");
  setFundingStage(activity);
  try {
    const result = await operation();
    setFundingStage(`${activity}: complete`);
    return result;
  } catch (error) {
    setFundingStage(`${activity}: failed`);
    if (isUserRejected(error)) throw error;
    const wrapped = new Error(`${stage}: ${summarizeFundingError(error)}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

function assertNoSdkPrivacyWarnings(
  warnings: Warning[],
  flow: "deposit" | "withdrawal",
) {
  if (warnings.length === 0) return;
  throw new Error(
    `Private ${flow} privacy warning: ${summarizeSdkPrivacyWarnings(warnings)}`
  );
}

export function summarizeSdkPrivacyWarnings(warnings: Warning[]) {
  const codes = [
    ...new Set(
      warnings
        .map((warning) => String(warning.code ?? "").trim())
        .filter(Boolean)
    ),
  ];
  if (codes.length === 0) return "SDK_PRIVACY_WARNING";
  return codes.slice(0, 6).join(", ");
}

async function executeWithProvingTransportFallback<T>(input: {
  flow: "deposit" | "withdrawal";
  chainId: string;
  rpcUrl: string;
  privacyPoolAddress: string;
  provingUrl: string;
  provingBlockId: number;
  provingOhttpEnabled?: boolean;
  execute: (provingProvider: ProvingServiceProofProvider) => Promise<T>;
}): Promise<T> {
  return runProvingTransportAttempts({
    flow: input.flow,
    provingOhttpEnabled: input.provingOhttpEnabled,
    setStage: setFundingStage,
    run: (useOhttp) =>
      input.execute(
        createProvingProvider({
          chainId: input.chainId,
          rpcUrl: input.rpcUrl,
          privacyPoolAddress: input.privacyPoolAddress,
          provingUrl: input.provingUrl,
          provingBlockId: input.provingBlockId,
          provingOhttpEnabled: useOhttp,
        })
      ),
  });
}

export async function runProvingTransportAttempts<T>(input: {
  flow: "deposit" | "withdrawal";
  provingOhttpEnabled?: boolean;
  setStage: (stage: string) => void;
  run: (useOhttp: boolean) => Promise<T>;
}): Promise<T> {
  const runWithDeadline = (useOhttp: boolean, timeoutMs: number) =>
    withTimeout(
      input.run(useOhttp),
      timeoutMs,
      `Private ${input.flow} proof generation timed out before the proof service returned.`
    );

  if (input.provingOhttpEnabled !== true) {
    return runWithDeadline(false, STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS);
  }

  try {
    return await runWithDeadline(
      true,
      STARKNET_PRIVACY_OHTTP_EXECUTE_TIMEOUT_MS
    );
  } catch (error) {
    if (!shouldRetryDirectProvingTransport(error)) throw error;
    input.setStage(
      `Private ${input.flow} proof retrying over direct HTTPS transport`
    );
    return runWithDeadline(false, STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS);
  }
}

function createProvingProvider(input: {
  chainId: string;
  rpcUrl: string;
  privacyPoolAddress: string;
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
      poolAddress: input.privacyPoolAddress,
      ohttp: input.provingOhttpEnabled,
    }
  );
}

export function shouldRetryDirectProvingTransport(error: unknown) {
  const message = errorMessage(error);
  return (
    /proof generation timed out before the proof service returned/i.test(message) ||
    /ohttp|decapsulation|signal is aborted|aborted without reason|aborterror|timeouterror|operation was aborted|failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
      message
    )
  );
}

export function connectedWalletFundingShortfall(input: {
  tokenAddress: string;
  sourceBalance: bigint;
  transferAmount: bigint;
}): string | null {
  const feeReserve = sameFelt(input.tokenAddress, STARKNET_ETH_TOKEN_ADDRESS)
    ? CONNECTED_WALLET_ETH_FEE_RESERVE_ATOMS
    : 0n;
  if (input.sourceBalance < input.transferAmount) {
    return "Connected wallet balance is below the requested deposit plus one smallest token unit required for replay protection.";
  }
  if (
    feeReserve > 0n &&
    input.sourceBalance < input.transferAmount + feeReserve
  ) {
    return ETH_DEPOSIT_FEE_HEADROOM_ERROR;
  }
  return null;
}

export async function assertConnectedWalletAccountActivatedForDeposit(
  rpcProvider: StarknetClassHashReader,
  sourceOwner: string
): Promise<void> {
  const normalizedSourceOwner = normalizeAddress(sourceOwner);
  if (!normalizedSourceOwner) {
    throw new Error("Connected Starknet wallet returned an invalid account address");
  }
  if (!(await isClassDeployed(rpcProvider, normalizedSourceOwner))) {
    throw new Error(CONNECTED_WALLET_NOT_ACTIVATED_ERROR);
  }
}

async function ensureEmbeddedPrivacyAccountReady(input: {
  provider: StarknetProviderLike;
  rpcProvider: RpcProvider;
  sourceOwner: string;
  account: EmbeddedPrivacyProofAccount;
  chainId: string;
  tokenAddress: string;
  privacyPoolAddress: string;
  amount: bigint;
  paymasterUrl?: string;
  minProvingDelayBlocks: number;
}) {
  const balance = await withFundingSetupStep(
    "reading deposit session token balance",
    () =>
      readTokenBalance(
        input.rpcProvider,
        input.tokenAddress,
        input.account.address
      )
  );
  if (balance < input.amount) {
    const transferAmount = input.amount - balance;
    const activeSourceOwner = await withFundingSetupStep(
      "checking connected Starknet wallet",
      () => resolveConnectedStarknetAddress(input.provider)
    );
    if (!activeSourceOwner) {
      throw new Error("Connect a Starknet wallet before depositing");
    }
    if (activeSourceOwner !== normalizeAddress(input.sourceOwner)) {
      throw new Error("Connected Starknet wallet changed during deposit");
    }
    const sourceBalance = await withFundingSetupStep(
      "reading connected wallet token balance",
      () =>
        readTokenBalance(
          input.rpcProvider,
          input.tokenAddress,
          activeSourceOwner
        )
    );
    const fundingShortfall = connectedWalletFundingShortfall({
      tokenAddress: input.tokenAddress,
      sourceBalance,
      transferAmount,
    });
    if (fundingShortfall) throw new Error(fundingShortfall);
    await withFundingSetupStep("checking connected Starknet wallet activation", () =>
      assertConnectedWalletAccountActivatedForDeposit(
        input.rpcProvider,
        activeSourceOwner
      )
    );
    const transferCall: Call = {
      contractAddress: input.tokenAddress,
      entrypoint: "transfer",
      calldata: [input.account.address, ...u256Calldata(transferAmount)],
    };
    const result = await withFundingSetupStep(
      "funding deposit session from connected wallet",
      () =>
        withTimeout(
          executeWalletCall(input.provider, transferCall),
          STARKNET_PRIVACY_WALLET_EXECUTE_TIMEOUT_MS,
          "Wallet approval timed out before the connected Starknet wallet returned a transaction hash."
        )
    );
    const txHash = transactionHashFromResult(result);
    if (!txHash) {
      throw new Error(
        "Starknet wallet did not return a funding transaction hash"
      );
    }
    await withFundingSetupStep("waiting for deposit session funding", () =>
      waitForStateAndProvingDelay(
        input.rpcProvider,
        () =>
          readTokenBalance(
            input.rpcProvider,
            input.tokenAddress,
            input.account.address
          ).then((latestBalance) => latestBalance >= input.amount),
        input.minProvingDelayBlocks,
        "deposit session token balance"
      )
    );
  } else {
    const connected = await resolveConnectedStarknetAddress(input.provider);
    if (connected && connected !== normalizeAddress(input.sourceOwner)) {
      throw new Error("Connected Starknet wallet changed during deposit");
    }
  }

  const allowance = await withFundingSetupStep(
    "reading deposit session privacy-pool allowance",
    () =>
      readTokenAllowance(
        input.rpcProvider,
        input.tokenAddress,
        input.account.address,
        input.privacyPoolAddress
      )
  );
  if (allowance < input.amount) {
    const txHash = await ensureReusablePrivacyPoolApproval({
      rpcProvider: input.rpcProvider,
      account: input.account,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      privacyPoolAddress: input.privacyPoolAddress,
      paymasterUrl: input.paymasterUrl,
      allowanceThreshold: input.amount,
    });
    if (!txHash) {
      throw new Error(
        "Transaction relay did not return an approval transaction hash"
      );
    }
    await withFundingSetupStep("waiting for deposit session approval", () =>
      waitForStateAndProvingDelay(
        input.rpcProvider,
        () =>
          readTokenAllowance(
            input.rpcProvider,
            input.tokenAddress,
            input.account.address,
            input.privacyPoolAddress
          ).then((latestAllowance) => latestAllowance >= input.amount),
        input.minProvingDelayBlocks,
        "deposit session token allowance"
      )
    );
  }
}

async function ensureReusablePrivacyPoolApproval(input: {
  rpcProvider: RpcProvider;
  account: EmbeddedPrivacyProofAccount;
  chainId: string;
  tokenAddress: string;
  privacyPoolAddress: string;
  paymasterUrl?: string;
  allowanceThreshold: bigint;
}) {
  if (!input.paymasterUrl) {
    throw new Error(
      "Transaction relay is not configured for signer approval"
    );
  }
  const allowance = await readTokenAllowance(
    input.rpcProvider,
    input.tokenAddress,
    input.account.address,
    input.privacyPoolAddress
  );
  if (allowance >= input.allowanceThreshold) return null;
  const approveCall: Call = {
    contractAddress: input.tokenAddress,
    entrypoint: "approve",
    calldata: [
      input.privacyPoolAddress,
      ...u256Calldata(STARKNET_PRIVACY_REUSABLE_APPROVAL_AMOUNT),
    ],
  };
  const nonce = randomFelt();
  const relayHash = privacyProofSignerRelayHash(
    input.chainId,
    input.account.address,
    [approveCall],
    nonce
  );
  const signature = ec.starkCurve.sign(relayHash, input.account.privateKey);
  const json = await postFundingRelayJson<{
    transaction_hash?: string;
    transactionHash?: string;
  }>(
    paymasterPrivacySignerRelayUrl(input.paymasterUrl),
    {
      account_address: input.account.address,
      calls: [
        {
          contract_address: approveCall.contractAddress,
          entrypoint: approveCall.entrypoint,
          calldata: approveCall.calldata ?? [],
        },
      ],
      nonce,
      signature_r: `0x${signature.r.toString(16)}`,
      signature_s: `0x${signature.s.toString(16)}`,
    },
    "Transaction relay approval request timed out before returning a transaction hash"
  );
  const txHash = json.transaction_hash ?? json.transactionHash;
  if (!txHash) {
    throw new Error(
      "Transaction relay did not return an approval transaction hash"
    );
  }
  return txHash;
}

async function withFundingSetupStep<T>(
  step: string,
  operation: () => Promise<T>
): Promise<T> {
  setFundingStage(`setup: ${step}`);
  try {
    const result = await operation();
    setFundingStage(`setup: ${step}: complete`);
    return result;
  } catch (error) {
    setFundingStage(`setup: ${step}: failed`);
    const message = summarizeFundingError(error);
    const wrapped = new Error(`Failed while ${step}: ${message}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
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
      STARKNET_PRIVACY_RELAY_REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Runtime request timed out"
    ) {
      throw new Error(timeoutMessage);
    }
    if (isFundingRelayNetworkError(error)) {
      throw new Error("Private relay request failed. Check your connection and retry.");
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
    throw new Error(
      detail || `Private relay request failed with HTTP ${response.status}`
    );
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
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    /signal is aborted|aborted without reason|aborterror|timeouterror|operation was aborted|failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
      message
    )
  );
}

function setFundingStage(stage: string) {
  setPrivacyFundingStage(stage);
}

export async function executeWalletCall(provider: StarknetProviderLike, call: Call) {
  if (typeof provider.request !== "function") {
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
    const request = provider.request?.call(provider, {
      type: "wallet_addInvokeTransaction",
      params: { calls: [walletRequestCall] },
    });
    if (!request) return undefined;
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
    throw error instanceof Error
      ? error
      : new Error(
          "Selected Starknet wallet rejected the deposit transaction shape"
        );
  }
}

async function readTokenAllowance(
  provider: RpcProvider,
  tokenAddress: string,
  owner: string,
  spender: string
) {
  const result = await withRpcRetry(() =>
    provider.callContract({
      contractAddress: tokenAddress,
      entrypoint: "allowance",
      calldata: [owner, spender],
    })
  );
  return decodeU256(result);
}

async function readTokenBalance(
  provider: RpcProvider,
  tokenAddress: string,
  owner: string
) {
  const result = await withRpcRetry(() =>
    provider.callContract({
      contractAddress: tokenAddress,
      entrypoint: "balance_of",
      calldata: [owner],
    })
  );
  return decodeU256(result);
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

async function submitProofBearingCall(input: {
  signerAddress: string;
  chainId: string;
  paymasterAddress?: string;
  paymasterUrl?: string;
  callAndProof: CallAndProof;
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
      relay_nonce: randomFelt(),
      proof: proofDetails.proof,
      proof_facts: proofDetails.proofFacts,
    },
    "Transaction relay request timed out before returning a transaction hash"
  );
  const hash = json.transaction_hash ?? json.transactionHash;
  if (!hash) throw new Error("Transaction relay did not return a transaction hash");
  return hash;
}

type EmbeddedPrivacyProofAccount = {
  address: string;
  signer: Signer;
  privateKey: string;
};

async function createEmbeddedPrivacyProofAccount(input: {
  seedHex: string;
  rpcProvider: RpcProvider;
  paymasterUrl?: string;
  privacyProofSignerClassHash?: string;
  minProvingDelayBlocks: number;
}): Promise<EmbeddedPrivacyProofAccount> {
  if (!input.privacyProofSignerClassHash) {
    throw new Error("Private deposit signer deployment is not configured");
  }
  if (!input.paymasterUrl) {
    throw new Error("Transaction relay is not configured for signer setup");
  }
  const privateKey = await derivePrivacyProofSignerPrivateKey(input.seedHex);
  const signer = new Signer(privateKey);
  const publicKey = normalizeAddress(await signer.getPubKey());
  const salt = await derivePrivacyProofSignerSalt(input.seedHex);
  const existingAddress = await ensurePrivacyProofSignerContract({
    paymasterUrl: input.paymasterUrl,
    signerPublicKey: publicKey,
    salt,
    classHash: input.privacyProofSignerClassHash,
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
  paymasterUrl: string;
  signerPublicKey: string;
  salt: string;
  classHash: string;
  rpcProvider: RpcProvider;
  minProvingDelayBlocks: number;
}) {
  const json = await postFundingRelayJson<{
    contract_address?: string;
    deployed?: boolean;
    transaction_hash?: string;
  }>(
    paymasterPrivacySignerEnsureUrl(input.paymasterUrl),
    {
      signer_public_key: input.signerPublicKey,
      salt: input.salt,
      class_hash: input.classHash,
    },
    "Transaction relay signer setup timed out before returning a signer address"
  );
  const address = normalizeAddress(json.contract_address);
  if (!address) {
    throw new Error("Transaction relay did not return a proof signer address");
  }
  if (json.deployed) {
    await waitForStateAndProvingDelay(
      input.rpcProvider,
      () => isClassDeployed(input.rpcProvider, address),
      input.minProvingDelayBlocks,
      "embedded proof signer deployment"
    );
  }
  return address;
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

function decodeU256(values: unknown[]) {
  const low = BigInt(String(values[0] ?? "0"));
  const high = BigInt(String(values[1] ?? "0"));
  return low + (high << 128n);
}

function u256Calldata(value: bigint) {
  const low = value & ((1n << 128n) - 1n);
  const high = value >> 128n;
  return [`0x${low.toString(16)}`, `0x${high.toString(16)}`];
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

async function isClassDeployed(provider: StarknetClassHashReader, contractAddress: string) {
  const preConfirmed = await provider
    .getClassHashAt(contractAddress, "pre_confirmed")
    .catch(() => null);
  const classHash =
    preConfirmed ??
    (await provider.getClassHashAt(contractAddress, "latest").catch(() => null));
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
  const bytes = new Uint8Array(30);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `0x${hex || "0"}`;
}

function privacyProofSignerRelayHash(
  chainId: string,
  signerAddress: string,
  calls: Call[],
  nonce: string
) {
  let state = hash.computePoseidonHash(
    shortStringToFelt("zylith_privacy_relay_v1"),
    starknetPrivacySdkChainId(chainId)
  );
  state = hash.computePoseidonHash(state, signerAddress);
  state = hash.computePoseidonHash(state, nonce);
  state = hash.computePoseidonHash(state, calls.length);
  for (const call of calls) {
    state = hash.computePoseidonHash(state, call.contractAddress);
    state = hash.computePoseidonHash(
      state,
      hash.getSelectorFromName(call.entrypoint)
    );
    const calldata = Array.isArray(call.calldata)
      ? call.calldata.map(String)
      : [];
    state = hash.computePoseidonHash(state, calldata.length);
    for (const value of calldata) {
      state = hash.computePoseidonHash(state, value);
    }
  }
  return state;
}

function shortStringToFelt(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > 31) {
    throw new Error("Short string is too long for a felt");
  }
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `0x${hex || "0"}`;
}

export function starknetPrivacySdkChainId(chainId: string): constants.StarknetChainId {
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
  return (
    addressFromUnknown(record.address) ??
    addressFromUnknown(record.selectedAddress) ??
    addressFromUnknown(record.account) ??
    addressFromUnknown(record.accounts)
  );
}

function connectedStarknetAddress(provider: StarknetProviderLike) {
  return normalizeAddress(
    provider.account?.address ??
      provider.selectedAddress ??
      addressFromUnknown(provider.accounts)
  );
}

async function resolveConnectedStarknetAddress(provider: StarknetProviderLike) {
  const requested = await requestWalletAccounts(provider, true).catch(
    () => null
  );
  if (requested) return normalizeAddress(requested);
  const current = connectedStarknetAddress(provider);
  if (current) return current;
  const interactive = await requestWalletAccounts(provider, false);
  return normalizeAddress(interactive);
}

async function requestWalletAccounts(
  provider: StarknetProviderLike,
  silent: boolean
) {
  if (!provider.request) return null;
  const attempts = [
    { type: "wallet_requestAccounts", params: { silent_mode: silent } },
  ];
  for (const request of attempts) {
    const result = await withWalletAccountRequestTimeout(
      provider.request.call(provider, request),
      silent
        ? WALLET_ACCOUNT_SILENT_REQUEST_TIMEOUT_MS
        : WALLET_ACCOUNT_INTERACTIVE_REQUEST_TIMEOUT_MS
    ).catch((error) => {
      if (isUserRejected(error) || isWalletAccountRequestTimeout(error)) {
        throw error;
      }
      return null;
    });
    const address = addressFromUnknown(result);
    if (address) return address;
  }
  return null;
}

async function withWalletAccountRequestTimeout<T>(
  request: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new Error(
            "Starknet wallet request timed out. Unlock your wallet and retry."
          )
        ),
      timeoutMs
    );
  });
  try {
    return await Promise.race([request, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isWalletAccountRequestTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Starknet wallet request timed out/i.test(error.message)
  );
}

async function derivePrivacyViewingKey(seedHex: string) {
  const digest = await sha256SeedDomain(
    "zylith/starknet-privacy/viewing-key/",
    seedHex
  );
  try {
    return (BigInt(`0x${bytesToHex(digest)}`) % (MAX_VIEWING_KEY - 1n)) + 1n;
  } finally {
    digest.fill(0);
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
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
