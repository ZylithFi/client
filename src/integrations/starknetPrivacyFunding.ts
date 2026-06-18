import {
  createEmptyRegistry,
  createPrivateTransfers,
  IndexerDiscoveryProvider,
  MAX_VIEWING_KEY,
  Open,
  ProvingServiceProofProvider,
  type CallAndProof,
  type PrivateRegistry,
  type Warning,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  RpcProvider,
  Signer,
  constants,
  ec,
  hash,
  type Call,
} from "starknet";
import {
  ETH_DEPOSIT_FEE_HEADROOM_ERROR,
} from "../domain/privateDepositErrors";
import {
  errorMessage,
  isProofBlockTooRecent,
  isProofProviderContractVisibilityLag,
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
    execute?: (calls: Call | Call[], details?: Record<string, unknown>) => Promise<unknown>;
  };
  selectedAddress?: string;
  accounts?: unknown;
  request?: (request: { type?: string; method?: string; params?: unknown }) => Promise<unknown>;
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

const STARK_FIELD_PRIME =
  3618502788666131213697322783095070105623107215331596699973092056135872020481n;
const STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS = 10;
export const STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS = [10, 16, 24, 32, 48] as const;
const STARKNET_PRIVACY_REPLAY_GUARD_ATOMS = 1n;
const STARKNET_ETH_TOKEN_ADDRESS = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
export const CONNECTED_WALLET_ETH_FEE_RESERVE_ATOMS = 5_000_000_000_000n;
const STARKNET_PRIVACY_REUSABLE_APPROVAL_AMOUNT = (1n << 128n) - 1n;
const STARKNET_PRIVACY_SETUP_READY_TIMEOUT_MS = 180_000;
const STARKNET_PRIVACY_SETUP_READY_POLL_MS = 3_000;
const STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS = 8 * 60_000;
const STARKNET_PRIVACY_WALLET_EXECUTE_TIMEOUT_MS = 3 * 60_000;

export async function warmUpStarknetPrivacyFunding(
  input: WarmUpStarknetPrivacyFundingInput,
): Promise<WarmUpStarknetPrivacyFundingResult> {
  if (!input.paymasterUrl || !input.privacyProofSignerClassHash) {
    throw new Error("Private deposit signer warmup is not configured");
  }
  const rpcProvider = new RpcProvider({ nodeUrl: input.rpcUrl });
  const delayBlocks = Math.max(
    input.minProvingDelayBlocks,
    STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS,
  );
  const account = await createEmbeddedPrivacyProofAccount({
    seedHex: input.seedHex,
    rpcProvider,
    paymasterUrl: input.paymasterUrl,
    privacyProofSignerClassHash: input.privacyProofSignerClassHash,
    minProvingDelayBlocks: delayBlocks,
  });
  const approvalTransactionHashes: string[] = [];
  for (const tokenAddress of [...new Set(input.tokenAddresses.map(normalizeAddress).filter(Boolean))]) {
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
            input.privacyPoolAddress,
          ).then((allowance) => allowance >= STARKNET_PRIVACY_REPLAY_GUARD_ATOMS),
        delayBlocks,
        "embedded signer warmup approval",
      );
    }
  }
  return {
    signerAddress: account.address,
    approvalTransactionHashes,
  };
}

