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
    amount: string;
    deposit_nonce: string;
    note_commitment: string;
    withdraw_authority: string;
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

export type SubmitPrivacyBridgeDepositResult = {
  transactionHash: string;
  sdkRegistry: PrivateRegistry;
};

const STARK_FIELD_PRIME =
  3618502788666131213697322783095070105623107215331596699973092056135872020481n;

export async function submitPrivacyBridgeDeposit(
  input: SubmitPrivacyBridgeDepositInput,
): Promise<SubmitPrivacyBridgeDepositResult> {
  const depositorAddress = connectedStarknetAddress(input.provider);
  if (!depositorAddress) {
    throw new Error("Connect a Starknet wallet before using Starknet Privacy funding");
  }
  const rpcProvider = new RpcProvider({ nodeUrl: input.rpcUrl });
  const account = await runFundingStage(
    "Starknet Privacy signer setup failed",
    () =>
      createEmbeddedPrivacyProofAccount({
        seedHex: input.seedHex,
        rpcProvider,
        paymasterUrl: input.paymasterUrl,
        privacyProofSignerClassHash: input.privacyProofSignerClassHash,
        minProvingDelayBlocks: input.minProvingDelayBlocks,
      }),
  );
  await runFundingStage("Starknet Privacy funding setup failed", () =>
    ensureEmbeddedPrivacyAccountReady({
      provider: input.provider,
      rpcProvider,
      sourceOwner: depositorAddress,
      account,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      privacyPoolAddress: input.privacyPoolAddress,
      amount: input.plan.amount,
      paymasterUrl: input.paymasterUrl,
      minProvingDelayBlocks: input.minProvingDelayBlocks,
    })
  );
  const provingBlockId = await runFundingStage(
    "Starknet Privacy proving block lookup failed",
    () => provingBlock(rpcProvider, input.minProvingDelayBlocks),
  );
  const discoveryProvider = new IndexerDiscoveryProvider(
    input.discoveryUrl,
    input.privacyPoolAddress,
  );
  await runFundingStage("Starknet Privacy discovery health check failed", async () => {
    if (!(await discoveryProvider.isHealthy())) {
      throw new Error("Discovery service is not healthy");
    }
  });
  const provingProvider = new ProvingServiceProofProvider(
    input.provingUrl,
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
  const sdkRegistry = input.sdkRegistry ?? createEmptyRegistry();
  const execution = await runFundingStage(
    "Starknet Privacy proof generation failed",
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
            .deposit({ amount: input.plan.amount })
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
            throw new Error("Starknet Privacy bridge withdrawal was not built correctly");
          }
          return {
            contractAddress: input.bridgeAddress,
            calldata: [
              input.plan.encodedArgs.asset_id,
              input.plan.encodedArgs.amount,
              input.plan.encodedArgs.deposit_nonce,
              input.plan.encodedArgs.note_commitment,
              input.plan.encodedArgs.withdraw_authority,
            ],
          };
        })
        .execute({ provingBlockId }),
  );
  assertNoSdkPrivacyWarnings(execution.warnings);

  const transactionHash = await runFundingStage("Starknet Privacy paymaster submission failed", () =>
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
  const message = errorMessage(error).replace(/\s+/g, " ").trim();
  if (!message) return "No error detail was returned.";
  if (/Transfer allowance exceeded/i.test(message)) {
    return "Token approval was lower than the required privacy-pool deposit amount.";
  }
  if (/insufficient.*balance|balance.*insufficient|exceeds.*balance|amount exceeds balance|not enough.*balance/i.test(message)) {
    return "Connected wallet does not have enough token balance for this deposit.";
  }
  if (/max fee|fee.*exceed|insufficient.*fee|not enough.*fee|actual fee/i.test(message)) {
    return "Connected wallet does not have enough STRK to pay the Starknet transaction fee.";
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
  if (/Discovery service is not healthy/i.test(message)) {
    return "Starknet Privacy discovery service is unavailable.";
  }
  if (/Starknet Privacy SDK privacy warning/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/Proving service error/i.test(message)) {
    return message.slice(0, 280);
  }
  if (/Indexer API/i.test(message)) {
    return message.slice(0, 280);
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
    return "Starknet RPC returned an error.";
  }
  if (/paymaster/i.test(message) && /reject|invalid|mismatch|not allowed/i.test(message)) {
    return "The privacy paymaster rejected the authorization.";
  }
  if (message.length <= 180 && !/^[\[{]/.test(message)) return message;
  return "Wallet, prover, or RPC returned a low-level error.";
}

function assertNoSdkPrivacyWarnings(warnings: Warning[]) {
  if (warnings.length === 0) return;
  const detail = warnings
    .map((warning) => `${warning.code}: ${warning.message}`)
    .join("; ");
  throw new Error(`Starknet Privacy SDK privacy warning: ${detail}`);
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
    await withFundingSetupStep(
      "waiting for embedded signer funding transaction",
      () =>
        waitForTransactionAndProvingDelay(
          input.rpcProvider,
          txHash,
          input.minProvingDelayBlocks,
        ),
    );
  } else {
    // Ensure the connected wallet is still the intended funding source before proving.
    const connected = connectedStarknetAddress(input.provider);
    if (connected && connected !== normalizeAddress(input.sourceOwner)) {
      throw new Error("Connected Starknet wallet changed during Starknet Privacy funding");
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
  if (allowance >= input.amount) return;
  if (!input.paymasterUrl) {
    throw new Error("Starknet Privacy paymaster is required for proof signer approval");
  }
  const paymasterUrl = input.paymasterUrl;
  const approveCall: Call = {
    contractAddress: input.tokenAddress,
    entrypoint: "approve",
    calldata: [input.privacyPoolAddress, ...u256Calldata(input.amount)],
  };
  const nonce = randomFelt();
  const relayHash = privacyProofSignerRelayHash(
    input.chainId,
    input.account.address,
    [approveCall],
    nonce,
  );
  const signature = ec.starkCurve.sign(relayHash, input.account.privateKey);
  const response = await withFundingSetupStep("requesting embedded signer approval relay", () =>
    fetch(paymasterPrivacySignerRelayUrl(paymasterUrl), {
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
    })
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Privacy paymaster rejected signer approval with HTTP ${response.status}`);
  }
  const json = await response.json() as { transaction_hash?: string; transactionHash?: string };
  const txHash = json.transaction_hash ?? json.transactionHash;
  if (!txHash) {
    throw new Error("Privacy paymaster did not return an approval transaction hash");
  }
  await withFundingSetupStep(
    "waiting for embedded signer approval transaction",
    () =>
      waitForTransactionAndProvingDelay(
        input.rpcProvider,
        txHash,
        input.minProvingDelayBlocks,
      ),
  );
}

async function withFundingSetupStep<T>(step: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = summarizeFundingError(error);
    throw new Error(`Failed while ${step}: ${message}`);
  }
}

async function executeWalletCall(provider: StarknetProviderLike, call: Call) {
  if (typeof provider.account?.execute === "function") {
    try {
      return await provider.account.execute.call(provider.account, call);
    } catch (error) {
      if (!isWalletCallShapeError(error)) throw error;
      return provider.account.execute.call(provider.account, [call]);
    }
  }
  if (typeof provider.request === "function") {
    return requestWalletInvoke(provider, call);
  }
  throw new Error("Selected Starknet wallet cannot approve Starknet Privacy deposits");
}

async function requestWalletInvoke(provider: StarknetProviderLike, call: Call) {
  const legacyCall = {
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
      params: { calls: [legacyCall] },
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
      "Privacy paymaster is not configured.",
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
    throw new Error(text || `Privacy paymaster rejected the transaction with HTTP ${response.status}`);
  }
  const json = await response.json() as { transaction_hash?: string; transactionHash?: string };
  const hash = json.transaction_hash ?? json.transactionHash;
  if (!hash) throw new Error("Privacy paymaster did not return a transaction hash");
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
    throw new Error("Starknet Privacy proof signer deployment is not configured");
  }
  if (!input.paymasterUrl) {
    throw new Error("Starknet Privacy paymaster is required for proof signer setup");
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
    throw new Error(text || `Privacy paymaster rejected signer setup with HTTP ${response.status}`);
  }
  const json = await response.json() as {
    contract_address?: string;
    deployed?: boolean;
    transaction_hash?: string;
  };
  const address = normalizeAddress(json.contract_address);
  if (!address) {
    throw new Error("Privacy paymaster did not return a proof signer address");
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
    throw new Error("Starknet Privacy prover did not return proof facts");
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
  const receipt = await provider.waitForTransaction(txHash, {
    retryInterval: 5_000,
  });
  const receiptBlock = receiptBlockNumber(receipt);
  const targetBlock = receiptBlock === null
    ? await provider.getBlockNumber() + minProvingDelayBlocks
    : receiptBlock + minProvingDelayBlocks;
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
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/execute-outside")
    ? trimmed
    : `${trimmed}/execute-outside`;
}

function paymasterPrivacySignerEnsureUrl(url: string) {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/execute-outside")
    ? `${trimmed.slice(0, -"/execute-outside".length)}/privacy-signer/ensure`
    : `${trimmed}/privacy-signer/ensure`;
}

function paymasterPrivacySignerRelayUrl(url: string) {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/execute-outside")
    ? `${trimmed.slice(0, -"/execute-outside".length)}/privacy-signer/relay`
    : `${trimmed}/privacy-signer/relay`;
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
  return /invalid_union|invalid input|contractAddress|contract_address|entrypoint|entry_point/i
    .test(message);
}

function isUserRejected(error: unknown) {
  const message = errorMessage(error);
  return /user rejected|user denied|user abort|rejected by user|cancelled by user|canceled by user/i
    .test(message);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
