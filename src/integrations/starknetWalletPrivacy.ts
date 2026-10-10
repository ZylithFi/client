import { requirePrivateStrk20Support } from "../domain/starknetWalletCapabilities";

type WalletPrivacyProvider = {
  request?: (request: { type: string; params: unknown }) => Promise<unknown>;
};

type WalletPrivacyOptions = {
  pollDelayMs?: number;
  maxBalancePolls?: number;
};

type FundZylithInput = WalletPrivacyOptions & {
  provider: WalletPrivacyProvider;
  tokenAddress: string;
  tokenMetadata?: {
    name: string;
    symbol: string;
    decimals: number;
  };
  amount: bigint;
  amountLabel?: string;
  bridgeAddress: string;
  bridgeCalldata: string[];
  onStage?: (stage: string) => void;
  onPrivateDepositSubmissionStarted?: () => void;
  transactionStatus?: (
    transactionHash: string,
  ) => Promise<"pending" | "confirmed" | "failed">;
  assertWalletContext?: () => void;
};

type ClaimZylithExitInput = {
  provider: WalletPrivacyProvider;
  walletAddress: string;
  chainId: string;
  paymasterAddress: string;
  paymasterUrl: string;
  privacyPoolAddress: string;
  tokenAddress: string;
  feeTokenAddress: string;
  feeAmount: bigint;
  bridgeAddress: string;
  bridgeCalldata: string[];
  buildAuthorizationCall: (
    openNoteId: string,
  ) => Promise<StarknetCall> | StarknetCall;
  submitPreparedCall?: typeof import("./starknetPrivacyFunding").submitProofBearingCall;
  assertWalletContext?: () => void;
};

type StarknetCall = {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
};

const DEFAULT_PRIVATE_BALANCE_POLL_DELAY_MS = 3_000;
const DEFAULT_PRIVATE_BALANCE_POLLS = 120;
const PRIVATE_BALANCE_REQUEST_TIMEOUT_MS = 30_000;
const PRIVATE_ACTION_REQUEST_TIMEOUT_MS = 12 * 60_000;
const MAX_SHIELDING_ROUNDS = 3;
const STARKNET_FIELD_PRIME =
  0x0800000000000011000000000000000000000000000000000000000000000001n;
const MAX_PRIVATE_AMOUNT = (1n << 128n) - 1n;

export async function walletPrivateBalance(
  provider: WalletPrivacyProvider,
  tokenAddress: string,
): Promise<bigint> {
  return (await walletPrivateBalances(provider, [tokenAddress])).get(
    requiredFelt(tokenAddress, "balance token"),
  ) ?? 0n;
}

async function walletPrivateBalances(
  provider: WalletPrivacyProvider,
  tokenAddresses: string[],
): Promise<Map<string, bigint>> {
  const apiVersion = await requirePrivateStrk20Support(provider);
  const tokens = [...new Set(tokenAddresses.map((token) => requiredFelt(token, "balance token")))];
  const result = await walletRequest(provider, "wallet_strk20Balances", {
    tokens,
    api_version: apiVersion,
  }).catch((error) => {
    if (/not[_ ]registered/i.test(errorMessage(error))) return [];
    throw error;
  });
  if (!Array.isArray(result)) {
    throw new Error("The wallet returned a malformed private balance response.");
  }
  const balances = new Map<string, bigint>();
  for (const entry of result) {
    if (!isRecord(entry)) {
      throw new Error("The wallet returned a malformed private balance.");
    }
    const token = normalizedFelt(entry.token);
    const balance = strictNonNegativeFelt(entry.balance);
    if (!token || balance === null) {
      throw new Error("The wallet returned a malformed private balance.");
    }
    if (!tokens.includes(token)) continue;
    if (balances.has(token)) {
      throw new Error("The wallet returned duplicate private balances for one token.");
    }
    balances.set(token, balance);
  }
  for (const token of tokens) {
    if (!balances.has(token)) balances.set(token, 0n);
  }
  return balances;
}

