import {
  DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
  readSdkJsonResponse,
  readSdkResponseText,
} from "@zylith/sdk";

const DEFAULT_STARKNET_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_FETCH_JSON_TIMEOUT_MS = 10_000;
const DEFAULT_POST_JSON_TIMEOUT_MS = 15_000;

export class RuntimeHttpStatusError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    super(body || `Request to ${path} failed with HTTP ${status}`);
    this.name = "RuntimeHttpStatusError";
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

export async function starknetRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARKNET_RPC_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let response: Response;
  try {
    response = await fetchWithTimeout(rpcUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: options.signal,
    }, timeoutMs);
  } catch (error) {
    if (isRuntimeTimeoutError(error)) {
      throw new Error(`Starknet RPC request timed out after ${timeoutMs}ms`);
    }
    if (isAbortError(error) || isNetworkError(error)) {
      throw new Error("Starknet network request failed. Please retry later.");
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(
      `Starknet network request failed with HTTP ${response.status}`
    );
  }
  return (await readSdkJsonResponse(response, {
    signal: options.signal,
    timeoutMs: remainingTimeout(deadline),
    label: "Starknet RPC response",
  })) as T;
}

export async function fetchJson<T>(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T | null> {
  if (!baseUrl) return null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_JSON_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let response: Response;
  try {
    response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      headers: { accept: "application/json", ...headers },
      signal: options.signal,
    }, timeoutMs);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return (await readSdkJsonResponse(response, {
      signal: options.signal,
      timeoutMs: remainingTimeout(deadline),
      label: `Response from ${path}`,
    })) as T;
  } catch {
    return null;
  }
}

export async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  if (!baseUrl) throw new Error("Target service is not configured");
  const timeoutMs = options.timeoutMs ?? DEFAULT_POST_JSON_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let response: Response;
  try {
    response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    }, timeoutMs);
  } catch (error) {
    if (isRuntimeTimeoutError(error)) {
      throw new Error(`Request to ${path} timed out after ${timeoutMs}ms`);
    }
    if (isAbortError(error) || isNetworkError(error)) {
      throw new Error("Network request failed. Check your connection and retry.");
    }
    throw error;
  }
  if (!response.ok) {
    const detail = await readSdkResponseText(response, {
      maxBytes: DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
      signal: options.signal,
      timeoutMs: remainingTimeout(deadline),
      label: `Error response from ${path}`,
    }).catch(() => "");
    throw new RuntimeHttpStatusError(path, response.status, sanitizeHttpErrorBody(detail));
  }
  return (await readSdkJsonResponse(response, {
    signal: options.signal,
    timeoutMs: remainingTimeout(deadline),
    label: `Response from ${path}`,
  })) as T;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs?: number
): Promise<Response> {
  if (init.signal?.aborted) {
    throw new Error("Runtime request aborted");
  }
  if (!timeoutMs || timeoutMs <= 0) return fetch(input, init);
  const controller = new AbortController();
  const sourceSignal = init.signal;
  let didTimeout = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const abortGuard = new Promise<Response>((_, reject) => {
    rejectAbort = reject;
  });
  const forwardAbort = () => {
    controller.abort(sourceSignal?.reason ?? new DOMException("Request aborted", "AbortError"));
    rejectAbort?.(new Error("Runtime request aborted"));
  };
  if (sourceSignal?.aborted) {
    forwardAbort();
  } else {
    sourceSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeoutGuard = new Promise<Response>((_, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
      reject(new Error("Runtime request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      timeoutGuard,
      abortGuard,
    ]);
  } catch (error) {
    if (didTimeout && isAbortError(error)) {
      throw new Error("Runtime request timed out");
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    sourceSignal?.removeEventListener("abort", forwardAbort);
  }
}

function isAbortError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) || (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) || /runtime request aborted|request aborted|signal is aborted|aborted without reason|aborterror|timeouterror|timed out|operation was aborted/i.test(message);
}

function isRuntimeTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === "Runtime request timed out";
}

function isNetworkError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
    message
  );
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function sanitizeHttpErrorBody(value: string) {
  return value
    .replace(/"calldata"\s*:\s*\[[^\]]*\]/g, '"calldata":[...]')
    .replace(/"signature"\s*:\s*\[[^\]]*\]/g, '"signature":[...]')
    .replace(/0x[0-9a-fA-F]{33,}/g, "<felt>")
    .replace(/\b[0-9]{32,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}
