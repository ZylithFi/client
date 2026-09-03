import {
  assetScale,
  fromAtomicStr,
  type PairConfig,
  toAtomicStr,
  toPriceAtomicStr,
} from "./common.js";

export type LiquidityPositionBacking = "PrivateReserve";
export type LiquidityPositionStatus = "Opening" | "Active" | "Closing" | "Closed";
export type LiquidityPositionPolicyKind = "StaticRange" | "OraclePegged" | "InventorySkewed";
export type LiquidityPositionPrivacyMode = "RotatingPrivate" | "StaticPrivate" | "PublicAnonymous";

export type PrivateLiquidityPositionDraft = {
  pair: PairConfig;
  baseAmount: string;
  quoteAmount: string;
  currentPrice: string;
  minPrice: string;
  maxPrice: string;
  maxFillBasePerBatch?: string;
  bandCount?: number;
  durationHours?: number;
  rotationBps?: number;
  minEdgeBps?: number;
  spreadBps?: number;
  targetBaseRatioBps?: number;
  inventorySkewBps?: number;
  maxPriceDeviationBps?: number;
  targetAprPct?: number;
  expectedDailyVolume?: string;
  protocolFeeBps?: number;
  maxRebateBps?: number;
  fullRebateEdgeBps?: number;
  zeroRebateEdgeBps?: number;
  oracleId?: string;
  maxOracleStalenessMs?: number;
  maxOracleDivergenceBps?: number;
  backing?: LiquidityPositionBacking;
  policyKind?: LiquidityPositionPolicyKind;
  privacyMode?: LiquidityPositionPrivacyMode;
};

export type PrivateLiquidityPosition = {
  version: 1;
  backing: LiquidityPositionBacking;
  status: LiquidityPositionStatus;
  policyKind: LiquidityPositionPolicyKind;
  privacyMode: LiquidityPositionPrivacyMode;
  pairId: string;
  baseAssetId: string;
  quoteAssetId: string;
  baseReserve: string;
  quoteReserve: string;
  currentPrice: string;
  minPrice: string;
  maxPrice: string;
  maxFillBasePerBatch: string;
  bandCount: number;
  durationHours: number;
  rotationBps: number;
  spreadBps: number;
  targetBaseRatioBps: number;
  inventorySkewBps: number;
  maxPriceDeviationBps: number;
  oracleGuard?: {
    oracleId: string;
    maxStalenessMs: number;
    maxDivergenceBps: number;
  };
};

export type LiquidityPositionCurve = {
  side: "Buy" | "Sell";
  points: Array<{ price: string; baseAmount: string }>;
  totalBaseAmount: string;
  fundingAsset: string;
  fundingAmount: string;
};

export type PrivateLiquidityPositionOpenRequest = {
  kind: "OpenPrivateLiquidityPosition";
  pairId: string;
  baseAssetId: string;
  quoteAssetId: string;
  baseReserveAtomic: string;
  quoteReserveAtomic: string;
  priceLowerBoundAtomic: string;
  priceUpperBoundAtomic: string;
  maxFillBasePerBatchAtomic: string;
  curvePolicy: {
    kind: LiquidityPositionPolicyKind;
    bandCount: number;
    spreadBps: number;
    targetBaseRatioBps: number;
    inventorySkewBps: number;
    maxPriceDeviationBps: number;
  };
  rotationPolicy: {
    maxPriceRotationBps: number;
    maxDepthRotationBps: number;
    skipEpochBps: number;
  };
  oracleGuard?: {
    oracleId: string;
    maxStalenessMs: number;
    maxDivergenceBps: number;
  };
  durationHours: number;
  privacyMode: LiquidityPositionPrivacyMode;
};

export type PrivateLiquidityPositionReconfigureRequest = {
  kind: "ReconfigurePrivateLiquidityPosition";
  positionId: string;
  priceLowerBoundAtomic: string;
  priceUpperBoundAtomic: string;
  maxFillBasePerBatchAtomic: string;
  curvePolicy: PrivateLiquidityPositionOpenRequest["curvePolicy"];
  rotationPolicy: PrivateLiquidityPositionOpenRequest["rotationPolicy"];
  oracleGuard?: PrivateLiquidityPositionOpenRequest["oracleGuard"];
  expiryEpoch?: number | bigint | string;
};

