export function normalizeUrl(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

export function browserSafeServiceUrl(url: string, sameOriginPath: string) {
  const normalizedUrl = normalizeUrl(url);
  if (typeof window !== "undefined") {
    const localProxyPath = localProxyServicePath(normalizedUrl, sameOriginPath);
    if (localProxyPath) return localProxyPath;
    const apiUrl = serviceApiUrlForWindow(sameOriginPath);
    if (apiUrl && isSameOriginServiceUrl(normalizedUrl, sameOriginPath)) {
      return apiUrl;
    }
  }
  if (
    normalizedUrl &&
    /^http:\/\//i.test(normalizedUrl) &&
    typeof window !== "undefined" &&
    window.location?.protocol === "https:"
  ) {
    throw new Error("Configured service URL must use HTTPS on the production app");
  }
  return normalizedUrl;
}

export function defaultServiceUrlForHost(host: string, servicePath: string) {
  const normalizedHost = host.trim().toLowerCase();
  const normalizedPath = servicePath.replace(/^\/+|\/+$/g, "");
  if (!normalizedHost || !normalizedPath) return "";
  if (
    normalizedHost === "app.zylith.fi" ||
    normalizedHost.endsWith(".zylith.fi")
  ) {
    return `https://api.zylith.fi/${normalizedPath}`;
  }
  return "";
}

export function localServiceUrl(port: number, servicePath?: string) {
  if (typeof window === "undefined") return "";
  const host = window.location.hostname;
  if (isLocalHost(host)) {
    if (servicePath) return `/${servicePath.replace(/^\/+|\/+$/g, "")}`;
    return `${window.location.protocol || "http:"}//${host}:${port}`;
  }
  if (servicePath) return defaultServiceUrlForHost(host, servicePath);
  return "";
}

export function paymasterEndpointBase(endpointUrl: string) {
  return endpointUrl.replace(/\/execute-outside$/, "");
}

function isLocalHost(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function serviceApiUrlForWindow(servicePath: string) {
  const host = window.location?.hostname || "";
  if (isLocalHost(host)) return "";
  return defaultServiceUrlForHost(host, servicePath);
}

function localProxyServicePath(url: string, sameOriginPath: string) {
  const host = window.location?.hostname || "";
  if (!isLocalHost(host) || !url) return "";
  const normalizedPath = `/${sameOriginPath.replace(/^\/+|\/+$/g, "")}`;
  if (matchesServicePath(url, normalizedPath)) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "api.zylith.fi" &&
      matchesServicePath(parsed.pathname, normalizedPath)
    ) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return "";
  }
  return "";
}

function isSameOriginServiceUrl(url: string, sameOriginPath: string) {
  const normalizedPath = `/${sameOriginPath.replace(/^\/+|\/+$/g, "")}`;
  if (!url) return false;
  if (url === normalizedPath || url.startsWith(`${normalizedPath}/`)) {
    return true;
  }
  try {
    const parsed = new URL(url, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      (parsed.pathname === normalizedPath ||
        parsed.pathname.startsWith(`${normalizedPath}/`))
    );
  } catch {
    return false;
  }
}

function matchesServicePath(pathname: string, normalizedPath: string) {
  return (
    pathname === normalizedPath ||
    pathname.startsWith(`${normalizedPath}/`) ||
    (normalizedPath === "/starknet-privacy-prover" &&
      pathname.startsWith("/starknet-privacy-prover-"))
  );
}
