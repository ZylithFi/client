import { describe, expect, it } from "vitest";
import {
  defaultServiceUrlForHost,
  localServiceUrl,
  normalizeUrl,
  paymasterEndpointBase,
  paymasterEndpointPath,
} from "./serviceUrls";

describe("serviceUrls", () => {
  it("normalizes trailing slashes and ignores non-string values", () => {
    expect(normalizeUrl("https://api.test///")).toBe("https://api.test");
    expect(normalizeUrl(undefined)).toBe("");
  });

  it("maps zylith hosts to the production API origin", () => {
    expect(defaultServiceUrlForHost("app.zylith.fi", "indexer")).toBe(
      "https://api.zylith.fi/indexer",
    );
    expect(defaultServiceUrlForHost("preview.zylith.fi", "/prover/")).toBe(
      "https://api.zylith.fi/prover",
    );
    expect(defaultServiceUrlForHost("example.com", "indexer")).toBe("");
  });

  it("uses the local browser host for local service URLs", () => {
    expect(localServiceUrl(3000)).toMatch(/^http:\/\/localhost:3000$/);
  });

  it("splits paymaster execute endpoints consistently", () => {
    expect(paymasterEndpointBase("https://paymaster.test/execute-outside")).toBe(
      "https://paymaster.test",
    );
    expect(paymasterEndpointPath("https://paymaster.test")).toBe("/execute-outside");
  });
});
