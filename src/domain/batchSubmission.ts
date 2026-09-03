type RelayMode = "SelfRelay" | "ZylithRelay";

const PRIVATE_SUBMISSION_MAX_DELAY_MS = 0;
const HOSTED_RELAY_SUBMISSION_MAX_DELAY_MS = 0;
const DEFAULT_BATCH_WINDOW_MS = 20_000;
const HOSTED_RELAY_MIN_LEAD_MS = 120_000;
const MIN_BATCH_SUBMISSION_SAFETY_BUFFER_MS = 5_000;
const MAX_BATCH_SUBMISSION_SAFETY_BUFFER_MS = 15_000;
const BATCH_SUBMISSION_SAFETY_BUFFER_BPS = 2_000;

export type OrderIngressTelemetry = {
  version: 1;
  client_build_ms: number;
  private_submission_delay_ms: number;
  client_elapsed_before_private_ingress_ms: number;
  private_ingress_roundtrip_ms?: number;
  client_elapsed_before_coordinator_ms?: number;
  coordinator_roundtrip_ms?: number;
  batch_time_remaining_before_private_ingress_ms: number;
  batch_time_remaining_before_coordinator_ms?: number;
  submission_safety_buffer_ms: number;
};

export function hasBatchSubmissionSafetyWindow(
  closeTimeUnixMs: number,
  nowUnixMs = Date.now(),
  batchWindowMs?: number,
) {
  return closeTimeUnixMs - nowUnixMs > batchSubmissionSafetyBufferMs(batchWindowMs);
}

export function firstRenewalSlotEpoch(
  batch: { epoch_id: number; close_time_unix_ms: number },
  relayMode: RelayMode = "SelfRelay",
  nowUnixMs = Date.now(),
  batchWindowMs?: number,
) {
  if (relayMode === "ZylithRelay") {
    return batch.epoch_id + hostedRelayLeadEpochs(batchWindowMs);
  }
  return hasBatchSubmissionSafetyWindow(
    batch.close_time_unix_ms,
    nowUnixMs,
    batchWindowMs,
  )
    ? batch.epoch_id
    : batch.epoch_id + 1;
}

export function renewalPackageMaxSubmissionDelayMs(relayMode: RelayMode) {
  return relayMode === "ZylithRelay"
    ? HOSTED_RELAY_SUBMISSION_MAX_DELAY_MS
    : PRIVATE_SUBMISSION_MAX_DELAY_MS;
}

export function hostedRelayLeadEpochs(batchWindowMs?: number) {
  const parsedWindow = Number(batchWindowMs);
  const windowMs =
    Number.isFinite(parsedWindow) && parsedWindow > 0
      ? parsedWindow
      : DEFAULT_BATCH_WINDOW_MS;
  return Math.max(2, Math.ceil(HOSTED_RELAY_MIN_LEAD_MS / windowMs));
}

export function privateSubmissionDelayMs(
  closeTimeUnixMs?: number,
  submissionSafetyBufferMs = batchSubmissionSafetyBufferMs(),
) {
  if (PRIVATE_SUBMISSION_MAX_DELAY_MS <= 0) return 0;
  if (!closeTimeUnixMs) return 0;
  const timeUntilClose = closeTimeUnixMs - Date.now();
  const maxDelay = Math.min(
    PRIVATE_SUBMISSION_MAX_DELAY_MS,
    timeUntilClose - submissionSafetyBufferMs,
  );
  if (maxDelay <= 0) return 0;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return Math.floor((random[0] / 0x1_0000_0000) * maxDelay);
}

export function batchSubmissionSafetyBufferMs(batchWindowMs?: number) {
  const parsedWindow = Number(batchWindowMs);
  if (!Number.isFinite(parsedWindow) || parsedWindow <= 0) {
    return MAX_BATCH_SUBMISSION_SAFETY_BUFFER_MS;
  }
  return Math.max(
    MIN_BATCH_SUBMISSION_SAFETY_BUFFER_MS,
    Math.min(
      MAX_BATCH_SUBMISSION_SAFETY_BUFFER_MS,
      Math.floor((parsedWindow * BATCH_SUBMISSION_SAFETY_BUFFER_BPS) / 10_000),
    ),
  );
}

export function delay(ms: number) {
  return ms > 0
    ? new Promise((resolve) => window.setTimeout(resolve, ms))
    : Promise.resolve();
}

export function elapsedMs(start: number, end = performance.now()) {
  return Math.max(0, Math.round(end - start));
}

export function remainingBatchMs(closeTimeUnixMs: number) {
  return Math.max(0, closeTimeUnixMs - Date.now());
}

export function attachOrderIngressTelemetry<T>(
  payload: T,
  telemetry: OrderIngressTelemetry,
): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return {
    ...(payload as Record<string, unknown>),
    ingress_telemetry: telemetry,
  } as T;
}
