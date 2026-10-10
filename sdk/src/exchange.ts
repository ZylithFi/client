import {
  DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
  fetchWithSdkTimeout,
  normalizeSdkServiceUrl,
  readSdkJsonResponse,
  readSdkResponseText,
  sanitizeSdkErrorMessage,
} from "./common.js";

/** transitions are fetched in globally aligned windows, so a range names no wallet's orders. */
export const TRANSITION_WINDOW = 64;
/** the indexer serves at most this many transitions per request. */
const MAX_TRANSITION_RANGE = 256;
const HPKE_PROFILE = "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20Poly1305/base" as const;
const X25519_FIELD_PRIME = `ed${"ff".repeat(30)}7f`;
const X25519_LOW_ORDER_KEYS = new Set([
  `01${"00".repeat(31)}`,
  `ec${"ff".repeat(30)}7f`,
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
]);
const RESPONSE_ENVELOPE_VERSION = 3 as const;
const RESPONSE_PLAINTEXT_BYTES = 16_384;
const RESPONSE_CIPHERTEXT_BYTES = RESPONSE_PLAINTEXT_BYTES + 16;
const RESPONSE_CIPHERTEXT_PATTERN = /^[0-9a-f]{32800}$/;
const RESPONSE_KEY_INFO_DOMAIN = new TextEncoder().encode("zylith-response-key-hkdf-sha256-v3");
const RESPONSE_AAD_DOMAIN = new TextEncoder().encode("zylith-response-aad-v3");

export type ExecutionKeyRegistry = {
  keys: Array<{
    key_id: string;
    algorithm: typeof HPKE_PROFILE;
    public_key: string;
  }>;
};

/** one fixed-size request sealed to the active execution key; its kind is inside. */
export type SealedRequest = {
  version: 3;
  key_id: string;
  digest: string;
  encapsulated_key: string;
  ciphertext: string;
};

/** the operator's answer, sealed under a fresh subkey of the request's response root key. */
export type SealedResponse = {
  version: typeof RESPONSE_ENVELOPE_VERSION;
  salt: string;
  nonce: string;
  ciphertext: string;
};

export type ExchangeStatus = {
  exchange: string;
  seq: number;
  last_close_ms: number;
  epoch_ms: number;
  pairs: string[];
  registry_version: number;
  registry_hash: string;
};

export type ReferencePrice = {
  pair: string;
  /** quote atoms per `scale` base atoms. */
  midpoint: string;
  scale: string;
  observed_at_ms: number;
  valid_until_ms: number;
};

export type OrderReport = {
  order_id: string;
  admitted: boolean;
  external_base: string;
  external_quote: string;
  fill_base: string;
  fill_quote: string;
  fee: string;
  proceeds: string;
  refund: string;
  /** base reserved for the external leg this transition opened. */
  reserved: string;
  removal: "Completed" | "Cancelled" | "Expired" | "Recovered" | null;
};

export type OrderEvent = {
  seq: number;
  close_time_ms: number;
  report: OrderReport;
};

export type OrderStatus = {
  order_id: string;
  status: "pending" | "live" | "closed" | "unknown";
  cancel_requested: boolean;
  /** the oldest events after the queried seq, a bounded number per answer. */
  events: OrderEvent[];
  /** more events follow the returned ones: ask again from the last returned seq. */
  more_events: boolean;
  /** for a closed order, the transition that removed it and how; kept after its history is pruned. */
  closed_seq: number | null;
  removal: OrderReport["removal"];
};

export type WithdrawalStage =
  | "Proving"
  | { Requested: { transaction_hash: string; matures_at_ms: number } }
  | { Finalizing: { transaction_hash: string } }
  | { Finalized: { transaction_hash: string } }
  | { Failed: { reason: string } };

export type WithdrawalStatus = {
  nullifier: string;
  /** null when the operator has no such withdrawal. */
  stage: WithdrawalStage | null;
};

/** the answer to a sealed status request: one entry per queried order and nullifier. */
export type StatusAnswer = { orders: OrderStatus[]; withdrawals: WithdrawalStatus[] };

export type OutputRecord = {
  leaf: string;
  enc: string;
  enc_remaining: string;
  enc_reserved: string;
  enc_reserved_offset: string;
};

export type TransitionOutputs = {
  seq: number;
  block_number: number;
  transaction_hash: string;
  new_book_root: string;
  note_root: string;
  output_root: string;
  note_batch_index: number;
  outputs: OutputRecord[];
};

