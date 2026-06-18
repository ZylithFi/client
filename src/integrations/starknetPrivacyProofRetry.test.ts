import { describe, expect, it } from "vitest";
import { runProofDelayRetryLoop } from "./starknetPrivacyProofRetry";

describe("runProofDelayRetryLoop", () => {
  it("retries proof-block-too-recent errors with older proof blocks", async () => {
    const stages: string[] = [];
    const delays: number[] = [];
    let attempts = 0;
    const result = await runProofDelayRetryLoop({
      proofDelayScheduleBlocks: [10, 16, 24],
      retryStagePrefix: "Private deposit",
      fallbackErrorMessage: "failed",
      classifier: {
        isProofBlockTooRecent: (error) =>
          error instanceof Error && error.message === "too recent",
        isContractVisibilityLag: () => false,
      },
      setStage: (stage) => stages.push(stage),
      sleep: async (ms) => {
        delays.push(ms);
      },
      runAttempt: async (proofDelayBlocks) => {
        attempts += 1;
        if (attempts === 1) throw new Error("too recent");
        return proofDelayBlocks;
      },
    });

    expect(result).toBe(16);
    expect(delays).toEqual([5_000]);
    expect(stages).toEqual([
      "Private deposit proof retrying with an older proof block (attempt 2 of 3)",
    ]);
  });

  it("uses the longer delay for contract visibility lag", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await runProofDelayRetryLoop({
      proofDelayScheduleBlocks: [10, 16],
      retryStagePrefix: "Private withdrawal",
      fallbackErrorMessage: "failed",
      classifier: {
        isProofBlockTooRecent: () => false,
        isContractVisibilityLag: (error) =>
          error instanceof Error && error.message === "visibility lag",
      },
      setStage: () => undefined,
      sleep: async (ms) => {
        delays.push(ms);
      },
      runAttempt: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("visibility lag");
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(delays).toEqual([15_000]);
  });

  it("does not retry non-retryable errors", async () => {
    await expect(
      runProofDelayRetryLoop({
        proofDelayScheduleBlocks: [10, 16],
        retryStagePrefix: "Private deposit",
        fallbackErrorMessage: "failed",
        classifier: {
          isProofBlockTooRecent: () => false,
          isContractVisibilityLag: () => false,
        },
        setStage: () => undefined,
        sleep: async () => undefined,
        runAttempt: async () => {
          throw new Error("bad proof");
        },
      }),
    ).rejects.toThrow("bad proof");
  });
});
