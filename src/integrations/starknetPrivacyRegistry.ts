import {
  AddressMap,
  Channel,
  Witness,
  createEmptyRegistry,
} from "@starkware-libs/starknet-privacy-sdk/browser";
import type {
  Note,
  PrivateRegistry,
} from "@starkware-libs/starknet-privacy-sdk";

type SerializedAddressMapEntry<T> = [string, T];

export type SerializedStarknetPrivacyRegistry = {
  version: 1;
  channels: Array<SerializedAddressMapEntry<SerializedChannel>>;
  notes: Array<SerializedAddressMapEntry<SerializedNote[]>>;
  cursor?: SerializedNotesCursor;
};

type SerializedChannel = {
  public_key: string;
  key?: string;
  tokens: Array<SerializedAddressMapEntry<{ token_index: number; note_nonce: number }>>;
};

type SerializedNote = {
  id: string;
  amount: string;
  created?: number;
  sender: string;
  open?: boolean;
  viewing_key?: string;
  witness: {
    channel_key: string;
    nonce: number;
    r: string;
  };
};

type SerializedNotesCursor = {
  block_id: number;
  incoming_channels: Array<SerializedAddressMapEntry<{
    channel_key: string;
    subchannel_id_index: number;
    note_indexes: Array<SerializedAddressMapEntry<number>>;
    total_note_counts: Array<SerializedAddressMapEntry<number>>;
  }>>;
};

const MAX_REGISTRY_CHANNELS = 256;
const MAX_REGISTRY_TOKENS = 256;
const MAX_REGISTRY_NOTES = 20_000;
const MAX_CURSOR_CHANNELS = 256;
const MAX_U256 = (1n << 256n) - 1n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUnsignedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string"
    && /^(0|[1-9]\d{0,77})$/.test(value)
    && BigInt(value) <= MAX_U256;
}

function assertUniqueAddressEntries(value: unknown, label: string, limit: number): asserts value is Array<[string, unknown]> {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`Encrypted privacy registry ${label} is too large.`);
  }
  const keys = new Set<string>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isDecimal(entry[0])) {
      throw new Error(`Encrypted privacy registry ${label} is malformed.`);
    }
    const key = BigInt(entry[0]).toString();
    if (keys.has(key)) throw new Error(`Encrypted privacy registry ${label} contains duplicate addresses.`);
    keys.add(key);
  }
}

function assertSerializedRegistry(value: unknown): asserts value is SerializedStarknetPrivacyRegistry {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Encrypted privacy registry is malformed.");
  }
  assertUniqueAddressEntries(value.channels, "channels", MAX_REGISTRY_CHANNELS);
  assertUniqueAddressEntries(value.notes, "tokens", MAX_REGISTRY_TOKENS);
  let noteCount = 0;
  for (const [, channelValue] of value.channels) {
    if (!isRecord(channelValue) || !isDecimal(channelValue.public_key) || (channelValue.key !== undefined && !isDecimal(channelValue.key))) {
      throw new Error("Encrypted privacy registry channel is malformed.");
    }
    assertUniqueAddressEntries(channelValue.tokens, "channel tokens", MAX_REGISTRY_TOKENS);
    for (const [, tokenValue] of channelValue.tokens) {
      if (!isRecord(tokenValue) || !isUnsignedInteger(tokenValue.token_index) || !isUnsignedInteger(tokenValue.note_nonce)) {
        throw new Error("Encrypted privacy registry channel token is malformed.");
      }
    }
  }
  for (const [, notesValue] of value.notes) {
    if (!Array.isArray(notesValue)) throw new Error("Encrypted privacy registry notes are malformed.");
    noteCount += notesValue.length;
    if (noteCount > MAX_REGISTRY_NOTES) throw new Error("Encrypted privacy registry notes are too large.");
    const noteIds = new Set<string>();
    for (const note of notesValue) {
      if (
        !isRecord(note)
        || !isDecimal(note.id)
        || !isDecimal(note.amount)
        || !isDecimal(note.sender)
        || (note.created !== undefined && !isUnsignedInteger(note.created))
        || (note.open !== undefined && typeof note.open !== "boolean")
        || (note.viewing_key !== undefined && !isDecimal(note.viewing_key))
        || !isRecord(note.witness)
        || !isDecimal(note.witness.channel_key)
        || !isUnsignedInteger(note.witness.nonce)
        || !isDecimal(note.witness.r)
      ) throw new Error("Encrypted privacy registry note is malformed.");
      const id = BigInt(note.id).toString();
      if (noteIds.has(id)) throw new Error("Encrypted privacy registry contains duplicate notes.");
      noteIds.add(id);
    }
  }
  if (value.cursor === undefined) return;
  if (!isRecord(value.cursor) || !isUnsignedInteger(value.cursor.block_id)) {
    throw new Error("Encrypted privacy registry cursor is malformed.");
  }
  assertUniqueAddressEntries(value.cursor.incoming_channels, "cursor channels", MAX_CURSOR_CHANNELS);
  for (const [, cursorValue] of value.cursor.incoming_channels) {
    if (!isRecord(cursorValue) || !isDecimal(cursorValue.channel_key) || !isUnsignedInteger(cursorValue.subchannel_id_index)) {
      throw new Error("Encrypted privacy registry cursor channel is malformed.");
    }
    assertUniqueAddressEntries(cursorValue.note_indexes, "cursor note indexes", MAX_REGISTRY_TOKENS);
    assertUniqueAddressEntries(cursorValue.total_note_counts, "cursor note counts", MAX_REGISTRY_TOKENS);
    for (const [, index] of [...cursorValue.note_indexes, ...cursorValue.total_note_counts]) {
      if (!isUnsignedInteger(index)) throw new Error("Encrypted privacy registry cursor value is malformed.");
    }
  }
}