export type PrivateLiquidityPositionCloseRequest = {
  kind: "ClosePrivateLiquidityPosition";
  positionId: string;
};

export type PrivateLiquidityPositionLifecycleRequest =
  | PrivateLiquidityPositionReconfigureRequest
  | PrivateLiquidityPositionCloseRequest;

export type PrivateLiquidityPositionLifecycleAuthorizationRequest = {
  seed_hex: string;
  position_id: string;
  prior_position_commitment?: string;
  output_position_commitment?: string;
  epoch: string;
  base_amount: string;
  quote_amount: string;
};

export type PrivateLiquidityPositionLifecycleDraft = {
  seedHex: string;
  positionId: string;
  priorPositionCommitment?: string;
  outputPositionCommitment?: string;
  epoch: number | bigint | string;
  baseAmountAtomic?: number | bigint | string;
  quoteAmountAtomic?: number | bigint | string;
};

export type PrivateLiquidityPositionPlan = {
  position: PrivateLiquidityPosition;
  bidCurve?: LiquidityPositionCurve;
  askCurve?: LiquidityPositionCurve;
  openPosition: PrivateLiquidityPositionOpenRequest;
  metrics: {
    rangeWidthBps: number;
    capitalEfficiency: number;
    quoteValue: number;
    effectiveReferencePrice: number;
    rewards: LiquidityPositionRewardProjection;
  };
  warnings: string[];
};

export type LiquidityPositionRewardProjection = {
  protocolFeeBps: number;
  maxRebateBps: number;
  fullRebateEdgeBps: number;
  zeroRebateEdgeBps: number;
  estimatedEdgeBps: number;
  estimatedRebateBps: number;
  netLpEdgeBps: number;
  rebateQuality: number;
  expectedDailyVolume: number | null;
  expectedDailyTurnover: number | null;
  projectedAprPct: number | null;
  targetAprPct: number | null;
  requiredDailyTurnover: number | null;
  requiredDailyVolume: number | null;
};

const MIN_POSITION_BANDS = 3;
const MAX_POSITION_BANDS = 8;
const DEFAULT_POSITION_BANDS = 5;
const DEFAULT_DURATION_HOURS = 24;
const DEFAULT_ROTATION_BPS = 50;
const MAX_ROTATION_BPS = 1_000;
const DEFAULT_POSITION_SPREAD_BPS = 8;
const DEFAULT_TARGET_BASE_RATIO_BPS = 5_000;
const MAX_POLICY_BPS = 10_000;
const DEFAULT_ORACLE_STALENESS_MS = 30_000;
const DEFAULT_ORACLE_DIVERGENCE_BPS = 100;
const DAYS_PER_YEAR = 365;

