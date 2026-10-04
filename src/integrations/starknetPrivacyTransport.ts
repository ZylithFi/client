import { normalizeStrictFelt } from "../domain/felt";

export function serviceBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function paymasterExecuteUrl(url: string): string {
  const trimmed = serviceBaseUrl(url);
  return trimmed.endsWith("/execute-outside")
    ? trimmed
    : `${trimmed}/execute-outside`;
}

export function paymasterPrivacySignerRelayUrl(url: string): string {
  const trimmed = serviceBaseUrl(url);
  return trimmed.endsWith("/execute-outside")
    ? `${trimmed.slice(0, -"/execute-outside".length)}/privacy-signer/relay`
    : `${trimmed}/privacy-signer/relay`;
}

export function transactionHashFromResult(result: unknown): string | null {
  if (typeof result === "string") return nonzeroTransactionHash(result);
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  for (const key of ["transaction_hash", "transactionHash", "hash"]) {
    const value = record[key];
    if (typeof value === "string") return nonzeroTransactionHash(value);
  }
  return null;
}

function nonzeroTransactionHash(value: string) {
  const normalized = normalizeStrictFelt(value);
  return normalized && normalized !== "0x0" ? normalized : null;
}
