import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserSafeServiceUrl,
  defaultServiceUrlForHost,
  localServiceUrl,
  normalizeUrl,
  paymasterEndpointBase,
} from "./serviceUrls";

describe("serviceUrls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes trailing slashes and ignores non-string values", () => {
    expect(normalizeUrl(" https://api.test/// ")).toBe("https://api.test");
    expect(normalizeUrl(undefined)).toBe("");
  });

  it("uses the API host for production service URLs", () => {
    vi.stubGlobal("window", {
      location: {
        hostname: "app.zylith.fi",
        origin: "https://app.zylith.fi",
        protocol: "https:",
      },
    });

    expect(
      browserSafeServiceUrl(
        " https://app.zylith.fi/starknet-privacy-prover/ ",
        "/starknet-privacy-prover",
      ),
    ).toBe("https://api.zylith.fi/starknet-privacy-prover");
    expect(
      browserSafeServiceUrl(
        "/starknet-privacy-discovery",
        "/starknet-privacy-discovery",
      ),
    ).toBe("https://api.zylith.fi/starknet-privacy-discovery");
  });

  it("keeps localhost service URLs local", () => {
    vi.stubGlobal("window", {
      location: {
        hostname: "localhost",
        origin: "http://localhost:5173",
        protocol: "http:",
      },
    });

    expect(
      browserSafeServiceUrl(
        "/starknet-privacy-prover",
        "/starknet-privacy-prover",
      ),
    ).toBe("/starknet-privacy-prover");
    expect(localServiceUrl(3000)).toBe("http://localhost:3000");
    expect(localServiceUrl(3300, "indexer")).toBe("/indexer");
    expect(localServiceUrl(3000, "/coordinator/")).toBe("/coordinator");
  });

  it("routes api.zylith.fi services through local dev proxies", () => {
    vi.stubGlobal("window", {
      location: {
        hostname: "127.0.0.1",
        origin: "http://127.0.0.1:5173",
        protocol: "http:",
      },
    });

    expect(
      browserSafeServiceUrl(
        "https://api.zylith.fi/coordinator",
        "/coordinator",
      ),
    ).toBe("/coordinator");
    expect(
      browserSafeServiceUrl(
        "https://api.zylith.fi/starknet-privacy-prover-sepolia",
        "/starknet-privacy-prover",
      ),
    ).toBe("/starknet-privacy-prover-sepolia");
  });

  it("rejects insecure service URLs on HTTPS app hosts", () => {
    vi.stubGlobal("window", {
      location: {
        hostname: "app.zylith.fi",
        origin: "https://app.zylith.fi",
        protocol: "https:",
      },
    });

    expect(() =>
      browserSafeServiceUrl(
        "http://raw-prover.test",
        "/starknet-privacy-prover",
      ),
    ).toThrow("Configured service URL must use HTTPS");
  });

  it("maps zylith hosts to the API host", () => {
    expect(
      defaultServiceUrlForHost("app.zylith.fi", "/starknet-privacy-prover"),
    ).toBe("https://api.zylith.fi/starknet-privacy-prover");
    expect(defaultServiceUrlForHost("preview.zylith.fi", "/prover/")).toBe(
      "https://api.zylith.fi/prover",
    );
    expect(defaultServiceUrlForHost("example.com", "indexer")).toBe("");
  });

  it("routes production app hosts through the API service host", () => {
    vi.stubGlobal("window", {
      location: {
        hostname: "app.zylith.fi",
        origin: "https://app.zylith.fi",
        protocol: "https:",
      },
    });

    expect(localServiceUrl(3000, "coordinator")).toBe(
      "https://api.zylith.fi/coordinator",
    );
    expect(localServiceUrl(3300, "indexer")).toBe(
      "https://api.zylith.fi/indexer",
    );
    expect(localServiceUrl(3200, "prover")).toBe(
      "https://api.zylith.fi/prover",
    );
    expect(localServiceUrl(3400, "relay")).toBe(
      "https://api.zylith.fi/relay",
    );
  });

  it("normalizes paymaster execute endpoint bases", () => {
    expect(paymasterEndpointBase("https://paymaster.test/execute-outside")).toBe(
      "https://paymaster.test",
    );
  });
});