export type NoteBatchRootList = {
  start: number;
  end: number;
  total: number;
  roots: string[];
};

export type TransitionOutputsList = {
  start: number;
  end: number;
  latest_seq: number;
  transitions: TransitionOutputs[];
};

export type IndexerStatus = {
  service: string;
  deposits_bucket: string;
  latest_seq: number;
  last_successful_sync_unix_ms: number;
  sync_lag_ms: number;
};

export type DepositConfirmationList = {
  recent_funding_commitments: string[];
  last_successful_sync_unix_ms: number;
  sync_lag_ms: number;
};

export type ExchangeClientOptions = {
  /** the operator: execution keys and sealed requests, status lookups included. */
  operatorUrl: string;
  /** the public chain index: deposits and transition outputs. */
  indexerUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };

/** the aligned windows covering seqs `from..=to`. */
export function transitionWindows(from: number, to: number): Array<[number, number]> {
  const windows: Array<[number, number]> = [];
  for (let start = from - (from % TRANSITION_WINDOW); start <= to; start += TRANSITION_WINDOW) {
    windows.push([start, start + TRANSITION_WINDOW - 1]);
  }
  return windows;
}

export class ZylithExchangeClient {
  readonly operatorUrl: string;
  readonly indexerUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs?: number;

  constructor(options: ExchangeClientOptions) {
    this.operatorUrl = normalizeSdkServiceUrl(options.operatorUrl, "operatorUrl");
    this.indexerUrl = normalizeSdkServiceUrl(options.indexerUrl, "indexerUrl");
    this.fetcher = options.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs;
  }

  async executionKeys(options?: RequestOptions) {
    return requireExecutionKeyRegistry(
      await this.get<unknown>(this.operatorUrl, "/api/public/execution-keys", options),
    );
  }

  exchangeStatus(options?: RequestOptions) {
    return this.get<ExchangeStatus>(this.operatorUrl, "/api/public/exchange", options);
  }

  /** one complete attested price view, independent of the market the user is viewing. */
  async referencePrices(options?: RequestOptions) {
    const response = await this.get<{ prices: ReferencePrice[] }>(this.operatorUrl, "/api/public/reference-prices", options);
    if (!Array.isArray(response.prices) || new Set(response.prices.map((price) => price.pair)).size !== response.prices.length) {
      throw new Error("Operator returned an invalid reference-price batch");
    }
    return response.prices;
  }

  /** the pair's current attested midpoint, read from the complete price view. */
  async referencePrice(pair: string, options?: RequestOptions) {
    const price = (await this.referencePrices(options)).find((candidate) => candidate.pair === pair);
    if (!price) throw new Error(`Operator returned no reference price for ${pair}`);
    return price;
  }

  /** hands a sealed order, cancellation or withdrawal to the operator. */
  submit(sealed: SealedRequest, responseKey: string, options?: RequestOptions) {
    return this.sealedCall<{ order_id?: string; nullifier?: string }>(sealed, responseKey, options);
  }

  /** the state of the orders and withdrawals a sealed status request names. */
  status(sealed: SealedRequest, responseKey: string, options?: RequestOptions) {
    return this.sealedCall<StatusAnswer>(sealed, responseKey, options);
  }