export function buildPrivateLiquidityPositionPlan(
  draft: PrivateLiquidityPositionDraft,
): PrivateLiquidityPositionPlan {
  validatePair(draft.pair);
  const baseReserve = nonNegativeAtomic(
    draft.baseAmount,
    draft.pair.base_asset_id,
    "base amount",
  );
  const quoteReserve = nonNegativeAtomic(
    draft.quoteAmount,
    draft.pair.quote_asset_id,
    "quote amount",
  );
  if (baseReserve === 0n && quoteReserve === 0n) {
    throw new Error("Position requires a base or quote deposit amount");
  }

  const currentPrice = positivePriceAtomic(
    draft.currentPrice,
    draft.pair.quote_asset_id,
    "current price",
  );
  const minPrice = positivePriceAtomic(
    draft.minPrice,
    draft.pair.quote_asset_id,
    "minimum price",
  );
  const maxPrice = positivePriceAtomic(
    draft.maxPrice,
    draft.pair.quote_asset_id,
    "maximum price",
  );
  if (minPrice >= maxPrice) throw new Error("Position minimum price must be below maximum price");

  const bandCount = boundedInteger(draft.bandCount, DEFAULT_POSITION_BANDS, MIN_POSITION_BANDS, MAX_POSITION_BANDS);
  const durationHours = boundedNumber(draft.durationHours, DEFAULT_DURATION_HOURS, 1, 24 * 20);
  const rotationBps = boundedInteger(draft.rotationBps, DEFAULT_ROTATION_BPS, 0, MAX_ROTATION_BPS);
  const policyKind = draft.policyKind ?? "StaticRange";
  const minEdgeBps = boundedNumber(draft.minEdgeBps, Number.NaN, 0, MAX_POLICY_BPS / 2);
  const spreadBps = Number.isFinite(minEdgeBps)
    ? Math.round(minEdgeBps * 2)
    : boundedInteger(draft.spreadBps, DEFAULT_POSITION_SPREAD_BPS, 0, MAX_POLICY_BPS);
  const targetBaseRatioBps = boundedInteger(
    draft.targetBaseRatioBps,
    DEFAULT_TARGET_BASE_RATIO_BPS,
    0,
    MAX_POLICY_BPS,
  );
  const inventorySkewBps = boundedInteger(draft.inventorySkewBps, 0, 0, MAX_POLICY_BPS);
  const maxPriceDeviationBps = boundedInteger(
    draft.maxPriceDeviationBps,
    0,
    0,
    MAX_POLICY_BPS,
  );
  const oracleGuard = oracleGuardFromDraft(draft);
  if (policyKind === "OraclePegged" && !oracleGuard) {
    throw new Error("Oracle-pegged positions require an oracle id");
  }
  const maxFillBasePerBatch = nonNegativeAtomic(
    draft.maxFillBasePerBatch ?? "0",
    draft.pair.base_asset_id,
    "max fill per batch",
  );
  const priceBaseScale = pairPriceBaseScale(draft.pair);
  const warnings: string[] = [];
  if (currentPrice <= minPrice || currentPrice >= maxPrice) {
    warnings.push("Current price is outside the selected range; only one side of the position may become active.");
  }
  if ((draft.privacyMode ?? "RotatingPrivate") === "StaticPrivate") {
    warnings.push("Static private positions carry stronger repeated-shape fingerprinting risk.");
  }

  const effectiveReferencePrice = inventorySkewedReferencePrice({
    baseReserve,
    quoteReserve,
    currentPrice,
    minPrice,
    maxPrice,
    priceBaseScale,
    policyKind,
    targetBaseRatioBps,
    inventorySkewBps,
    maxPriceDeviationBps,
  });
  const widthBps = BigInt(spreadBps);
  const spreadDenominator = 20_000n;
  const bidHigh = minBigInt(
    maxPrice,
    mulDivFloor(effectiveReferencePrice, spreadDenominator - widthBps, spreadDenominator),
  );
  const bidLow = minPrice;
  const askLow = maxBigInt(
    minPrice,
    mulDivCeil(effectiveReferencePrice, spreadDenominator + widthBps, spreadDenominator),
  );
  const askHigh = maxPrice;
  const bidCurve = quoteReserve > 0n && bidHigh > bidLow
    ? buildBidCurve({
      pair: draft.pair,
      lowPrice: bidLow,
      highPrice: bidHigh,
      quoteReserve,
      priceBaseScale,
      bandCount,
      maxFillBasePerBatch,
    })
    : undefined;
  const askCurve = baseReserve > 0n && askHigh > askLow
    ? buildAskCurve({
      pair: draft.pair,
      lowPrice: askLow,
      highPrice: askHigh,
      baseReserve,
      bandCount,
      maxFillBasePerBatch,
    })
    : undefined;
  if (!bidCurve && !askCurve) {
    throw new Error("Position range does not create any executable curve bands");
  }
  const effectiveMaxFillBasePerBatch = maxFillBasePerBatch > 0n
    ? maxFillBasePerBatch
    : maxBigInt(
      curveTotalBaseAtomic(bidCurve, draft.pair.base_asset_id),
      curveTotalBaseAtomic(askCurve, draft.pair.base_asset_id),
    );

  const quoteValueAtomic = quoteReserve + mulDivFloor(baseReserve, currentPrice, priceBaseScale);
  const quoteValue = atomicAsNumber(quoteValueAtomic, draft.pair.quote_asset_id);
  const rewardProjection = liquidityRewardProjection({
    pair: draft.pair,
    quoteAssetId: draft.pair.quote_asset_id,
    quoteValueAtomic,
    estimatedEdgeBps: Number.isFinite(minEdgeBps) ? minEdgeBps : spreadBps / 2,
    expectedDailyVolume: draft.expectedDailyVolume,
    targetAprPct: draft.targetAprPct,
    protocolFeeBps: draft.protocolFeeBps,
    maxRebateBps: draft.maxRebateBps,
    fullRebateEdgeBps: draft.fullRebateEdgeBps,
    zeroRebateEdgeBps: draft.zeroRebateEdgeBps,
  });

  const position: PrivateLiquidityPosition = {
    version: 1,
    backing: draft.backing ?? "PrivateReserve",
    status: "Opening",
    policyKind,
    privacyMode: draft.privacyMode ?? "RotatingPrivate",
    pairId: draft.pair.pair_id,
    baseAssetId: draft.pair.base_asset_id,
    quoteAssetId: draft.pair.quote_asset_id,
    baseReserve: fromAtomicStr(baseReserve.toString(), draft.pair.base_asset_id),
    quoteReserve: fromAtomicStr(quoteReserve.toString(), draft.pair.quote_asset_id),
    currentPrice: fromAtomicStr(currentPrice.toString(), draft.pair.quote_asset_id),
    minPrice: fromAtomicStr(minPrice.toString(), draft.pair.quote_asset_id),
    maxPrice: fromAtomicStr(maxPrice.toString(), draft.pair.quote_asset_id),
    maxFillBasePerBatch: fromAtomicStr(
      effectiveMaxFillBasePerBatch.toString(),
      draft.pair.base_asset_id,
    ),
    bandCount,
    durationHours,
    rotationBps,
    spreadBps,
    targetBaseRatioBps,
    inventorySkewBps,
    maxPriceDeviationBps,
    oracleGuard,
  };

  const openPosition: PrivateLiquidityPositionOpenRequest = {
    kind: "OpenPrivateLiquidityPosition",
    pairId: draft.pair.pair_id,
    baseAssetId: draft.pair.base_asset_id,
    quoteAssetId: draft.pair.quote_asset_id,
    baseReserveAtomic: baseReserve.toString(),
    quoteReserveAtomic: quoteReserve.toString(),
    priceLowerBoundAtomic: minPrice.toString(),
    priceUpperBoundAtomic: maxPrice.toString(),
    maxFillBasePerBatchAtomic: effectiveMaxFillBasePerBatch.toString(),
    curvePolicy: {
      kind: policyKind,
      bandCount,
      spreadBps,
      targetBaseRatioBps,
      inventorySkewBps,
      maxPriceDeviationBps,
    },
    rotationPolicy: {
      maxPriceRotationBps: rotationBps,
      maxDepthRotationBps: rotationBps,
      skipEpochBps: 0,
    },
    oracleGuard,
    durationHours,
    privacyMode: draft.privacyMode ?? "RotatingPrivate",
  };

  return {
    position,
    bidCurve,
    askCurve,
    openPosition,
    metrics: {
      rangeWidthBps: ratioAsNumber(maxPrice - minPrice, currentPrice, 10_000),
      capitalEfficiency: capitalEfficiency(minPrice, maxPrice, currentPrice),
      quoteValue,
      effectiveReferencePrice: atomicAsNumber(effectiveReferencePrice, draft.pair.quote_asset_id),
      rewards: rewardProjection,
    },
    warnings,
  };
}

