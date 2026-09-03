import {
  AddressMap,
  Channel,
  Witness,
} from "@starkware-libs/starknet-privacy-sdk/browser";
import type {
  Note,
  PrivateRegistry,
} from "@starkware-libs/starknet-privacy-sdk";
import { describe, expect, it } from "vitest";
import {
  deserializeStarknetPrivacyRegistry,
  serializeStarknetPrivacyRegistry,
} from "./starknetPrivacyRegistry";

describe("Starknet Privacy registry persistence", () => {
  it("round-trips channels, notes, and discovery cursor state", () => {
    const note: Note = {
      id: 0xabcden,
      amount: 1_000_000n,
      sender: 0x123n,
      created: 42,
      viewingKey: 0x999n,
      witness: new Witness(0x777n, 3, 0x888n),
    };
    const registry: PrivateRegistry = {
      channels: new AddressMap([
        [
          0x123n,
          new Channel(0x456n, 0x789n, [[0xaaan, { tokenIndex: 2, noteNonce: 5 }]]),
        ],
      ]),
      notes: new AddressMap([[0xaaan, [note]]], () => []),
      cursor: {
        blockId: 100,
        incomingChannels: new AddressMap([
          [
            0x123n,
            {
              channelKey: 0x789n,
              subchannelIdIndex: 2,
              noteIndexes: new AddressMap([[0xaaan, 5]]),
              totalNoteCounts: new AddressMap([[0xaaan, 6]]),
            },
          ],
        ]),
      } as never,
    };

    const restored = deserializeStarknetPrivacyRegistry(
      serializeStarknetPrivacyRegistry(registry),
    );

    expect(restored.notes.get(0xaaan)?.[0]?.amount).toBe(1_000_000n);
    expect(restored.channels.get(0x123n)?.toSetupRequirement(0xaaan)).toBe(3);
    const cursor = restored.cursor as never as {
      blockId: number;
      incomingChannels: AddressMap<{
        noteIndexes: AddressMap<number>;
        totalNoteCounts: AddressMap<number>;
      }>;
    };
    expect(cursor.blockId).toBe(100);
    expect(cursor.incomingChannels.get(0x123n)?.noteIndexes.get(0xaaan)).toBe(5);
    expect(cursor.incomingChannels.get(0x123n)?.totalNoteCounts.get(0xaaan)).toBe(6);
  });
});