export function serializeStarknetPrivacyRegistry(
  registry: PrivateRegistry,
): SerializedStarknetPrivacyRegistry {
  const serialized: SerializedStarknetPrivacyRegistry = {
    version: 1,
    channels: [...registry.channels.entries()].map(([recipient, channel]) => [
      encodeBigint(recipient),
      serializeChannel(channel),
    ]),
    notes: [...registry.notes.entries()].map(([token, notes]) => [
      encodeBigint(token),
      notes.map(serializeNote),
    ]),
    cursor: registry.cursor ? serializeNotesCursor(registry.cursor) : undefined,
  };
  assertSerializedRegistry(serialized);
  return serialized;
}

export function deserializeStarknetPrivacyRegistry(
  serialized?: SerializedStarknetPrivacyRegistry | null,
): PrivateRegistry {
  if (!serialized) return createEmptyRegistry();
  assertSerializedRegistry(serialized);
  const registry = createEmptyRegistry();
  registry.channels = new AddressMap(
    serialized.channels.map(([recipient, channel]) => [
      BigInt(recipient),
      deserializeChannel(channel),
    ] as const),
  );
  registry.notes = new AddressMap(
    serialized.notes.map(([token, notes]) => [
      BigInt(token),
      notes.map(deserializeNote),
    ] as const),
    () => [],
  );
  registry.cursor = serialized.cursor ? deserializeNotesCursor(serialized.cursor) : undefined;
  return registry;
}

function serializeChannel(channel: Channel): SerializedChannel {
  const raw = channel as unknown as {
    publicKey: bigint;
    key?: bigint;
    tokens: AddressMap<{ tokenIndex: number; noteNonce: number }>;
  };
  return {
    public_key: encodeBigint(raw.publicKey),
    key: raw.key === undefined ? undefined : encodeBigint(raw.key),
    tokens: [...raw.tokens.entries()].map(([token, state]) => [
      encodeBigint(token),
      {
        token_index: Number(state.tokenIndex),
        note_nonce: Number(state.noteNonce),
      },
    ]),
  };
}

function deserializeChannel(serialized: SerializedChannel): Channel {
  return new Channel(
    BigInt(serialized.public_key),
    serialized.key === undefined ? undefined : BigInt(serialized.key),
    serialized.tokens.map(([token, state]) => [
      BigInt(token),
      {
        tokenIndex: Number(state.token_index),
        noteNonce: Number(state.note_nonce),
      },
    ]),
  );
}

function serializeNote(note: Note): SerializedNote {
  const witness = note.witness as unknown as { channelKey: bigint; nonce: number; r: bigint };
  return {
    id: encodeBigint(note.id),
    amount: encodeBigint(note.amount),
    created: typeof note.created === "number" ? note.created : undefined,
    sender: encodeBigint(note.sender),
    open: note.open,
    viewing_key: note.viewingKey === undefined ? undefined : encodeBigint(note.viewingKey),
    witness: {
      channel_key: encodeBigint(witness.channelKey),
      nonce: Number(witness.nonce),
      r: encodeBigint(witness.r),
    },
  };
}

function deserializeNote(serialized: SerializedNote): Note {
  return {
    id: BigInt(serialized.id),
    amount: BigInt(serialized.amount),
    created: serialized.created,
    sender: BigInt(serialized.sender),
    open: serialized.open,
    viewingKey: serialized.viewing_key === undefined ? undefined : BigInt(serialized.viewing_key),
    witness: new Witness(
      BigInt(serialized.witness.channel_key),
      Number(serialized.witness.nonce),
      BigInt(serialized.witness.r),
    ),
  };
}

function serializeNotesCursor(cursor: unknown): SerializedNotesCursor {
  const raw = cursor as {
    blockId?: number;
    incomingChannels?: AddressMap<{
      channelKey: bigint;
      subchannelIdIndex: number;
      noteIndexes: AddressMap<number>;
      totalNoteCounts: AddressMap<number>;
    }>;
  };
  return {
    block_id: Number(raw.blockId ?? 0),
    incoming_channels: [...(raw.incomingChannels?.entries() ?? [])].map(([sender, channel]) => [
      encodeBigint(sender),
      {
        channel_key: encodeBigint(channel.channelKey),
        subchannel_id_index: Number(channel.subchannelIdIndex ?? 0),
        note_indexes: serializeNumberAddressMap(channel.noteIndexes),
        total_note_counts: serializeNumberAddressMap(channel.totalNoteCounts),
      },
    ]),
  };
}

function deserializeNotesCursor(serialized: SerializedNotesCursor) {
  return {
    blockId: Number(serialized.block_id ?? 0),
    incomingChannels: new AddressMap(
      serialized.incoming_channels.map(([sender, channel]) => [
        BigInt(sender),
        {
          channelKey: BigInt(channel.channel_key),
          subchannelIdIndex: Number(channel.subchannel_id_index),
          noteIndexes: new AddressMap(
            channel.note_indexes.map(([token, index]) => [BigInt(token), Number(index)] as const),
          ),
          totalNoteCounts: new AddressMap(
            channel.total_note_counts.map(([token, count]) => [BigInt(token), Number(count)] as const),
          ),
        },
      ] as const),
    ),
  };
}

function serializeNumberAddressMap(map?: AddressMap<number>) {
  return [...(map?.entries() ?? [])].map(([key, value]) => [
    encodeBigint(key),
    Number(value),
  ] as SerializedAddressMapEntry<number>);
}

function encodeBigint(value: unknown) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return BigInt(value).toString();
  if (typeof value === "string") return BigInt(value).toString();
  throw new Error("Cannot serialize private deposit registry value");
}