export function buildPrivateLiquidityPositionOpenAuthorizationRequest(
  draft: PrivateLiquidityPositionLifecycleDraft,
): PrivateLiquidityPositionLifecycleAuthorizationRequest {
  const request = lifecycleRequest(draft);
  if (request.prior_position_commitment) {
    throw new Error("Liquidity position open authorization must not include a prior commitment");
  }
  if (!request.output_position_commitment) {
    throw new Error("Liquidity position open authorization requires an output commitment");
  }
  if (request.base_amount !== "0" || request.quote_amount !== "0") {
    throw new Error("Liquidity position open authorization amounts must be zero");
  }
  return request;
}

export function buildPrivateLiquidityPositionReconfigureAuthorizationRequest(
  draft: PrivateLiquidityPositionLifecycleDraft,
): PrivateLiquidityPositionLifecycleAuthorizationRequest {
  const request = lifecycleRequest(draft);
  requirePriorAndOutput(request, "reconfigure");
  if (request.base_amount !== "0" || request.quote_amount !== "0") {
    throw new Error("Liquidity position reconfigure authorization amounts must be zero");
  }
  return request;
}

export function buildPrivateLiquidityPositionCloseAuthorizationRequest(
  draft: PrivateLiquidityPositionLifecycleDraft,
): PrivateLiquidityPositionLifecycleAuthorizationRequest {
  const request = lifecycleRequest(draft);
  if (!request.prior_position_commitment) {
    throw new Error("Liquidity position close authorization requires a prior commitment");
  }
  if (request.output_position_commitment) {
    throw new Error("Liquidity position close authorization must not include an output commitment");
  }
  return request;
}