export async function fundZylithFromWallet(
  input: FundZylithInput,
): Promise<{ transactionHash: string; shieldTransactionHash: string | null }> {
  requirePositiveAmount(input.amount);
  input.onStage?.("Preparing private balance");
  const depositToken = requiredFelt(input.tokenAddress, "deposit token");
  if (input.tokenMetadata) {
    await ensureWalletAsset(input.provider, depositToken, input.tokenMetadata);
  }
  let privateBalance = await walletPrivateBalance(input.provider, depositToken);
  const fundingActions = [
    {
      type: "withdraw",
      token: depositToken,
      amount: feltHex(input.amount),
      recipient: input.bridgeAddress,
    },
    {
      type: "invoke",
      contract: input.bridgeAddress,
      calldata: input.bridgeCalldata.map((value) =>
        requiredFelt(value, "deposit calldata")),
    },
  ];
  let estimatedFee = 0n;
  let shieldTransactionHash: string | null = null;
  for (let round = 0; privateBalance < input.amount + estimatedFee; round += 1) {
    if (round >= MAX_SHIELDING_ROUNDS) {
      throw new Error(
        "The wallet fee changed while preparing the private balance. Retry the deposit.",
      );
    }
    const requiredBalance = input.amount + estimatedFee;
    const shieldAmount = requiredBalance - privateBalance + estimatedFee;
    requireSupportedAmount(shieldAmount);
    input.assertWalletContext?.();
    input.onStage?.(
      input.amountLabel
        ? `Shielding ${input.amountLabel}`
        : "Shielding funds in your wallet",
    );
    const balanceBeforeShield = privateBalance;
    const transactionHash = await invokePrivateActions(input.provider, [
      { type: "deposit", token: depositToken, amount: feltHex(shieldAmount) },
    ]);
    shieldTransactionHash ??= transactionHash;
    input.onStage?.("Waiting for shielded balance");
    privateBalance = await waitForShieldTransaction(
      input,
      depositToken,
      balanceBeforeShield,
      transactionHash,
    );
    const expectedBalance = balanceBeforeShield + shieldAmount;
    estimatedFee = expectedBalance > privateBalance
      ? expectedBalance - privateBalance
      : 0n;
  }

  input.onStage?.("Funding Zylith");
  input.assertWalletContext?.();
  input.onPrivateDepositSubmissionStarted?.();
  const transactionHash = await invokePrivateActions(input.provider, fundingActions);
  input.onStage?.("Deposit submitted");
  return { transactionHash, shieldTransactionHash };
}

async function ensureWalletAsset(
  provider: WalletPrivacyProvider,
  tokenAddress: string,
  metadata: NonNullable<FundZylithInput["tokenMetadata"]>,
) {
  if (
    !metadata.name.trim()
    || !/^[A-Za-z0-9]{1,6}$/.test(metadata.symbol)
    || !Number.isSafeInteger(metadata.decimals)
    || metadata.decimals < 0
    || metadata.decimals > 255
  ) {
    throw new Error("The deposit token metadata is invalid.");
  }
  const apiVersion = await requirePrivateStrk20Support(provider);
  const accepted = await walletRequest(provider, "wallet_watchAsset", {
    type: "ERC20",
    options: {
      address: tokenAddress,
      name: metadata.name.trim(),
      symbol: metadata.symbol,
      decimals: metadata.decimals,
    },
    api_version: apiVersion,
  });
  if (accepted !== true) {
    throw new Error(
      `Add ${metadata.symbol} to the selected wallet before depositing.`,
    );
  }
}

