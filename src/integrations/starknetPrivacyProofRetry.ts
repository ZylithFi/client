export type ProofRetryClassifier = {
  isProofBlockTooRecent: (error: unknown) => boolean;
  isProofExpired?: (error: unknown) => boolean;
  isContractVisibilityLag: (error: unknown) => Promise<boolean> | boolean;
  isProviderBusy?: (error: unknown) => boolean;
  isProviderTransient?: (error: unknown) => boolean;
};

export type ProofRetryLoopInput<T> = {
  proofDelayScheduleBlocks: readonly number[];
  retryStagePrefix: string;
  fallbackErrorMessage: string;
  classifier: ProofRetryClassifier;
  setStage: (stage: string) => void;
  sleep?: (ms: number) => Promise<void>;
  providerBusyMaxRetries?: number;
  providerBusyRetryDelayMs?: number;
  providerTransientMaxRetries?: number;
  providerTransientRetryDelayMs?: number;
  proofExpiredMaxRetries?: number;
  proofExpiredRetryDelayMs?: number;
  runAttempt: (proofDelayBlocks: number, attempt: number) => Promise<T>;
};

const DEFAULT_PROVIDER_BUSY_MAX_RETRIES = 90;
const DEFAULT_PROVIDER_BUSY_RETRY_DELAY_MS = 30_000;
const DEFAULT_PROVIDER_TRANSIENT_MAX_RETRIES = 12;
const DEFAULT_PROVIDER_TRANSIENT_RETRY_DELAY_MS = 10_000;
const DEFAULT_PROOF_EXPIRED_MAX_RETRIES = 5;
const DEFAULT_PROOF_EXPIRED_RETRY_DELAY_MS = 5_000;

export async function runProofDelayRetryLoop<T>(
  input: ProofRetryLoopInput<T>,
): Promise<T> {
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastRetryableError: unknown = null;
  let providerBusyRetries = 0;
  let providerTransientRetries = 0;
  let proofExpiredRetries = 0;
  const providerBusyMaxRetries =
    input.providerBusyMaxRetries ?? DEFAULT_PROVIDER_BUSY_MAX_RETRIES;
  const providerBusyRetryDelayMs =
    input.providerBusyRetryDelayMs ?? DEFAULT_PROVIDER_BUSY_RETRY_DELAY_MS;
  const providerTransientMaxRetries =
    input.providerTransientMaxRetries ?? DEFAULT_PROVIDER_TRANSIENT_MAX_RETRIES;
  const providerTransientRetryDelayMs =
    input.providerTransientRetryDelayMs ?? DEFAULT_PROVIDER_TRANSIENT_RETRY_DELAY_MS;
  const proofExpiredMaxRetries =
    input.proofExpiredMaxRetries ?? DEFAULT_PROOF_EXPIRED_MAX_RETRIES;
  const proofExpiredRetryDelayMs =
    input.proofExpiredRetryDelayMs ?? DEFAULT_PROOF_EXPIRED_RETRY_DELAY_MS;
  for (let attempt = 0; attempt < input.proofDelayScheduleBlocks.length;) {
    try {
      return await input.runAttempt(input.proofDelayScheduleBlocks[attempt], attempt);
    } catch (error) {
      const contractVisibilityLag = await input.classifier.isContractVisibilityLag(error);
      const providerBusy = input.classifier.isProviderBusy?.(error) ?? false;
      const providerTransient =
        input.classifier.isProviderTransient?.(error) ?? false;
      const proofExpired = input.classifier.isProofExpired?.(error) ?? false;
      if (providerBusy && providerBusyRetries < providerBusyMaxRetries) {
        providerBusyRetries += 1;
        lastRetryableError = error;
        input.setStage(
          `${input.retryStagePrefix} prover busy; retrying proof (${providerBusyRetries} of ${providerBusyMaxRetries})`,
        );
        await sleep(providerBusyRetryDelayMs);
        continue;
      }
      if (
        providerTransient &&
        providerTransientRetries < providerTransientMaxRetries
      ) {
        providerTransientRetries += 1;
        lastRetryableError = error;
        input.setStage(
          `${input.retryStagePrefix} proof transport retrying (${providerTransientRetries} of ${providerTransientMaxRetries})`,
        );
        await sleep(providerTransientRetryDelayMs);
        continue;
      }
      if (proofExpired && proofExpiredRetries < proofExpiredMaxRetries) {
        proofExpiredRetries += 1;
        lastRetryableError = error;
        if (attempt > 0) attempt -= 1;
        input.setStage(
          `${input.retryStagePrefix} proof expired before submission; retrying with a fresher proof (${proofExpiredRetries} of ${proofExpiredMaxRetries})`,
        );
        await sleep(proofExpiredRetryDelayMs);
        continue;
      }
      const retryable =
        input.classifier.isProofBlockTooRecent(error) || contractVisibilityLag;
      if (attempt < input.proofDelayScheduleBlocks.length - 1 && retryable) {
        lastRetryableError = error;
        attempt += 1;
        input.setStage(
          `${input.retryStagePrefix} proof retrying with an older proof block (attempt ${attempt + 1} of ${input.proofDelayScheduleBlocks.length})`,
        );
        await sleep(contractVisibilityLag ? 15_000 : 5_000);
        continue;
      }
      throw error;
    }
  }
  throw lastRetryableError instanceof Error
    ? lastRetryableError
    : new Error(input.fallbackErrorMessage);
}
