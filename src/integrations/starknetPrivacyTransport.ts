export function serviceBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function paymasterExecuteUrl(url: string): string {
  const trimmed = serviceBaseUrl(url);
  return trimmed.endsWith("/execute-outside")
    ? trimmed
    : `${trimmed}/execute-outside`;
}
