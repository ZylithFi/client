export function normalizeUrl(value: unknown) {
  return typeof value === "string" ? value.replace(/\/+$/, "") : "";
}

export function browserSafeServiceUrl(url: string, sameOriginPath: string) {
  if (
    url &&
    /^http:\/\//i.test(url) &&
    typeof window !== "undefined" &&
    window.location?.protocol === "https:"
  ) {
    return sameOriginPath;
  }
  return url;
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
    return `${window.location.protocol || "http:"}//${host}:${port}`;
  }
  if (servicePath) return defaultServiceUrlForHost(host, servicePath);
  return "";
}

export function paymasterEndpointBase(endpointUrl: string) {
  return endpointUrl.replace(/\/execute-outside$/, "");
}

export function paymasterEndpointPath(endpointUrl: string) {
  return endpointUrl.endsWith("/execute-outside")
    ? "/execute-outside"
    : "/execute-outside";
}

function isLocalHost(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}