export async function submitPrivacyBridgeDeposit(
  input: SubmitPrivacyBridgeDepositInput,
): Promise<SubmitPrivacyBridgeDepositResult> {
  const depositorAddress = await resolveConnectedStarknetAddress(input.provider);
  if (!depositorAddress) {
    throw new Error("Connect a Starknet wallet before depositing");
  }
  const rpcProvider = new RpcProvider({ nodeUrl: input.rpcUrl });
  const txDelayBlocks = Math.max(
    input.minProvingDelayBlocks,
    STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS,
  );
  const proofDelayScheduleBlocks = STARKNET_PRIVACY_PROOF_DELAY_SCHEDULE_BLOCKS;
  const sdkDepositAmount = input.plan.amount + STARKNET_PRIVACY_REPLAY_GUARD_ATOMS;
  const account = await runFundingStage(
    "Private deposit signer setup failed",
    () =>
      createEmbeddedPrivacyProofAccount({
        seedHex: input.seedHex,
        rpcProvider,
        paymasterUrl: input.paymasterUrl,
        privacyProofSignerClassHash: input.privacyProofSignerClassHash,
        minProvingDelayBlocks: txDelayBlocks,
      }),
  );
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
    input.privacyPoolAddress,
  );
  await runFundingStage("Private deposit service check failed", () =>
    requireHealthyDiscovery(discoveryProvider)
  );
  const sdkRegistry = input.sdkRegistry ?? createEmptyRegistry();
  return runProofDelayRetryLoop({
    proofDelayScheduleBlocks,
    retryStagePrefix: "Private deposit",
    fallbackErrorMessage: "Private deposit proof submission failed",
    classifier: {
      isProofBlockTooRecent,
      isContractVisibilityLag: async (error) =>
        isProofProviderContractVisibilityLag(error) &&
        await isClassDeployed(rpcProvider, input.privacyPoolAddress).catch(() => false),
    },
    setStage: setFundingStage,
    runAttempt: async (proofDelayBlocks) => {
      const provingBlockId = await runFundingStage(
        "Private deposit proof setup failed",
        () => provingBlock(rpcProvider, proofDelayBlocks),
      );
      const provingProvider = new ProvingServiceProofProvider(
        serviceBaseUrl(input.provingUrl),
        sdkChainId(input.chainId),
        {
          blockIdentifier: provingBlockId,
          requestTimeoutMs: 240_000,
          nodeUrl: input.rpcUrl,
          poolAddress: input.privacyPoolAddress,
        },
      );
      const transfers = createPrivateTransfers({
        account: account as never,
        viewingKeyProvider: {
          getViewingKey: async () => derivePrivacyViewingKey(input.seedHex),
        },
        provingProvider,
        discoveryProvider,
        poolContractAddress: input.privacyPoolAddress,
      });
      const execution = await runFundingStage(
        "Private deposit proof failed",
        () =>
          withTimeout(
            transfers
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
                  .withdraw({ recipient: input.bridgeAddress, amount: input.plan.amount })
              )
              .surplusTo(account.address)
              .invoke(({ withdrawals }) => {
                const withdrawal = withdrawals.find((entry) =>
                  sameFelt(entry.recipient, input.bridgeAddress) &&
                  sameFelt(entry.token, input.tokenAddress) &&
                  entry.amount === input.plan.amount
                );
                if (!withdrawal) {
                  throw new Error("Private deposit bridge action was not built correctly");
                }
                return privacyBridgeDepositInvokeCall({
                  bridgeAddress: input.bridgeAddress,
                  plan: input.plan,
                });
              })
              .execute({ provingBlockId }),
            STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS,
            "Private deposit proof generation timed out before the proof service returned.",
          ),
      );
      assertNoSdkPrivacyWarnings(execution.warnings);

      const transactionHash = await runFundingStage(
        "Private deposit submission failed",
        () =>
          submitProofBearingCall({
            signerAddress: account.address,
            chainId: input.chainId,
            paymasterAddress: input.paymasterAddress,
            paymasterUrl: input.paymasterUrl,
            callAndProof: execution.callAndProof,
          }),
      );
      return {
        transactionHash,
        sdkRegistry: execution.registry,
      };
    },
  });
}