  /**
   * every sealed request goes to one endpoint and is answered with http 200 and a padded body;
   * only a key derived from its per-request response root opens it, and a refusal arrives inside
   * as `ok: false`.
   */
  private async sealedCall<T>(sealed: SealedRequest, responseKey: string, options?: RequestOptions): Promise<T> {
    requireSealedRequest(sealed);
    const response = await this.request<SealedResponse>(this.operatorUrl, PRIVATE_PATH, options, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sealed),
    });
    const answer = (await openSealedResponse(responseKey, sealed.digest, response)) as { ok?: boolean; error?: unknown } & T;
    if (answer.ok !== true) throw new ExchangeRejectedError(sanitizeSdkErrorMessage(answer.error, "The operator rejected the request"));
    return answer;
  }

  indexerStatus(options?: RequestOptions) {
    return this.get<IndexerStatus>(this.indexerUrl, "/health", options);
  }

  recentDeposits(options?: RequestOptions) {
    return this.get<DepositConfirmationList>(this.indexerUrl, "/api/deposits/recent", options);
  }

  noteBatches(start: number, end: number, options?: RequestOptions) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= MAX_TRANSITION_RANGE) {
      throw new Error("note batch range is invalid");
    }
    return this.get<NoteBatchRootList>(this.indexerUrl, `/api/note-batches/range/${start}/${end}`, options);
  }

  async allNoteBatchRoots(options?: RequestOptions) {
    const roots: string[] = [];
    for (let start = 0; ; start += MAX_TRANSITION_RANGE) {
      const list = await this.noteBatches(start, start + MAX_TRANSITION_RANGE - 1, options);
      if (list.start !== start || list.roots.length > MAX_TRANSITION_RANGE || list.total < roots.length + list.roots.length) {
        throw new Error("Indexer returned an invalid note batch range");
      }
      roots.push(...list.roots);
      if (roots.length >= list.total) return roots;
      if (list.roots.length !== MAX_TRANSITION_RANGE) throw new Error("Indexer is missing note batch roots");
    }
  }

  async transitions(start: number, end: number, options?: RequestOptions) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= MAX_TRANSITION_RANGE) {
      throw new Error("transition range is invalid");
    }
    const list = await this.get<TransitionOutputsList>(this.indexerUrl, `/api/transitions/range/${start}/${end}`, options);
    if (list.transitions.some((transition) => transition.seq < start || transition.seq > end)) {
      throw new Error("Indexer returned transitions outside the requested range");
    }
    return list;
  }

  /** every settled transition after the given seq, fetched in aligned windows, in seq order. */
  async transitionsAfter(afterSeq: number, options?: RequestOptions): Promise<{ latestSeq: number; transitions: TransitionOutputs[] }> {
    const collected: TransitionOutputs[] = [];
    let latestSeq = afterSeq;
    for (let next = afterSeq + 1; ; ) {
      const [start, end] = transitionWindows(next, next)[0];
      const list = await this.transitions(start, end, options);
      latestSeq = Math.max(latestSeq, list.latest_seq);
      collected.push(...list.transitions.filter((transition) => transition.seq >= next));
      if (end >= latestSeq) break;
      next = end + 1;
    }
    collected.sort((left, right) => left.seq - right.seq);
    collected.forEach((transition, index) => {
      if (transition.seq !== afterSeq + index + 1) throw new Error("Indexer is missing a transition");
    });
    return { latestSeq, transitions: collected };
  }

  private get<T>(base: string, path: string, options?: RequestOptions) {
    return this.request<T>(base, path, options, { headers: { accept: "application/json" } });
  }

  private async request<T>(base: string, path: string, options: RequestOptions = {}, init: RequestInit): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const response = await fetchWithSdkTimeout(this.fetcher, `${base}${path}`, { ...init, signal: options.signal }, timeoutMs);
    if (!response.ok) {
      const body = await readSdkResponseText(response, { maxBytes: DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES, signal: options.signal }).catch(() => "");
      throw new ExchangeHttpError(path, response.status, sanitizeSdkErrorMessage(body, `Request to ${path} failed with HTTP ${response.status}`));
    }
    return (await readSdkJsonResponse(response, { signal: options.signal, timeoutMs, label: path })) as T;
  }
}

const PRIVATE_PATH = "/api/private/requests";

function exactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && Object.keys(value).every((field) => fields.includes(field));
}

function requireExecutionKeyRegistry(value: unknown): ExecutionKeyRegistry {
  if (!exactObject(value, ["keys"]) || !Array.isArray(value.keys) || value.keys.length !== 1) {
    throw new Error("Operator returned a malformed execution-key registry");
  }
  const key = value.keys[0];
  if (
    !exactObject(key, ["key_id", "algorithm", "public_key"])
    || typeof key.key_id !== "string"
    || !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(key.key_id)
    || key.algorithm !== HPKE_PROFILE
    || typeof key.public_key !== "string"
    || !/^[0-9a-f]{64}$/.test(key.public_key)
    || !usableX25519PublicKey(key.public_key)
  ) throw new Error("Operator returned a malformed execution-key registry");
  return value as ExecutionKeyRegistry;
}