function oracleGuardFromDraft(
  draft: PrivateLiquidityPositionDraft,
): PrivateLiquidityPosition["oracleGuard"] {
  const oracleId = draft.oracleId?.trim();
  if (!oracleId) return undefined;
  return {
    oracleId,
    maxStalenessMs: boundedInteger(
      draft.maxOracleStalenessMs,
      DEFAULT_ORACLE_STALENESS_MS,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxDivergenceBps: boundedInteger(
      draft.maxOracleDivergenceBps,
      DEFAULT_ORACLE_DIVERGENCE_BPS,
      0,
      MAX_POLICY_BPS,
    ),
  };
}

function liquidityRewardProjection(input: {
  pair: PairConfig;
  quoteAssetId: string;
  quoteValueAtomic: bigint;
  estimatedEdgeBps: number;
  expectedDailyVolume?: string;
  targetAprPct?: number;
  protocolFeeBps?: number;
  maxRebateBps?: number;
  fullRebateEdgeBps?: number;
  zeroRebateEdgeBps?: number;
}): LiquidityPositionRewardProjection {
  const conversion = isConversionPair(input.pair);
  const protocolFeeBps = boundedNumber(
    input.protocolFeeBps,
    defaultProtocolFeeBps(input.pair),
    0,
    MAX_POLICY_BPS,
  );
  const maxRebateBps = boundedNumber(
    input.maxRebateBps,
    conversion ? Math.min(0.4, protocolFeeBps) : Math.min(1.5, protocolFeeBps),
    0,
    protocolFeeBps,
  );
  const fullRebateEdgeBps = boundedNumber(
    input.fullRebateEdgeBps,
    conversion ? 0.4 : 3,
    0,
    MAX_POLICY_BPS,
  );
  const zeroRebateEdgeBps = boundedNumber(
    input.zeroRebateEdgeBps,
    conversion ? 1.2 : 8,
    fullRebateEdgeBps,
    MAX_POLICY_BPS,
  );
  const estimatedEdgeBps = Math.max(0, input.estimatedEdgeBps);
  const rebateQuality = rebateQualityForEdge(
    estimatedEdgeBps,
    fullRebateEdgeBps,
    zeroRebateEdgeBps,
  );
  const estimatedRebateBps = roundMetric(maxRebateBps * rebateQuality);
  const netLpEdgeBps = roundMetric(estimatedEdgeBps + estimatedRebateBps);
  const quoteValue = atomicAsNumber(input.quoteValueAtomic, input.quoteAssetId);
  const expectedDailyVolume = optionalDecimalNumber(input.expectedDailyVolume);
  const expectedDailyTurnover =
    expectedDailyVolume !== null && quoteValue > 0
      ? expectedDailyVolume / quoteValue
      : null;
  const projectedAprPct =
    expectedDailyTurnover !== null
      ? roundMetric(expectedDailyTurnover * netLpEdgeBps * DAYS_PER_YEAR / 100)
      : null;
  const targetAprPct = boundedNumber(input.targetAprPct, Number.NaN, 0, 10_000);
  const normalizedTargetAprPct = Number.isFinite(targetAprPct) ? targetAprPct : null;
  const requiredDailyTurnover =
    normalizedTargetAprPct !== null && netLpEdgeBps > 0
      ? normalizedTargetAprPct * 100 / (netLpEdgeBps * DAYS_PER_YEAR)
      : null;
  const requiredDailyVolume =
    requiredDailyTurnover !== null && quoteValue > 0
      ? roundMetric(quoteValue * requiredDailyTurnover)
      : null;

  return {
    protocolFeeBps: roundMetric(protocolFeeBps),
    maxRebateBps: roundMetric(maxRebateBps),
    fullRebateEdgeBps: roundMetric(fullRebateEdgeBps),
    zeroRebateEdgeBps: roundMetric(zeroRebateEdgeBps),
    estimatedEdgeBps: roundMetric(estimatedEdgeBps),
    estimatedRebateBps,
    netLpEdgeBps,
    rebateQuality: roundMetric(rebateQuality),
    expectedDailyVolume,
    expectedDailyTurnover: expectedDailyTurnover === null ? null : roundMetric(expectedDailyTurnover),
    projectedAprPct,
    targetAprPct: normalizedTargetAprPct,
    requiredDailyTurnover: requiredDailyTurnover === null ? null : roundMetric(requiredDailyTurnover),
    requiredDailyVolume,
  };
}

function rebateQualityForEdge(
  edgeBps: number,
  fullRebateEdgeBps: number,
  zeroRebateEdgeBps: number,
): number {
  if (edgeBps <= fullRebateEdgeBps) return 1;
  if (edgeBps >= zeroRebateEdgeBps) return 0;
  const width = zeroRebateEdgeBps - fullRebateEdgeBps;
  return width <= 0 ? 0 : (zeroRebateEdgeBps - edgeBps) / width;
}

function defaultProtocolFeeBps(pair: PairConfig): number {
  if (Number.isFinite(pair.taker_fee_bps)) return Math.max(0, pair.taker_fee_bps ?? 0);
  return isConversionPair(pair) ? 1 : 4;
}

function isConversionPair(pair: PairConfig): boolean {
  return pair.pair_id === "USDC/USDT" || pair.pair_id === "WBTC/strkBTC";
}

function optionalDecimalNumber(value: string | undefined): number | null {
  if (value === undefined || !value.trim()) return null;
  const parsed = Number(value.trim().replaceAll(",", ""));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Position expected daily volume is invalid");
  }
  return parsed;
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 10_000) / 10_000;
}

