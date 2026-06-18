export function serviceBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function paymasterExecuteUrl(url: string): string {
  const trimmed = serviceBaseUrl(url);
  return trimmed.endsWith("/execute-outside")
    ? trimmed
    : `${trimmed}/execute-outside`;
}

export function paymasterPrivacySignerEnsureUrl(url: string): string {
  const trimmed = serviceBaseUrl(url);
  return trimmed.endsWith("/execute-outside")
    ? `${trimmed.slice(0, -"/execute-outside".length)}/privacy-signer/ensure`
    : `${trimmed}/privacy-signer/ensure`;
}

export function paymasterPrivacySignerRelayUrl(url: string): string {
  const trimmed = serviceBaseUrl(url);
  return trimmed.endsWith("/execute-outside")
    ? `${trimmed.slice(0, -"/execute-outside".length)}/privacy-signer/relay`
    : `${trimmed}/privacy-signer/relay`;
}

export function transactionHashFromResult(result: unknown): string | null {
  if (typeof result === "string" && result.trim()) return result;
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  for (const key of ["transaction_hash", "transactionHash", "hash"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
