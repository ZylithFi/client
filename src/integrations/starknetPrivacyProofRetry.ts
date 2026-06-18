export type ProofRetryClassifier = {
  isProofBlockTooRecent: (error: unknown) => boolean;
  isContractVisibilityLag: (error: unknown) => Promise<boolean> | boolean;
};

export type ProofRetryLoopInput<T> = {
  proofDelayScheduleBlocks: readonly number[];
  retryStagePrefix: string;
  fallbackErrorMessage: string;
  classifier: ProofRetryClassifier;
  setStage: (stage: string) => void;
  sleep?: (ms: number) => Promise<void>;
  runAttempt: (proofDelayBlocks: number, attempt: number) => Promise<T>;
};

export async function runProofDelayRetryLoop<T>(
  input: ProofRetryLoopInput<T>,
): Promise<T> {
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastRetryableError: unknown = null;
  for (let attempt = 0; attempt < input.proofDelayScheduleBlocks.length; attempt += 1) {
    try {
      return await input.runAttempt(input.proofDelayScheduleBlocks[attempt], attempt);
    } catch (error) {
      const contractVisibilityLag = await input.classifier.isContractVisibilityLag(error);
      const retryable =
        input.classifier.isProofBlockTooRecent(error) || contractVisibilityLag;
      if (attempt < input.proofDelayScheduleBlocks.length - 1 && retryable) {
        lastRetryableError = error;
        input.setStage(
          `${input.retryStagePrefix} proof retrying with an older proof block (attempt ${attempt + 2} of ${input.proofDelayScheduleBlocks.length})`,
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
