// size-class padding for encrypted payloads whose length would otherwise reveal
// wallet activity. sealed operator requests pad inside the envelope, in wasm.

// plaintext classes for encrypted recovery snapshots. the top class stays under
// the coordinator's 1 mib hex-ciphertext limit.
const RECOVERY_SNAPSHOT_SIZE_CLASSES = [16_384, 65_536, 262_144, 520_000] as const;

/**
 * pads an encrypted recovery snapshot's plaintext to a coarse size class so the
 * stored ciphertext length does not track the wallet's note/order count. the
 * padding is inside the ciphertext, so it needs no randomness.
 */
export function padRecoverySnapshotPayload<T extends Record<string, unknown>>(
  payload: T
): T & { padding: string } {
  const padded = { ...payload, padding: "" };
  const baseBytes = new TextEncoder().encode(JSON.stringify(padded)).length;
  const targetBytes = RECOVERY_SNAPSHOT_SIZE_CLASSES.find(
    (sizeClass) => sizeClass >= baseBytes
  );
  // past the largest class the length would track the wallet again, so it refuses.
  if (!targetBytes) throw new Error("The recovery snapshot exceeds the largest size class");
  padded.padding = "0".repeat(targetBytes - baseBytes);
  return padded;
}
