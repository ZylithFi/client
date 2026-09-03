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

  it("backs off and retries prover capacity errors", async () => {
    const stages: string[] = [];
    const delays: number[] = [];
    let attempts = 0;
    const result = await runProofDelayRetryLoop({
      proofDelayScheduleBlocks: [10, 16, 24],
      retryStagePrefix: "Private deposit",
      fallbackErrorMessage: "failed",
      classifier: {
        isProofBlockTooRecent: () => false,
        isContractVisibilityLag: () => false,
        isProviderBusy: (error) =>
          error instanceof Error && error.message === "busy",
      },
      setStage: (stage) => stages.push(stage),
      providerBusyMaxRetries: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
      runAttempt: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("busy");
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(delays).toEqual([30_000]);
    expect(stages).toEqual([
      "Private deposit prover busy; retrying proof (1 of 3)",
    ]);
  });

  it("does not consume proof-delay attempts while the prover is busy", async () => {
    const delays: number[] = [];
    const proofAttempts: number[] = [];
    let calls = 0;
    const result = await runProofDelayRetryLoop({
      proofDelayScheduleBlocks: [10, 16],
      retryStagePrefix: "Private deposit",
      fallbackErrorMessage: "failed",
      classifier: {
        isProofBlockTooRecent: () => false,
        isContractVisibilityLag: () => false,
        isProviderBusy: (error) =>
          error instanceof Error && error.message === "busy",
      },
      setStage: () => undefined,
      providerBusyMaxRetries: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
      runAttempt: async (_proofDelayBlocks, attempt) => {
        calls += 1;
        proofAttempts.push(attempt);
        if (calls <= 2) throw new Error("busy");
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(proofAttempts).toEqual([0, 0, 0]);
    expect(delays).toEqual([30_000, 30_000]);
  });

  it("retries transient proof-provider network errors without consuming proof-delay attempts", async () => {
    const stages: string[] = [];
    const delays: number[] = [];
    const proofAttempts: number[] = [];
    let calls = 0;
    const result = await runProofDelayRetryLoop({
      proofDelayScheduleBlocks: [10, 16],
      retryStagePrefix: "Private deposit",
      fallbackErrorMessage: "failed",
      classifier: {
        isProofBlockTooRecent: () => false,
        isContractVisibilityLag: () => false,
        isProviderTransient: (error) =>
          error instanceof Error && error.message === "network",
      },
      setStage: (stage) => stages.push(stage),
      providerTransientMaxRetries: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
      runAttempt: async (_proofDelayBlocks, attempt) => {
        calls += 1;
        proofAttempts.push(attempt);
        if (calls === 1) throw new Error("network");
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(proofAttempts).toEqual([0, 0]);
    expect(delays).toEqual([10_000]);
    expect(stages).toEqual([
      "Private deposit proof transport retrying (1 of 3)",
    ]);
  });

  it("retries expired proofs with a fresher proof block", async () => {
    const stages: string[] = [];
    const delays: number[] = [];
    const proofAttempts: number[] = [];
    const proofDelays: number[] = [];
    let calls = 0;
    const result = await runProofDelayRetryLoop({
      proofDelayScheduleBlocks: [10, 16, 24],
      retryStagePrefix: "Private deposit",
      fallbackErrorMessage: "failed",
      setStage: (stage) => stages.push(stage),
      proofExpiredMaxRetries: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
      runAttempt: async (proofDelayBlocks, attempt) => {
        calls += 1;
        proofAttempts.push(attempt);
        proofDelays.push(proofDelayBlocks);
        if (calls === 1) throw new Error("too recent");
        if (calls === 2) throw new Error("expired");
        return "ok";
      },
      classifier: {
        isProofBlockTooRecent: (error) =>
          error instanceof Error && error.message === "too recent",
        isProofExpired: (error) =>
          error instanceof Error && error.message === "expired",
        isContractVisibilityLag: () => false,
      },
    });

    expect(result).toBe("ok");
    expect(proofAttempts).toEqual([0, 1, 0]);
    expect(proofDelays).toEqual([10, 16, 10]);
    expect(delays).toEqual([5_000, 5_000]);
    expect(stages).toEqual([
      "Private deposit proof retrying with an older proof block (attempt 2 of 3)",
      "Private deposit proof expired before submission; retrying with a fresher proof (1 of 3)",
    ]);
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
