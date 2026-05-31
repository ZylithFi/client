import {
  createEmptyRegistry,
  createPrivateTransfers,
  IndexerDiscoveryProvider,
  MAX_VIEWING_KEY,
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
    asset_id: string;
    total_amount: string;
    amounts: string[];
    deposit_nonces: string[];
    note_commitments: string[];
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

export function privacyBridgeDepositCalldata(plan: PrivacyBridgeDepositPlan) {
  return [
    plan.encodedArgs.asset_id,
    plan.encodedArgs.total_amount,
    plan.encodedArgs.amounts,
    plan.encodedArgs.deposit_nonces,
    plan.encodedArgs.note_commitments,
    plan.encodedArgs.withdraw_authorities,
  ];
}

const STARK_FIELD_PRIME =
  3618502788666131213697322783095070105623107215331596699973092056135872020481n;
const STARKNET_PRIVACY_MIN_TX_DELAY_BLOCKS = 10;
const STARKNET_PRIVACY_ADAPTIVE_PROOF_DELAY_START_BLOCKS = 8;
const STARKNET_PRIVACY_PROOF_DELAY_RETRY_BLOCKS = 8;
const STARKNET_PRIVACY_PROOF_RETRY_ATTEMPTS = 3;
const STARKNET_PRIVACY_REPLAY_GUARD_ATOMS = 1n;
const STARKNET_PRIVACY_REUSABLE_APPROVAL_AMOUNT = (1n << 128n) - 1n;

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
    if (txHash) approvalTransactionHashes.push(txHash);
  }
  if (approvalTransactionHashes.length > 0) {
    await waitForTransactionsAndProvingDelay(rpcProvider, approvalTransactionHashes, delayBlocks);
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
  const baseProofDelayBlocks = STARKNET_PRIVACY_ADAPTIVE_PROOF_DELAY_START_BLOCKS;
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
  await runFundingStage("Private deposit service check failed", async () => {
    if (!(await discoveryProvider.isHealthy())) {
      throw new Error("Discovery service is not healthy");
    }
  });
  const sdkRegistry = input.sdkRegistry ?? createEmptyRegistry();
  let lastRetryableError: unknown = null;
  for (let attempt = 0; attempt < STARKNET_PRIVACY_PROOF_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const proofDelayBlocks =
        baseProofDelayBlocks + (attempt * STARKNET_PRIVACY_PROOF_DELAY_RETRY_BLOCKS);
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
              return {
                contractAddress: input.bridgeAddress,
                calldata: privacyBridgeDepositCalldata(input.plan),
              };
            })
            .execute({ provingBlockId }),
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
    } catch (error) {
      if (
        attempt < STARKNET_PRIVACY_PROOF_RETRY_ATTEMPTS - 1 &&
        isProofBlockTooRecent(error)
      ) {
        lastRetryableError = error;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }
      throw error;
    }
  }
  throw lastRetryableError ?? new Error("Private deposit proof submission failed");
}