export async function claimZylithExitToWallet(
  input: ClaimZylithExitInput,
): Promise<{ transactionHash: string }> {
  const feeBalance = await walletPrivateBalance(input.provider, input.feeTokenAddress);
  if (feeBalance < input.feeAmount) {
    throw new Error(
      "Your private STRK balance does not cover the STRK20 withdrawal fee. Shield STRK in your wallet and retry.",
    );
  }
  const apiVersion = await requirePrivateStrk20Support(input.provider);
  const prepared = await walletRequest(
    input.provider,
    "wallet_strk20PrepareInvoke",
    {
      actions: [
        {
          type: "withdraw",
          token: input.feeTokenAddress,
          amount: feltHex(input.feeAmount),
          recipient: input.paymasterAddress,
        },
        {
          type: "transfer",
          token: input.tokenAddress,
          amount: "OPEN",
          recipient: input.walletAddress,
        },
        {
          type: "invoke",
          contract: input.bridgeAddress,
          calldata: input.bridgeCalldata.map((value) =>
            value === "${openNoteIds[0]}"
              ? value
              : requiredFelt(value, "claim calldata")),
        },
      ],
      simulate: false,
      api_version: apiVersion,
    },
  );
  const callAndProof = parsePreparedPrivateCall(prepared);
  if (!sameFelt(callAndProof.call.contractAddress, input.privacyPoolAddress)) {
    throw new Error("The wallet returned a claim for another privacy pool.");
  }
  const openNoteId = validatePreparedClaim(
    callAndProof.call.calldata,
    input.tokenAddress,
    input.bridgeAddress,
    input.bridgeCalldata,
    input.feeTokenAddress,
    input.feeAmount,
    input.paymasterAddress,
  );
  input.assertWalletContext?.();
  const authorizationCall = await input.buildAuthorizationCall(openNoteId);
  input.assertWalletContext?.();
  const submit = input.submitPreparedCall
    ?? (await import("./starknetPrivacyFunding")).submitProofBearingCall;
  const transactionHash = await submit({
    signerAddress: openNoteId,
    chainId: input.chainId,
    paymasterAddress: input.paymasterAddress,
    paymasterUrl: input.paymasterUrl,
    callAndProof,
    authorizationCall,
  });
  return { transactionHash };
}

function validatePreparedClaim(
  calldata: string[],
  tokenAddress: string,
  bridgeAddress: string,
  requestedBridgeCalldata: string[],
  feeTokenAddress: string,
  feeAmount: bigint,
  paymasterAddress: string,
) {
  const normalizedToken = requiredFelt(tokenAddress, "claim token");
  const normalizedBridge = requiredFelt(bridgeAddress, "claim bridge");
  const requested = requestedBridgeCalldata.map((value) =>
    value === "${openNoteIds[0]}" ? value : requiredFelt(value, "claim calldata"));
  const actions = parsePreparedServerActions(calldata, malformedPreparedClaim);
  const bridgeInvokes = actions.invokes.filter(
    (invoke) => invoke.target === normalizedBridge,
  );
  if (
    actions.transferFrom.length !== 0
    || actions.openNotes.length !== 1
    || bridgeInvokes.length !== 1
    || actions.invokes.length !== 1
  ) throw malformedPreparedClaim();
  if (bridgeInvokes[0]!.variant !== 10) throw malformedPreparedClaim();
  if (
    actions.transferTo.length !== 1
    || !sameFelt(actions.transferTo[0]!.address, paymasterAddress)
    || !sameFelt(actions.transferTo[0]!.token, feeTokenAddress)
    || actions.transferTo[0]!.amount !== feeAmount
  ) throw malformedPreparedClaim();
  const openNote = actions.openNotes[0]!;
  if (openNote.token !== normalizedToken || openNote.noteId === "0x0") {
    throw malformedPreparedClaim();
  }
  const expected = requested.map((value) =>
    value === "${openNoteIds[0]}" ? openNote.noteId : value);
  if (!sameArray(bridgeInvokes[0]!.calldata, expected)) throw malformedPreparedClaim();
  return openNote.noteId;
}

type ParsedPreparedAction = {
  address: string;
  token: string;
  amount: bigint;
};

function parsePreparedServerActions(
  calldata: string[],
  malformed: () => Error,
) {
  const count = safeNumber(calldata[0]);
  if (count === null || count > 256) throw malformed();
  let offset = 1;
  const transferFrom: ParsedPreparedAction[] = [];
  const transferTo: ParsedPreparedAction[] = [];
  const openNotes: Array<{ token: string; noteId: string }> = [];
  const invokes: Array<{ variant: number; target: string; calldata: string[] }> = [];
  for (let index = 0; index < count; index += 1) {
    const variant = safeNumber(calldata[offset]);
    if (variant === null || variant > 11) throw malformed();
    if (variant === 0) {
      const length = safeNumber(calldata[offset + 2]);
      if (length === null) throw malformed();
      offset += 3 + length;
    } else if (variant === 1) offset += 5;
    else if (variant === 2 || variant === 3) {
      const address = calldata[offset + 1];
      const token = calldata[offset + 2];
      const amount = calldata[offset + 3];
      if (!address || !token || !amount) throw malformed();
      const action = { address, token, amount: BigInt(amount) };
      if (variant === 2) transferFrom.push(action);
      else transferTo.push(action);
      offset += 4;
    }
    else if (variant === 4) offset += 6;
    else if (variant === 5) offset += 7;
    else if (variant === 6) offset += 4;
    else if (variant === 7) {
      const token = calldata[offset + 4];
      const noteId = calldata[offset + 5];
      if (!token || !noteId) throw malformed();
      openNotes.push({ token, noteId });
      offset += 6;
    } else if (variant === 8) offset += 3;
    else if (variant === 9) offset += 2;
    else {
      const length = safeNumber(calldata[offset + 2]);
      if (length === null || offset + 3 + length > calldata.length) {
        throw malformed();
      }
      invokes.push({
        variant,
        target: calldata[offset + 1]!,
        calldata: calldata.slice(offset + 3, offset + 3 + length),
      });
      offset += 3 + length;
    }
    if (offset > calldata.length) throw malformed();
  }
  const screening = screeningSuffix(calldata, offset);
  if (!screening) throw malformed();
  return { transferFrom, transferTo, openNotes, invokes, screening };
}