function lifecycleRequest(
  draft: PrivateLiquidityPositionLifecycleDraft,
): PrivateLiquidityPositionLifecycleAuthorizationRequest {
  const seedHex = requiredString(draft.seedHex, "seed hex");
  const positionId = requiredString(draft.positionId, "position id");
  return {
    seed_hex: seedHex,
    position_id: positionId,
    prior_position_commitment: optionalString(
      draft.priorPositionCommitment,
      "prior position commitment",
    ),
    output_position_commitment: optionalString(
      draft.outputPositionCommitment,
      "output position commitment",
    ),
    epoch: unsignedIntegerString(draft.epoch, "epoch"),
    base_amount: unsignedIntegerString(draft.baseAmountAtomic ?? 0, "base amount"),
    quote_amount: unsignedIntegerString(draft.quoteAmountAtomic ?? 0, "quote amount"),
  };
}

function requirePriorAndOutput(
  request: PrivateLiquidityPositionLifecycleAuthorizationRequest,
  action: string,
): void {
  if (!request.prior_position_commitment || !request.output_position_commitment) {
    throw new Error(`Liquidity position ${action} authorization requires prior and output commitments`);
  }
}

function requiredString(value: string, label: string): string {
  const normalized = optionalString(value, label);
  if (!normalized) throw new Error(`Liquidity position ${label} is required`);
  return normalized;
}

function optionalString(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`Liquidity position ${label} is required`);
  return normalized;
}

function unsignedIntegerString(
  value: number | bigint | string,
  label: string,
): string {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`Liquidity position ${label} must be non-negative`);
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Liquidity position ${label} must be a safe non-negative integer`);
    }
    return String(value);
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Liquidity position ${label} must be a non-negative integer`);
  }
  return normalized.replace(/^0+(?=\d)/, "");
}

function buildBidCurve(input: {
  pair: PairConfig;
  lowPrice: bigint;
  highPrice: bigint;
  quoteReserve: bigint;
  priceBaseScale: bigint;
  bandCount: number;
  maxFillBasePerBatch: bigint;
}): LiquidityPositionCurve | undefined {
  const prices = priceLadder(input.lowPrice, input.highPrice, input.bandCount);
  const quoteAllocations = splitAmount(input.quoteReserve, prices.length);
  const rawPoints = prices.map((price, index) => ({
    price,
    baseAmount: mulDivFloor(quoteAllocations[index] ?? 0n, input.priceBaseScale, price),
  }));
  const points = capTotalBase(rawPoints, input.maxFillBasePerBatch);
  if (points.length < MIN_POSITION_BANDS || totalBase(points) === 0n) return undefined;
  return {
    side: "Buy",
    points: stringifyPoints(points, input.pair),
    totalBaseAmount: fromAtomicStr(totalBase(points).toString(), input.pair.base_asset_id),
    fundingAsset: input.pair.quote_asset_id,
    fundingAmount: fromAtomicStr(
      points
        .reduce(
          (sum, point) => sum + mulDivCeil(point.baseAmount, point.price, input.priceBaseScale),
          0n,
        )
        .toString(),
      input.pair.quote_asset_id,
    ),
  };
}