function requireSealedRequest(value: unknown): asserts value is SealedRequest {
  if (
    !exactObject(value, ["version", "key_id", "digest", "encapsulated_key", "ciphertext"])
    || value.version !== 3
    || typeof value.key_id !== "string"
    || !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(value.key_id)
    || typeof value.digest !== "string"
    || !/^[0-9a-f]{64}$/.test(value.digest)
    || typeof value.encapsulated_key !== "string"
    || !/^[0-9a-f]{64}$/.test(value.encapsulated_key)
    || !usableX25519PublicKey(value.encapsulated_key)
    || typeof value.ciphertext !== "string"
    || !/^[0-9a-f]{8224}$/.test(value.ciphertext)
  ) throw new Error("Malformed sealed request");
}

function usableX25519PublicKey(publicKey: string) {
  if (publicKey === "00".repeat(32) || X25519_LOW_ORDER_KEYS.has(publicKey)) return false;
  const bytes = publicKey.match(/../g);
  const prime = X25519_FIELD_PRIME.match(/../g);
  if (!bytes || !prime || (Number.parseInt(bytes[31], 16) & 0x80) !== 0) return false;
  for (let index = 31; index >= 0; index -= 1) {
    const byte = Number.parseInt(bytes[index], 16);
    const primeByte = Number.parseInt(prime[index], 16);
    if (byte !== primeByte) return byte < primeByte;
  }
  return false;
}

function u32be(value: number): Uint8Array<ArrayBuffer> {
  const encoded = new Uint8Array(4);
  new DataView(encoded.buffer).setUint32(0, value, false);
  return encoded;
}

/** count-and-length-prefixes binary fields exactly as the Rust protocol implementation does. */
function frame(parts: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const size = 4 + parts.reduce((total, part) => total + 4 + part.length, 0);
  const encoded = new Uint8Array(size);
  const view = new DataView(encoded.buffer);
  view.setUint32(0, parts.length, false);
  let offset = 4;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    encoded.set(part, offset);
    offset += part.length;
  }
  return encoded;
}

function requireSealedResponse(value: unknown): asserts value is SealedResponse {
  if (
    !exactObject(value, ["version", "salt", "nonce", "ciphertext"])
    || value.version !== RESPONSE_ENVELOPE_VERSION
    || typeof value.salt !== "string"
    || !/^[0-9a-f]{64}$/.test(value.salt)
    || typeof value.nonce !== "string"
    || !/^[0-9a-f]{24}$/.test(value.nonce)
    || typeof value.ciphertext !== "string"
    || value.ciphertext.length !== RESPONSE_CIPHERTEXT_BYTES * 2
    || !RESPONSE_CIPHERTEXT_PATTERN.test(value.ciphertext)
  ) throw new Error("Malformed sealed response");
}

/** opens an answer under a fresh HKDF-derived AES-256-GCM subkey, bound to its request. */
export async function openSealedResponse(responseKey: string, digest: string, sealed: SealedResponse): Promise<unknown> {
  requireSealedResponse(sealed);
  if (!/^[0-9a-f]{64}$/.test(responseKey) || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Malformed sealed response");
  }
  const root = await crypto.subtle.importKey("raw", hexBytes(responseKey, 32), "HKDF", false, ["deriveKey"]);
  const salt = hexBytes(sealed.salt, 32);
  const digestBytes = hexBytes(digest, 32);
  const version = u32be(RESPONSE_ENVELOPE_VERSION);
  const size = u32be(RESPONSE_PLAINTEXT_BYTES);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: frame([RESPONSE_KEY_INFO_DOMAIN, version, size, digestBytes]),
    },
    root,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: hexBytes(sealed.nonce, 12),
        additionalData: frame([RESPONSE_AAD_DOMAIN, version, size, digestBytes, salt]),
      },
      key,
      hexBytes(sealed.ciphertext),
    );
  } catch {
    throw new Error("The operator's answer does not open");
  }
  if (plaintext.byteLength !== RESPONSE_PLAINTEXT_BYTES) {
    throw new Error("The operator's answer does not open");
  }
  try {
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("The operator's answer is malformed");
  }
}

function hexBytes(hex: string, length?: number): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex) || (length !== undefined && hex.length !== length * 2)) throw new Error("Malformed sealed response");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** the operator opened the request and refused it; retrying it unchanged will not help. */
export class ExchangeRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExchangeRejectedError";
  }
}

export class ExchangeHttpError extends Error {
  readonly path: string;
  readonly status: number;

  constructor(path: string, status: number, message: string) {
    super(message);
    this.name = "ExchangeHttpError";
    this.path = path;
    this.status = status;
  }
}
