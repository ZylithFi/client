import {
  DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
  readSdkJsonResponse,
  readSdkResponseText,
} from "@zylith/sdk";
import { fetchWithTimeout } from "./runtimeHttp";

const RELAY_REQUEST_TIMEOUT_MS = 30_000;

type RelayHttpOptions = {
  baseUrl: string;
  path: string;
  label: "Liquidity automation relay" | "Renewal relay" | "Self-hosted relay";
  headers?: Record<string, string>;
};

export async function relayGetJson<T>(
  options: RelayHttpOptions
): Promise<T | null> {
  const response = await relayFetch(options, {
    headers: {
      accept: "application/json",
      ...options.headers,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await relayErrorMessage(response, options.label));
  return (await readSdkJsonResponse(response, {
    timeoutMs: RELAY_REQUEST_TIMEOUT_MS,
    label: `${options.label} response`,
  })) as T;
}

export async function relayDeleteJson(
  options: RelayHttpOptions
): Promise<boolean> {
  const response = await relayFetch(options, {
    method: "DELETE",
    headers: {
      accept: "application/json",
      ...options.headers,
    },
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(await relayErrorMessage(response, options.label));
  return true;
}

export async function relayPostJson<T>(
  options: RelayHttpOptions & { body: unknown }
): Promise<T> {
  const response = await relayFetch(options, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(options.body),
  });
  if (!response.ok) throw new Error(await relayErrorMessage(response, options.label));
  return (await readSdkJsonResponse(response, {
    timeoutMs: RELAY_REQUEST_TIMEOUT_MS,
    label: `${options.label} response`,
  })) as T;
}

export function relayPackageAccessHeaders(accessToken?: string): Record<string, string> {
  const normalized = accessToken?.trim();
  if (!normalized) {
    throw new Error("Renewal relay package access token is missing");
  }
  return {
    "x-zylith-relay-package-access-token": normalized,
  };
}

async function relayFetch(
  options: RelayHttpOptions,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchWithTimeout(
      `${options.baseUrl}${options.path}`,
      init,
      RELAY_REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Runtime request timed out"
    ) {
      throw new Error(`${options.label} request timed out. Please retry later.`);
    }
    if (isAbortOrNetworkError(error)) {
      throw new Error(
        `${options.label} request failed. Check your connection and retry.`
      );
    }
    throw error;
  }
}

async function relayErrorMessage(response: Response, label: string) {
  const detail = await relayErrorDetail(response);
  return `${label} request failed with HTTP ${response.status}${
    detail ? `: ${detail}` : ""
  }`;
}

function isAbortOrNetworkError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    /signal is aborted|aborted without reason|aborterror|timeouterror|operation was aborted|failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(
      message
    )
  );
}

async function relayErrorDetail(response: Response) {
  const text = await readSdkResponseText(response, {
    maxBytes: DEFAULT_SDK_ERROR_RESPONSE_MAX_BYTES,
    timeoutMs: RELAY_REQUEST_TIMEOUT_MS,
    label: "Relay error response",
  }).catch(() => "");
  if (!text.trim()) return "";
  try {
    const parsed = JSON.parse(text) as {
      error?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    const error = parsed.error ?? parsed.detail ?? parsed.message;
    return sanitizeRelayErrorDetail(typeof error === "string" ? error : text);
  } catch {
    return sanitizeRelayErrorDetail(text);
  }
}

function sanitizeRelayErrorDetail(value: string) {
  return value
    .replace(/"calldata"\s*:\s*\[[^\]]*\]/g, '"calldata":[...]')
    .replace(/"signature"\s*:\s*\[[^\]]*\]/g, '"signature":[...]')
    .replace(/0x[0-9a-fA-F]{33,}/g, "<felt>")
    .replace(/\b[0-9]{32,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