export async function submitPrivacyOpenNoteWithdrawal(
  input: SubmitPrivacyOpenNoteWithdrawalInput,
): Promise<SubmitPrivacyOpenNoteWithdrawalResult> {
  const rpcProvider = new RpcProvider({ nodeUrl: input.rpcUrl });
  const txDelayBlocks = Math.max(
    input.minProvingDelayBlocks,
    STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS,
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
      }),
  );
  const discoveryProvider = new IndexerDiscoveryProvider(
    serviceBaseUrl(input.discoveryUrl),
    input.privacyPoolAddress,
  );
  await runFundingStage("Private withdrawal service check failed", () =>
    requireHealthyDiscovery(discoveryProvider)
  );
  const sdkRegistry = input.sdkRegistry ?? createEmptyRegistry();
  let claimedOpenNoteId = "";
  return runProofDelayRetryLoop({
    proofDelayScheduleBlocks,
    retryStagePrefix: "Private withdrawal",
    fallbackErrorMessage: "Private withdrawal proof submission failed",
    classifier: {
      isProofBlockTooRecent,
      isContractVisibilityLag: async (error) =>
        isProofProviderContractVisibilityLag(error) &&
        await isClassDeployed(rpcProvider, input.privacyPoolAddress).catch(() => false),
    },
    setStage: setFundingStage,
    runAttempt: async (proofDelayBlocks) => {
      const provingBlockId = await runFundingStage(
        "Private withdrawal proof setup failed",
        () => provingBlock(rpcProvider, proofDelayBlocks),
      );
      const provingProvider = new ProvingServiceProofProvider(
        serviceBaseUrl(input.provingUrl),
        sdkChainId(input.chainId),
        {
          blockIdentifier: provingBlockId,
          requestTimeoutMs: 240_000,
          nodeUrl: input.rpcUrl,
          poolAddress: input.privacyPoolAddress,
        },
      );
      const transfers = createPrivateTransfers({
        account: account as never,
        viewingKeyProvider: {
          getViewingKey: async () => derivePrivacyViewingKey(input.seedHex),
        },
        provingProvider,
        discoveryProvider,
        poolContractAddress: input.privacyPoolAddress,
      });
      const execution = await runFundingStage(
        "Private withdrawal proof failed",
        () =>
          withTimeout(
            transfers
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
                  throw new Error("Private withdrawal open note was not built correctly");
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
              .execute({ provingBlockId }),
            STARKNET_PRIVACY_SDK_EXECUTE_TIMEOUT_MS,
            "Private withdrawal proof generation timed out before the proof service returned.",
          ),
      );
      assertNoSdkPrivacyWarnings(execution.warnings);

      const transactionHash = await runFundingStage(
        "Private withdrawal submission failed",
        () =>
          submitProofBearingCall({
            signerAddress: account.address,
            chainId: input.chainId,
            paymasterAddress: input.paymasterAddress,
            paymasterUrl: input.paymasterUrl,
            callAndProof: execution.callAndProof,
          }),
      );
      return {
        transactionHash,
        openNoteId: claimedOpenNoteId,
        sdkRegistry: execution.registry,
      };
    },
  });
}

async function requireHealthyDiscovery(discoveryProvider: IndexerDiscoveryProvider) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await discoveryProvider.isHealthy().catch(() => false)) return;
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  throw new Error("Discovery service is not healthy");
}

async function runFundingStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  // Stage constants are failure-phrased for error prefixes ("… setup failed");
  // show the neutral activity in the live progress label so users never see
  // "… failed: complete" while a step is merely running or done.
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

