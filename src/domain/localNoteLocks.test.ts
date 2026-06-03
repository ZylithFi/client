import { describe, expect, it } from "vitest";
import { normalizeLocalLockRef, retainedLocalNoteLockRefs } from "./localNoteLocks";

describe("local note lock retention", () => {
  it("normalizes equivalent lock references", () => {
    expect(normalizeLocalLockRef("0x000A")).toBe("0xa");
    expect(normalizeLocalLockRef("10")).toBe("0xa");
    expect(normalizeLocalLockRef("")).toBe("");
  });

  it("retains only known order, parent strategy, and child strategy lock refs", () => {
    const refs = retainedLocalNoteLockRefs(
      [
        { orderCommitment: "0x01", status: "in_batch" },
        { orderCommitment: "", status: "in_batch" },
        { orderCommitment: "0x0000", status: "in_batch" },
      ],
      [
        {
          status: "active",
          parent_order_commitment: "0x02",
          submitted_children: [
            {
              parent_child_index: 0,
              batch_id: "batch-a",
              epoch_id: 1,
              order_commitment: "0x03",
              cancellation_secret: "0x04",
              submitted_at_unix_ms: 0,
            },
          ],
        },
      ],
    );

    expect(refs.sort()).toEqual(["0x1", "0x2", "0x3"]);
  });

  it("retains strategy child lock refs until runtime reconciliation clears them", () => {
    const refs = retainedLocalNoteLockRefs(
      [],
      [
        {
          status: "completed",
          parent_order_commitment: "0x02",
          submitted_children: [
            {
              parent_child_index: 0,
              batch_id: "batch-a",
              epoch_id: 1,
              order_commitment: "0x03",
              cancellation_secret: "0x04",
              submitted_at_unix_ms: 1,
            },
          ],
        },
        {
          status: "cancelled",
          parent_order_commitment: "0x04",
          submitted_children: [],
        },
      ],
    );

    expect(refs.sort()).toEqual(["0x2", "0x3", "0x4"]);
  });

  it("retains proof-failed, stalled, and no-fill order refs until authoritative reconciliation", () => {
    const refs = retainedLocalNoteLockRefs(
      [
        { orderCommitment: "0x01", status: "proof_failed" },
        { orderCommitment: "0x02", status: "stalled" },
        { orderCommitment: "0x03", status: "no_fill" },
      ],
      [],
    );

    expect(refs.sort()).toEqual(["0x1", "0x2", "0x3"]);
  });
});