function malformedPreparedClaim() {
  return new Error("The wallet returned a malformed private claim.");
}

function safeNumber(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(parsed)
      : null;
  } catch {
    return null;
  }
}

function screeningSuffix(calldata: string[], offset: number) {
  if (offset === calldata.length) return "absent" as const;
  const variant = safeNumber(calldata[offset]);
  if (variant === 1 && offset + 1 === calldata.length) return "none" as const;
  if (variant === 0 && offset + 4 === calldata.length) return "some" as const;
  return null;
}

function requiredFelt(value: unknown, label: string) {
  const normalized = normalizedFelt(value);
  if (!normalized) throw new Error(`The ${label} is invalid.`);
  return normalized;
}

function sameArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parsePreparedPrivateCall(
  value: unknown,
  malformed: () => Error = malformedPreparedClaim,
) {
  if (!isRecord(value) || !isRecord(value.call) || !isRecord(value.proof)) {
    throw malformed();
  }
  const contractAddress = normalizedFelt(value.call.contract_address);
  const entrypoint = value.call.entry_point;
  const calldata = value.call.calldata;
  const data = value.proof.data;
  const output = value.proof.output;
  const proofFacts = value.proof.proof_facts;
  if (
    !contractAddress
    || typeof entrypoint !== "string"
    || entrypoint !== "apply_actions"
    || !Array.isArray(calldata)
    || calldata.some((entry) => normalizedFelt(entry) === null)
    || typeof data !== "string"
    || data.length === 0
    || !Array.isArray(output)
    || output.some((entry) => normalizedFelt(entry) === null)
    || !Array.isArray(proofFacts)
    || proofFacts.length === 0
    || proofFacts.some((entry) => normalizedFelt(entry) === null)
  ) {
    throw malformed();
  }
  return {
    call: {
      contractAddress,
      entrypoint,
      calldata: calldata.map((entry) => normalizedFelt(entry)!),
    },
    proof: {
      data,
      output: output.map((entry) => normalizedFelt(entry)!),
      proofFacts: proofFacts.map((entry) => normalizedFelt(entry)!),
    },
  };
}

export function walletPrivateSubmissionMayHaveLanded(error: unknown) {
  const message = errorMessage(error);
  return !/user[_ ]refused|user[_ ]rejected|user denied|cancelled|canceled|not[_ ]registered|insufficient[_ ]private[_ ]balance|privacy[_ ]leak|invalid[_ ]request[_ ]payload|api[_ ]version[_ ]not[_ ]supported|method not found|does not support|not supported|unsupported|unknown method/i.test(
    message,
  );
}