function buildAskCurve(input: {
  pair: PairConfig;
  lowPrice: bigint;
  highPrice: bigint;
  baseReserve: bigint;
  bandCount: number;
  maxFillBasePerBatch: bigint;
}): LiquidityPositionCurve | undefined {
  const prices = priceLadder(input.lowPrice, input.highPrice, input.bandCount);
  const baseAllocations = splitAmount(input.baseReserve, prices.length);
  const rawPoints = prices.map((price, index) => ({
    price,
    baseAmount: baseAllocations[index] ?? 0n,
  }));
  const points = capTotalBase(rawPoints, input.maxFillBasePerBatch);
  if (points.length < MIN_POSITION_BANDS || totalBase(points) === 0n) return undefined;
  return {
    side: "Sell",
    points: stringifyPoints(points, input.pair),
    totalBaseAmount: fromAtomicStr(totalBase(points).toString(), input.pair.base_asset_id),
    fundingAsset: input.pair.base_asset_id,
    fundingAmount: fromAtomicStr(totalBase(points).toString(), input.pair.base_asset_id),
  };
}

function validatePair(pair: PairConfig): void {
  if (!pair?.pair_id || !pair.base_asset_id || !pair.quote_asset_id) {
    throw new Error("Position pair configuration is invalid");
  }
  if (!pair.enabled) throw new Error("Position pair is disabled");
}

function nonNegativeAtomic(value: string, assetId: string, label: string): bigint {
  const normalized = normalizedDecimal(value, label);
  return BigInt(toAtomicStr(normalized, assetId));
}

function positivePriceAtomic(value: string, quoteAssetId: string, label: string): bigint {
  const normalized = normalizedDecimal(value, label);
  const atomic = BigInt(toPriceAtomicStr(normalized, quoteAssetId));
  if (atomic <= 0n) throw new Error(`Position ${label} must be positive at token precision`);
  return atomic;
}

function normalizedDecimal(value: string, label: string): string {
  const trimmed = value.trim().replaceAll(",", "");
  if (!trimmed || !/^\d*(\.\d*)?$/.test(trimmed) || trimmed === ".") {
    throw new Error(`Position ${label} is invalid`);
  }
  return trimmed;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new Error("Position numeric option must be an integer");
  return Math.min(max, Math.max(min, value));
}

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function priceLadder(low: bigint, high: bigint, count: number): bigint[] {
  if (count <= 1) return [low];
  const denominator = BigInt(count - 1);
  const prices = Array.from(
    { length: count },
    (_, index) => low + ((high - low) * BigInt(index)) / denominator,
  );
  if (prices.some((price, index) => index > 0 && price <= (prices[index - 1] ?? 0n))) {
    throw new Error("Position price range is too narrow for the selected band count");
  }
  return prices;
}

function capTotalBase(
  points: Array<{ price: bigint; baseAmount: bigint }>,
  maxFillBasePerBatch: bigint,
): Array<{ price: bigint; baseAmount: bigint }> {
  const total = totalBase(points);
  if (maxFillBasePerBatch <= 0n || total <= maxFillBasePerBatch) {
    return points.filter((point) => point.baseAmount > 0n);
  }
  const scaled = points.map((point) => ({
    ...point,
    baseAmount: mulDivFloor(point.baseAmount, maxFillBasePerBatch, total),
  }));
  let remainder = maxFillBasePerBatch - totalBase(scaled);
  for (let index = 0; index < scaled.length && remainder > 0n; index += 1) {
    const point = scaled[index];
    const original = points[index];
    if (!point || !original) continue;
    const capacity = original.baseAmount - point.baseAmount;
    const increment = minBigInt(capacity, remainder);
    point.baseAmount += increment;
    remainder -= increment;
  }
  return scaled.filter((point) => point.baseAmount > 0n);
}

