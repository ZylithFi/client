import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson, postJson, starknetRpc } from "./runtimeHttp";

describe("runtimeHttp", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts JSON-RPC Starknet calls", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: "0x1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(starknetRpc("https://rpc.test", "starknet_blockNumber", [])).resolves.toEqual({
      result: "0x1",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://rpc.test", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "starknet_blockNumber",
        params: [],
      }),
    }));
  });

  it("returns null for unconfigured or failed GET JSON calls", async () => {
    await expect(fetchJson("", "/api/test")).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => ({ ignored: true }),
    })));

    await expect(fetchJson("https://api.test/", "/api/test")).resolves.toBeNull();
  });

  it("posts JSON bodies and surfaces response error text", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      text: async () => "bad request",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(postJson("https://api.test/", "/api/test", { value: 1 })).rejects.toThrow(
      "bad request",
    );
    expect(fetchMock).toHaveBeenCalledWith("https://api.test/api/test", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ value: 1 }),
    }));
  });
});