async function runFundingStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUserRejected(error)) throw error;
    const wrapped = new Error(`${stage}: ${summarizeFundingError(error)}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

function summarizeFundingError(error: unknown) {
  const message = sanitizeRpcMessage(errorMessage(error));
  if (!message) return "No error detail was returned.";
  if (/^Failed while /i.test(message)) {
    return message.slice(0, 360);
  }
  if (/Transfer allowance exceeded/i.test(message)) {
    return "Token approval was lower than the required privacy-pool deposit amount.";
  }
  if (/insufficient.*balance|balance.*insufficient|exceeds.*balance|amount exceeds balance|not enough.*balance|u256_sub overflow/i.test(message)) {
    return "Connected wallet does not have enough token balance for this deposit.";
  }
  if (/max fee|fee.*exceed|insufficient.*fee|not enough.*fee|actual fee/i.test(message)) {
    return "Connected wallet does not have enough STRK to pay the Starknet transaction fee.";
  }
  if (/privacy replay protection/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/entry point.*not found|entrypoint.*not found|invalid.*entrypoint/i.test(message)) {
    return "Configured token contract does not expose the expected ERC-20 entrypoint.";
  }
  if (/contract.*not.*found|not deployed|ContractAddress.*not found/i.test(message)) {
    return "Configured Starknet contract was not found on the selected network.";
  }
  if (/INVALID_SIG|INVALID_SIGNATURE/i.test(message)) {
    return "The embedded Zylith wallet did not produce a valid privacy authorization signature.";
  }
  if (/NO_REPLAY_PROTECTION/i.test(message)) {
    return "Private deposits require a one-unit surplus note for replay protection.";
  }
  if (/Discovery service is not healthy/i.test(message)) {
    return "Private deposit service is unavailable.";
  }
  if (/Private deposit privacy warning|Starknet Privacy SDK privacy warning/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/Proving service error/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/Indexer API/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/proof block number .* too recent|maximum allowed block number/i.test(message)) {
    return "The privacy proof block is not old enough for the Starknet verifier yet.";
  }
  if (/proof facts|proofFacts/i.test(message)) {
    return "The proving service did not return valid proof facts.";
  }
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
    return "A required network request failed.";
  }
  if (/HTTP\s+4\d\d/i.test(message)) {
    return "A required service rejected the request.";
  }
  if (/HTTP\s+5\d\d/i.test(message)) {
    return "A required service is unavailable.";
  }
  if (/RpcError|RPC:/i.test(message)) {
    const reason = starknetRpcReason(message);
    return reason
      ? `Starknet network rejected the wallet transaction: ${reason}`
      : "Starknet network rejected the wallet transaction during fee estimation.";
  }
  if (/paymaster/i.test(message) && /reject|invalid|mismatch|not allowed/i.test(message)) {
    return "The deposit relay rejected the authorization.";
  }
  if (message.length <= 180 && !/^[\[{]/.test(message)) return message;
  return "A required service returned an unreadable error.";
}

function assertNoSdkPrivacyWarnings(warnings: Warning[]) {
  if (warnings.length === 0) return;
  const detail = warnings
    .map((warning) => `${warning.code}: ${warning.message}`)
    .join("; ");
  throw new Error(`Private deposit privacy warning: ${detail}`);
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
  const setupTransactions: string[] = [];
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
    if (sourceBalance < transferAmount) {
      throw new Error(
        `Connected wallet balance is below the requested deposit plus one smallest token unit required for replay protection.`,
      );
    }
    const transferCall: Call = {
      contractAddress: input.tokenAddress,
      entrypoint: "transfer",
      calldata: [input.account.address, ...u256Calldata(transferAmount)],
    };
    const result = await withFundingSetupStep("funding embedded signer from connected wallet", () =>
      executeWalletCall(input.provider, transferCall)
    );
    const txHash = transactionHashFromResult(result);
    if (!txHash) {
      throw new Error("Starknet wallet did not return a funding transaction hash");
    }
    setupTransactions.push(txHash);
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
    setupTransactions.push(txHash);
  }

  if (setupTransactions.length > 0) {
    await withFundingSetupStep(
      "waiting for embedded signer setup transactions",
      () =>
        waitForTransactionsAndProvingDelay(
          input.rpcProvider,
          setupTransactions,
          input.minProvingDelayBlocks,
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
  try {
    return await operation();
  } catch (error) {
    const message = summarizeFundingError(error);
    const wrapped = new Error(`Failed while ${step}: ${message}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

async function executeWalletCall(provider: StarknetProviderLike, call: Call) {
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
  if (typeof provider.account?.execute === "function") {
    try {
      return await provider.account.execute.call(provider.account, [call]);
    } catch (error) {
      if (!isWalletCallShapeError(error)) throw error;
      return provider.account.execute.call(provider.account, call);
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
  try {
    return await provider.request?.({
      type: "wallet_addInvokeTransaction",
      params: { calls: [walletRequestCall] },
    });
  } catch (error) {
    if (!isWalletCallShapeError(error)) throw error;
    return provider.request?.({
      type: "wallet_addInvokeTransaction",
      params: { calls: [accountCall] },
    });
  }
}

async function readTokenAllowance(
  provider: RpcProvider,
  tokenAddress: string,
  owner: string,
  spender: string,
) {
  const result = await provider.callContract({
    contractAddress: tokenAddress,
    entrypoint: "allowance",
    calldata: [owner, spender],
  });
  return decodeU256(result);
}

async function readTokenBalance(
  provider: RpcProvider,
  tokenAddress: string,
  owner: string,
) {
  const result = await provider.callContract({
    contractAddress: tokenAddress,
    entrypoint: "balance_of",
    calldata: [owner],
  });
  return decodeU256(result);
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
  if (json.deployed && json.transaction_hash) {
    await waitForTransactionAndProvingDelay(
      input.rpcProvider,
      json.transaction_hash,
      input.minProvingDelayBlocks,
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
  const latest = await provider.getBlockNumber();
  return Math.max(0, latest - Math.max(0, minDelayBlocks));
}

async function waitForBlock(provider: RpcProvider, targetBlock: number) {
  if (!Number.isFinite(targetBlock) || targetBlock <= 0) return;
  for (;;) {
    const latest = await provider.getBlockNumber();
    if (latest >= targetBlock) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function waitForTransactionAndProvingDelay(
  provider: RpcProvider,
  txHash: string,
  minProvingDelayBlocks: number,
) {
  await waitForTransactionsAndProvingDelay(provider, [txHash], minProvingDelayBlocks);
}

async function waitForTransactionsAndProvingDelay(
  provider: RpcProvider,
  txHashes: string[],
  minProvingDelayBlocks: number,
) {
  const receipts = await Promise.all(
    txHashes.map((txHash) =>
      provider.waitForTransaction(txHash, {
        retryInterval: 5_000,
      })
    ),
  );
  const receiptBlocks = receipts
    .map(receiptBlockNumber)
    .filter((block): block is number => block !== null);
  const latestBlock = await provider.getBlockNumber();
  const targetBlock = receiptBlocks.length === 0
    ? latestBlock + minProvingDelayBlocks
    : Math.max(...receiptBlocks) + minProvingDelayBlocks;
  await waitForBlock(provider, targetBlock);
}

function receiptBlockNumber(receipt: unknown) {
  if (!receipt || typeof receipt !== "object") return null;
  const value = (receipt as Record<string, unknown>).block_number ??
    (receipt as Record<string, unknown>).blockNumber;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) return Number(value);
  return null;
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
  const params = { silent_mode: silent };
  const typed = await provider.request({
    type: "wallet_requestAccounts",
    params,
  }).catch(() => null);
  const typedAddress = addressFromUnknown(typed);
  if (typedAddress) return typedAddress;
  const method = await provider.request({
    method: "wallet_requestAccounts",
    params,
  }).catch(() => null);
  return addressFromUnknown(method);
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

function paymasterExecuteUrl(url: string) {
  const trimmed = serviceBaseUrl(url);
  return trimmed.endsWith("/execute-outside")
    ? trimmed
    : `${trimmed}/execute-outside`;
}

function paymasterPrivacySignerEnsureUrl(url: string) {
  const trimmed = serviceBaseUrl(url);
  return trimmed.endsWith("/execute-outside")
    ? `${trimmed.slice(0, -"/execute-outside".length)}/privacy-signer/ensure`
    : `${trimmed}/privacy-signer/ensure`;
}

function paymasterPrivacySignerRelayUrl(url: string) {
  const trimmed = serviceBaseUrl(url);
  return trimmed.endsWith("/execute-outside")
    ? `${trimmed.slice(0, -"/execute-outside".length)}/privacy-signer/relay`
    : `${trimmed}/privacy-signer/relay`;
}

function serviceBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

function transactionHashFromResult(result: unknown) {
  if (typeof result === "string" && result.trim()) return result;
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  for (const key of ["transaction_hash", "transactionHash", "hash"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function isWalletCallShapeError(error: unknown) {
  const message = errorMessage(error);
  return /invalid_union|invalid input|contractAddress|contract_address|entrypoint|entry_point|array|calls/i
    .test(message);
}

function isUserRejected(error: unknown) {
  const message = errorMessage(error);
  return /user rejected|user denied|user abort|rejected by user|cancelled by user|canceled by user/i
    .test(message);
}

function isWalletRequestUnavailableError(error: unknown) {
  const message = errorMessage(error);
  return /method not found|not supported|unsupported|not implemented|unknown method|wallet_addInvokeTransaction/i
    .test(message);
}

function isProofBlockTooRecent(error: unknown): boolean {
  const message = errorMessage(error);
  if (
    /proof block number .* too recent|maximum allowed block number|proof block is not old enough/i
      .test(message)
  ) {
    return true;
  }
  if (error instanceof Error && "cause" in error) {
    return isProofBlockTooRecent((error as Error & { cause?: unknown }).cause);
  }
  if (error && typeof error === "object" && "cause" in error) {
    return isProofBlockTooRecent((error as { cause?: unknown }).cause);
  }
  return false;
}

function errorMessage(error: unknown) {
  const nested = nestedErrorMessages(error);
  if (nested.length > 0) return nested.join(" ");
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function nestedErrorMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  if (typeof error === "string") return [decodeMaybeHexString(error)];
  if (typeof error === "number" || typeof error === "bigint" || typeof error === "boolean") {
    return [String(error)];
  }
  if (error instanceof Error) {
    seen.add(error);
    return [
      error.message,
      ...nestedErrorMessages((error as Error & { cause?: unknown }).cause, seen),
    ].filter(Boolean);
  }
  if (Array.isArray(error)) {
    seen.add(error);
    return error.flatMap((item) => nestedErrorMessages(item, seen));
  }
  if (typeof error !== "object") return [];

  seen.add(error);
  const record = error as Record<string, unknown>;
  const messages: string[] = [];
  for (const key of [
    "message",
    "error",
    "execution_error",
    "revert_error",
    "failure_reason",
    "data",
    "details",
    "cause",
  ]) {
    if (key in record) messages.push(...nestedErrorMessages(record[key], seen));
  }
  if (messages.length > 0) return dedupeMessages(messages);
  try {
    return [JSON.stringify(error)];
  } catch {
    return [String(error)];
  }
}

function dedupeMessages(messages: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of messages.map((entry) => entry.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    if (seen.has(message)) continue;
    seen.add(message);
    out.push(message);
  }
  return out;
}

function decodeMaybeHexString(value: string) {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed) || trimmed.length < 8 || trimmed.length % 2 !== 0) {
    return trimmed;
  }
  try {
    const bytes = trimmed
      .slice(2)
      .match(/../g)
      ?.map((chunk) => parseInt(chunk, 16)) ?? [];
    if (bytes.length === 0 || bytes.some((byte) => byte < 32 || byte > 126)) return trimmed;
    return `${trimmed} ('${String.fromCharCode(...bytes)}')`;
  } catch {
    return trimmed;
  }
}

function decodeHexStringsInText(value: string) {
  return value.replace(/0x[0-9a-fA-F]{8,}/g, (match) => decodeMaybeHexString(match));
}

function sanitizeRpcMessage(value: string) {
  return decodeHexStringsInText(value)
    .replace(/"calldata"\s*:\s*\[[^\]]*\]/g, '"calldata":[...]')
    .replace(/"signature"\s*:\s*\[[^\]]*\]/g, '"signature":[...]')
    .replace(/\s+/g, " ")
    .trim();
}

function starknetRpcReason(message: string) {
  const quoted = message.match(/\('([^']{3,180})'\)/);
  if (quoted?.[1]) return quoted[1];
  const known = [
    /transfer amount exceeds balance/i,
    /insufficient balance/i,
    /u256_sub overflow/i,
    /transfer allowance exceeded/i,
    /invalid signature/i,
    /account validation failed/i,
    /class hash .* not declared/i,
    /contract .* not found/i,
    /entry point .* not found/i,
  ];
  for (const pattern of known) {
    const match = message.match(pattern);
    if (match?.[0]) return match[0];
  }
  return null;
}