function totalBase(points: Array<{ baseAmount: bigint }>): bigint {
  return points.reduce((sum, point) => sum + point.baseAmount, 0n);
}

function stringifyPoints(
  points: Array<{ price: bigint; baseAmount: bigint }>,
  pair: PairConfig,
): Array<{ price: string; baseAmount: string }> {
  return points.map((point) => ({
    price: fromAtomicStr(point.price.toString(), pair.quote_asset_id),
    baseAmount: fromAtomicStr(point.baseAmount.toString(), pair.base_asset_id),
  }));
}

function splitAmount(total: bigint, count: number): bigint[] {
  if (count <= 0) return [];
  const divisor = BigInt(count);
  const quotient = total / divisor;
  const remainder = total % divisor;
  return Array.from(
    { length: count },
    (_, index) => quotient + (BigInt(index) < remainder ? 1n : 0n),
  );
}

function ratioAsNumber(numerator: bigint, denominator: bigint, factor: number): number {
  if (denominator <= 0n) return 0;
  const precision = 1_000n;
  const scaled = (numerator * BigInt(factor) * precision) / denominator;
  return Number(scaled) / Number(precision);
}

function capitalEfficiency(minPrice: bigint, maxPrice: bigint, currentPrice: bigint): number {
  const width = maxPrice - minPrice;
  if (width <= 0n || currentPrice <= 0n) return 1;
  return Math.max(1, ratioAsNumber(currentPrice * 2n, width, 1));
}

function inventorySkewedReferencePrice(input: {
  baseReserve: bigint;
  quoteReserve: bigint;
  currentPrice: bigint;
  minPrice: bigint;
  maxPrice: bigint;
  priceBaseScale: bigint;
  policyKind: LiquidityPositionPolicyKind;
  targetBaseRatioBps: number;
  inventorySkewBps: number;
  maxPriceDeviationBps: number;
}): bigint {
  if (input.policyKind !== "InventorySkewed" || input.inventorySkewBps <= 0) {
    return input.currentPrice;
  }
  const baseValue = mulDivFloor(input.baseReserve, input.currentPrice, input.priceBaseScale);
  const totalValue = baseValue + input.quoteReserve;
  if (totalValue <= 0n) return input.currentPrice;

  const actualBaseRatio = mulDivFloor(baseValue, 10_000n, totalValue);
  const targetBaseRatio = BigInt(input.targetBaseRatioBps);
  const imbalance = actualBaseRatio > targetBaseRatio
    ? actualBaseRatio - targetBaseRatio
    : targetBaseRatio - actualBaseRatio;
  const shiftBps = minBigInt(
    mulDivFloor(imbalance, BigInt(input.inventorySkewBps), 10_000n),
    BigInt(input.maxPriceDeviationBps),
  );
  const priceDelta = mulDivFloor(input.currentPrice, shiftBps, 10_000n);
  const adjusted = actualBaseRatio > targetBaseRatio
    ? maxBigInt(input.currentPrice > priceDelta ? input.currentPrice - priceDelta : 1n, 1n)
    : input.currentPrice + priceDelta;
  return minBigInt(maxBigInt(adjusted, input.minPrice), input.maxPrice);
}

function curveTotalBaseAtomic(
  curve: LiquidityPositionCurve | undefined,
  baseAssetId: string,
): bigint {
  return curve ? BigInt(toAtomicStr(curve.totalBaseAmount, baseAssetId)) : 0n;
}

function pairPriceBaseScale(pair: PairConfig): bigint {
  const configured = pair.price_base_scale?.trim();
  const scale = configured && /^\d+$/.test(configured)
    ? BigInt(configured)
    : assetScale(pair.base_asset_id);
  if (scale <= 0n) throw new Error("Position pair price base scale must be positive");
  return scale;
}

function mulDivFloor(left: bigint, right: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Position arithmetic denominator must be positive");
  return (left * right) / denominator;
}

function mulDivCeil(left: bigint, right: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Position arithmetic denominator must be positive");
  const product = left * right;
  return product === 0n ? 0n : (product + denominator - 1n) / denominator;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function atomicAsNumber(value: bigint, assetId: string): number {
  const parsed = Number(fromAtomicStr(value.toString(), assetId));
  return Number.isFinite(parsed) ? parsed : Number.MAX_VALUE;
}
