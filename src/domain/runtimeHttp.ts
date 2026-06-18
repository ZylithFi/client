export async function starknetRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown,
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(
      `Starknet network request failed with HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

export async function fetchJson<T>(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<T | null> {
  if (!baseUrl) return null;
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    headers: { accept: "application/json", ...headers },
  });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

export async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  if (!baseUrl) throw new Error("Target service is not configured");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail || `Request to ${path} failed with HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}