async function waitForShieldTransaction(
  input: FundZylithInput,
  token: string,
  balanceBeforeShield: bigint,
  shieldTransactionHash: string,
) {
  const polls = input.maxBalancePolls ?? DEFAULT_PRIVATE_BALANCE_POLLS;
  const delayMs = input.pollDelayMs ?? DEFAULT_PRIVATE_BALANCE_POLL_DELAY_MS;
  if (!Number.isSafeInteger(polls) || polls <= 0 || polls > 1_000) {
    throw new Error("Private balance polling configuration is invalid.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error("Private balance polling delay is invalid.");
  }
  let confirmedReads = 0;
  for (let attempt = 0; attempt < polls; attempt += 1) {
    const transactionStatus = await input.transactionStatus?.(shieldTransactionHash)
      .catch(() => "pending" as const);
    if (transactionStatus === "failed") {
      throw new Error(
        "The shielding transaction failed. No funds were deposited. Retry the deposit.",
      );
    }
    if (!input.transactionStatus || transactionStatus === "confirmed") {
      const balance = await walletPrivateBalance(input.provider, token);
      if (balance !== balanceBeforeShield) return balance;
      if (transactionStatus === "confirmed" && ++confirmedReads >= 3) return balance;
    }
    if (attempt + 1 < polls && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    "The shielded balance is not ready yet. Keep the wallet open and retry.",
  );
}

async function invokePrivateActions(
  provider: WalletPrivacyProvider,
  actions: Array<Record<string, unknown>>,
) {
  const apiVersion = await requirePrivateStrk20Support(provider);
  const result = await walletRequest(
    provider,
    "wallet_strk20InvokeTransaction",
    { actions, api_version: apiVersion },
  );
  return transactionHash(result);
}

function transactionHash(result: unknown) {
  const hash = isRecord(result) ? normalizedFelt(result.transaction_hash) : null;
  if (!hash || hash === "0x0") {
    throw new Error("The wallet did not return a private transaction hash.");
  }
  return hash;
}

async function walletRequest(
  provider: WalletPrivacyProvider,
  type: string,
  params: unknown,
) {
  if (typeof provider.request !== "function") {
    throw new Error("The selected wallet does not support private STRK20 actions.");
  }
  try {
    return await withTimeout(
      Promise.resolve().then(() => provider.request!({ type, params })),
      type === "wallet_strk20Balances"
        ? PRIVATE_BALANCE_REQUEST_TIMEOUT_MS
        : PRIVATE_ACTION_REQUEST_TIMEOUT_MS,
      type === "wallet_strk20Balances"
        ? "The wallet timed out while reading the shielded balance."
        : "The wallet timed out while preparing the private transaction.",
    );
  } catch (error) {
    const message = errorMessage(error);
    if (/method not found|not supported|unsupported|unknown method/i.test(message)) {
      throw new Error(
        "The selected wallet does not support private STRK20 actions.",
        { cause: error },
      );
    }
    if (/not[_ ]registered/i.test(message)) {
      throw new Error(
        "Private STRK20 is not registered in this wallet. Set it up in the wallet, then retry.",
        { cause: error },
      );
    }
    throw error;
  }
}

function requirePositiveAmount(value: bigint) {
  if (value <= 0n || value > MAX_PRIVATE_AMOUNT) {
    throw new Error("Private funding amount is outside the supported range.");
  }
}

function requireSupportedAmount(value: bigint) {
  if (value <= 0n || value > MAX_PRIVATE_AMOUNT) {
    throw new Error("Private funding amount is outside the supported range.");
  }
}

function feltHex(value: bigint) {
  return `0x${value.toString(16)}`;
}

function strictNonNegativeFelt(value: unknown): bigint | null {
  const normalized = normalizedFelt(value);
  if (!normalized) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

function normalizedFelt(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    return null;
  }
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed >= STARKNET_FIELD_PRIME) return null;
    return `0x${parsed.toString(16)}`;
  } catch {
    return null;
  }
}

function sameFelt(left: unknown, right: unknown) {
  const normalizedLeft = normalizedFelt(left);
  const normalizedRight = normalizedFelt(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return boundedErrorMessage(error, 0, new WeakSet<object>());
}

function boundedErrorMessage(
  error: unknown,
  depth: number,
  seen: WeakSet<object>,
): string {
  if (depth > 6) return "";
  if (typeof error === "string") return error.slice(0, 2_048);
  if (typeof error === "number" || typeof error === "bigint") {
    return String(error);
  }
  if (!error || typeof error !== "object" || seen.has(error)) return "";
  seen.add(error);
  for (const key of ["message", "error", "reason", "detail", "code", "cause"]) {
    const message = boundedErrorMessage(
      safeRecordValue(error, key),
      depth + 1,
      seen,
    );
    if (message) return message;
  }
  return "";
}

function safeRecordValue(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