function assertNoSdkPrivacyWarnings(warnings: Warning[]) {
  if (warnings.length === 0) return;
  const detail = warnings
    .map((warning) => `${warning.code}: ${warning.message}`)
    .join("; ");
  throw new Error(`Private deposit privacy warning: ${detail}`);
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
  if (feeReserve > 0n && input.sourceBalance < input.transferAmount + feeReserve) {
    return ETH_DEPOSIT_FEE_HEADROOM_ERROR;
  }
  return null;
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
  const balance = await withFundingSetupStep("reading embedded signer token balance", () =>
    readTokenBalance(
      input.rpcProvider,
      input.tokenAddress,
      input.account.address,
    )
  );
  if (balance < input.amount) {
    const transferAmount = input.amount - balance;
    const activeSourceOwner = await withFundingSetupStep("checking connected Starknet wallet", () =>
      resolveConnectedStarknetAddress(input.provider)
    );
    if (!activeSourceOwner) {
      throw new Error("Connect a Starknet wallet before depositing");
    }
    if (activeSourceOwner !== normalizeAddress(input.sourceOwner)) {
      throw new Error("Connected Starknet wallet changed during deposit");
    }
    const sourceBalance = await withFundingSetupStep("reading connected wallet token balance", () =>
      readTokenBalance(
        input.rpcProvider,
        input.tokenAddress,
        activeSourceOwner,
      )
    );
    const fundingShortfall = connectedWalletFundingShortfall({
      tokenAddress: input.tokenAddress,
      sourceBalance,
      transferAmount,
    });
    if (fundingShortfall) throw new Error(fundingShortfall);
    const transferCall: Call = {
      contractAddress: input.tokenAddress,
      entrypoint: "transfer",
      calldata: [input.account.address, ...u256Calldata(transferAmount)],
    };
    const result = await withFundingSetupStep("funding embedded signer from connected wallet", () =>
      withTimeout(
        executeWalletCall(input.provider, transferCall),
        STARKNET_PRIVACY_WALLET_EXECUTE_TIMEOUT_MS,
        "Wallet approval timed out before the connected Starknet wallet returned a transaction hash.",
      )
    );
    const txHash = transactionHashFromResult(result);
    if (!txHash) {
      throw new Error("Starknet wallet did not return a funding transaction hash");
    }
    await withFundingSetupStep(
      "waiting for embedded signer funding",
      () =>
        waitForStateAndProvingDelay(
          input.rpcProvider,
          () =>
            readTokenBalance(
              input.rpcProvider,
              input.tokenAddress,
              input.account.address,
            ).then((latestBalance) => latestBalance >= input.amount),
          input.minProvingDelayBlocks,
          "embedded signer token balance",
        ),
    );
  } else {
    // Ensure the connected wallet is still the intended funding source before proving.
    const connected = await resolveConnectedStarknetAddress(input.provider);
    if (connected && connected !== normalizeAddress(input.sourceOwner)) {
      throw new Error("Connected Starknet wallet changed during deposit");
    }
  }

  const allowance = await withFundingSetupStep("reading embedded signer privacy-pool allowance", () =>
    readTokenAllowance(
      input.rpcProvider,
      input.tokenAddress,
      input.account.address,
      input.privacyPoolAddress,
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
      throw new Error("Deposit relay did not return an approval transaction hash");
    }
    await withFundingSetupStep(
      "waiting for embedded signer approval",
      () =>
        waitForStateAndProvingDelay(
          input.rpcProvider,
          () =>
            readTokenAllowance(
              input.rpcProvider,
              input.tokenAddress,
              input.account.address,
              input.privacyPoolAddress,
            ).then((latestAllowance) => latestAllowance >= input.amount),
          input.minProvingDelayBlocks,
          "embedded signer token allowance",
        ),
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
    throw new Error("Private deposit relay is not configured for signer approval");
  }
  const allowance = await readTokenAllowance(
    input.rpcProvider,
    input.tokenAddress,
    input.account.address,
    input.privacyPoolAddress,
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
    nonce,
  );
  const signature = ec.starkCurve.sign(relayHash, input.account.privateKey);
  const response = await fetch(paymasterPrivacySignerRelayUrl(input.paymasterUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      account_address: input.account.address,
      calls: [{
        contract_address: approveCall.contractAddress,
        entrypoint: approveCall.entrypoint,
        calldata: approveCall.calldata ?? [],
      }],
      nonce,
      signature_r: `0x${signature.r.toString(16)}`,
      signature_s: `0x${signature.s.toString(16)}`,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Deposit relay rejected signer approval with HTTP ${response.status}`);
  }
  const json = await response.json() as { transaction_hash?: string; transactionHash?: string };
  const txHash = json.transaction_hash ?? json.transactionHash;
  if (!txHash) {
    throw new Error("Deposit relay did not return an approval transaction hash");
  }
  return txHash;
}

async function withFundingSetupStep<T>(step: string, operation: () => Promise<T>): Promise<T> {
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

function setFundingStage(stage: string) {
  try {
    (globalThis as typeof globalThis & {
      __zylithPrivacyFundingStage?: { stage: string; at: number };
    }).__zylithPrivacyFundingStage = { stage, at: Date.now() };
  } catch {
    // Best-effort diagnostic state only.
  }
}

async function executeWalletCall(provider: StarknetProviderLike, call: Call) {
  if (typeof provider.account?.execute === "function") {
    try {
      return await provider.account.execute.call(provider.account, [call]);
    } catch (error) {
      if (isUserRejected(error)) throw error;
      if (!isWalletCallShapeError(error)) throw error;
      return provider.account.execute.call(provider.account, call);
    }
  }
  if (typeof provider.request === "function") {
    try {
      const result = await requestWalletInvoke(provider, call);
      if (result !== undefined) return result;
    } catch (error) {
      if (
        isUserRejected(error) ||
        (!isWalletCallShapeError(error) && !isWalletRequestUnavailableError(error))
      ) {
        throw error;
      }
    }
  }
  throw new Error("Selected Starknet wallet cannot approve private deposits");
}

async function requestWalletInvoke(provider: StarknetProviderLike, call: Call) {
  const walletRequestCall = {
    contract_address: call.contractAddress,
    entry_point: call.entrypoint,
    calldata: call.calldata ?? [],
  };
  const accountCall = {
    contractAddress: call.contractAddress,
    entrypoint: call.entrypoint,
    calldata: call.calldata ?? [],
  };
  const attempts = [
    { type: "wallet_addInvokeTransaction", params: { calls: [walletRequestCall] } },
    { type: "wallet_addInvokeTransaction", params: { calls: [accountCall] } },
    { method: "wallet_addInvokeTransaction", params: [{ calls: [walletRequestCall] }] },
    { method: "wallet_addInvokeTransaction", params: [{ calls: [accountCall] }] },
  ];
  let lastError: unknown = null;
  for (const request of attempts) {
    try {
      return await provider.request?.(request);
    } catch (error) {
      lastError = error;
      if (isUserRejected(error)) throw error;
      if (!isWalletCallShapeError(error) && !isWalletRequestUnavailableError(error)) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Selected Starknet wallet rejected the deposit transaction shape");
}

async function readTokenAllowance(
  provider: RpcProvider,
  tokenAddress: string,
  owner: string,
  spender: string,
) {
  const result = await withRpcRetry(() => provider.callContract({
    contractAddress: tokenAddress,
    entrypoint: "allowance",
    calldata: [owner, spender],
  }));
  return decodeU256(result);
}

async function readTokenBalance(
  provider: RpcProvider,
  tokenAddress: string,
  owner: string,
) {
  const result = await withRpcRetry(() => provider.callContract({
    contractAddress: tokenAddress,
    entrypoint: "balance_of",
    calldata: [owner],
  }));
  return decodeU256(result);
}

async function withRpcRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
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
    throw new Error(
      "Private deposit relay is not configured.",
    );
  }
  const response = await fetch(paymasterExecuteUrl(input.paymasterUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
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
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Deposit relay rejected the transaction with HTTP ${response.status}`);
  }
  const json = await response.json() as { transaction_hash?: string; transactionHash?: string };
  const hash = json.transaction_hash ?? json.transactionHash;
  if (!hash) throw new Error("Deposit relay did not return a transaction hash");
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
    throw new Error("Private deposit relay is not configured for signer setup");
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
  const response = await fetch(paymasterPrivacySignerEnsureUrl(input.paymasterUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      signer_public_key: input.signerPublicKey,
      salt: input.salt,
      class_hash: input.classHash,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Deposit relay rejected signer setup with HTTP ${response.status}`);
  }
  const json = await response.json() as {
    contract_address?: string;
    deployed?: boolean;
    transaction_hash?: string;
  };
  const address = normalizeAddress(json.contract_address);
  if (!address) {
    throw new Error("Deposit relay did not return a proof signer address");
  }
  if (json.deployed) {
    await waitForStateAndProvingDelay(
      input.rpcProvider,
      () => isClassDeployed(input.rpcProvider, address),
      input.minProvingDelayBlocks,
      "embedded proof signer deployment",
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
  label: string,
) {
  const deadline = Date.now() + STARKNET_PRIVACY_SETUP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isReady().catch(() => false)) {
      const visibleBlock = await provider.getBlockNumber().catch(() => null);
      if (visibleBlock === null) {
        await new Promise((resolve) =>
          setTimeout(resolve, STARKNET_PRIVACY_SETUP_READY_POLL_MS));
        continue;
      }
      await waitForBlock(
        provider,
        visibleBlock + Math.max(0, minProvingDelayBlocks),
        deadline,
        label,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, STARKNET_PRIVACY_SETUP_READY_POLL_MS));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function isClassDeployed(provider: RpcProvider, contractAddress: string) {
  return (
    await provider.getClassHashAt(contractAddress, "pre_confirmed").catch(() => null)
  ) ?? (
    await provider.getClassHashAt(contractAddress, "latest").catch(() => null)
  )
    ? true
    : false;
}

async function waitForBlock(
  provider: RpcProvider,
  targetBlock: number,
  deadline: number,
  label: string,
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
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `0x${hex || "0"}`;
}

function privacyProofSignerRelayHash(
  chainId: string,
  signerAddress: string,
  calls: Call[],
  nonce: string,
) {
  let state = hash.computePoseidonHash(
    shortStringToFelt("zylith_privacy_relay_v1"),
    sdkChainId(chainId),
  );
  state = hash.computePoseidonHash(state, signerAddress);
  state = hash.computePoseidonHash(state, nonce);
  state = hash.computePoseidonHash(state, calls.length);
  for (const call of calls) {
    state = hash.computePoseidonHash(state, call.contractAddress);
    state = hash.computePoseidonHash(state, hash.getSelectorFromName(call.entrypoint));
    const calldata = Array.isArray(call.calldata) ? call.calldata.map(String) : [];
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
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `0x${hex || "0"}`;
}

function sdkChainId(chainId: string): constants.StarknetChainId {
  const normalized = chainId.trim().toLowerCase();
  if (normalized === "sn_sepolia" || normalized === "0x534e5f5345504f4c4941") {
    return constants.StarknetChainId.SN_SEPOLIA;
  }
  if (normalized === "sn_main" || normalized === "0x534e5f4d41494e") {
    return constants.StarknetChainId.SN_MAIN;
  }
  return chainId as constants.StarknetChainId;
}

function sameFelt(left: unknown, right: unknown) {
  return normalizeAddress(left) === normalizeAddress(right);
}

function normalizeAddress(value: unknown) {
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (typeof value === "number") return `0x${BigInt(value).toString(16)}`;
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const raw = trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? trimmed.slice(2)
    : trimmed;
  return `0x${raw.replace(/^0+/, "").toLowerCase() || "0"}`;
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
  return addressFromUnknown(record.address)
    ?? addressFromUnknown(record.selectedAddress)
    ?? addressFromUnknown(record.account)
    ?? addressFromUnknown(record.accounts);
}

function connectedStarknetAddress(provider: StarknetProviderLike) {
  return normalizeAddress(
    provider.account?.address ?? provider.selectedAddress ?? addressFromUnknown(provider.accounts),
  );
}

async function resolveConnectedStarknetAddress(provider: StarknetProviderLike) {
  const requested = await requestWalletAccounts(provider, true)
    .catch(() => null);
  if (requested) return normalizeAddress(requested);
  const current = connectedStarknetAddress(provider);
  if (current) return current;
  const interactive = await requestWalletAccounts(provider, false).catch(() => null);
  return normalizeAddress(interactive);
}

async function requestWalletAccounts(provider: StarknetProviderLike, silent: boolean) {
  if (!provider.request) return null;
  const attempts = [
    { type: "wallet_requestAccounts", params: { silent_mode: silent } },
    { type: "wallet_requestAccounts", params: { silentMode: silent } },
    { method: "wallet_requestAccounts", params: [{ silent_mode: silent }] },
    ...(silent
      ? []
      : [
          { method: "wallet_requestAccounts", params: [] },
          { method: "starknet_requestAccounts", params: [] },
        ]),
  ];
  for (const request of attempts) {
    const result = await provider.request(request).catch((error) => {
      if (isUserRejected(error)) throw error;
      return null;
    });
    const address = addressFromUnknown(result);
    if (address) return address;
  }
  return null;
}

async function derivePrivacyViewingKey(seedHex: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`zylith/starknet-privacy/viewing-key/${seedHex}`),
  );
  const hex = Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return (BigInt(`0x${hex}`) % (MAX_VIEWING_KEY - 1n)) + 1n;
}

async function derivePrivacyProofSignerPrivateKey(seedHex: string) {
  const value = await deriveFeltFromSeed(seedHex, "proof-signer", ec.starkCurve.CURVE.n);
  return `0x${value.toString(16)}`;
}

async function derivePrivacyProofSignerSalt(seedHex: string) {
  const value = await deriveFeltFromSeed(seedHex, "proof-signer-salt", STARK_FIELD_PRIME);
  return `0x${value.toString(16)}`;
}

async function deriveFeltFromSeed(seedHex: string, label: string, modulus: bigint) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`zylith/starknet-privacy/${label}/${seedHex}`),
  );
  const hex = Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return (BigInt(`0x${hex}`) % (modulus - 1n)) + 1n;
}
