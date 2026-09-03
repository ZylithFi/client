import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeHttpStatusError, fetchJson, postJson, starknetRpc } from "./runtimeHttp";

describe("runtimeHttp", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts JSON-RPC Starknet calls", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ result: "0x1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
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

  it("returns null for optional GET JSON network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Signal is aborted without reason");
      })
    );

    await expect(fetchJson("https://api.test/", "/api/test")).resolves.toBeNull();
  });

  it("normalizes Starknet RPC network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("failed to fetch");
      })
    );

    await expect(
      starknetRpc("https://rpc.test", "starknet_blockNumber", [])
    ).rejects.toThrow("Starknet network request failed. Please retry later.");
  });

  it("times out Starknet RPC calls when a timeout is configured", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      starknetRpc("https://rpc.test", "starknet_blockNumber", [], { timeoutMs: 1 })
    ).rejects.toThrow("Starknet RPC request timed out after 1ms");
  });

  it("times out Starknet RPC calls when fetch ignores abort", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    await expect(
      starknetRpc("https://rpc.test", "starknet_blockNumber", [], { timeoutMs: 1 })
    ).rejects.toThrow("Starknet RPC request timed out after 1ms");
  });

  it("posts JSON bodies and surfaces response error text", async () => {
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(postJson("https://api.test/", "/api/test", { value: 1 })).rejects.toThrow(
      "bad request",
    );
    await expect(
      postJson("https://api.test/", "/api/test", { value: 1 })
    ).rejects.toMatchObject({
      name: "RuntimeHttpStatusError",
      status: 400,
      path: "/api/test",
      body: "bad request",
    } satisfies Partial<RuntimeHttpStatusError>);
    expect(fetchMock).toHaveBeenCalledWith("https://api.test/api/test", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ value: 1 }),
    }));
  });

  it("redacts large POST error bodies before storing status errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        'failed for 0x1234567890abcdef1234567890abcdef1234567890abcdef with "calldata":["0x1234567890abcdef1234567890abcdef1234567890abcdef"] and amount 1234567890123456789012345678901234567890',
        { status: 500 },
      ))
    );

    await expect(
      postJson("https://api.test/", "/api/private", { value: 1 })
    ).rejects.toMatchObject({
      name: "RuntimeHttpStatusError",
      body: 'failed for <felt> with "calldata":[...] and amount <number>',
    } satisfies Partial<RuntimeHttpStatusError>);
  });

  it("times out POST JSON calls when a timeout is configured", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postJson("https://api.test/", "/api/test", { value: 1 }, {}, { timeoutMs: 1 })
    ).rejects.toThrow("Request to /api/test timed out after 1ms");
  });

  it("times out POST JSON calls when fetch ignores abort", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    await expect(
      postJson("https://api.test/", "/api/test", { value: 1 }, {}, { timeoutMs: 1 })
    ).rejects.toThrow("Request to /api/test timed out after 1ms");
  });

  it("rejects oversized POST response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ value: "x".repeat(1_100_000) }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    await expect(
      postJson("https://api.test/", "/api/test", { value: 1 })
    ).rejects.toThrow(/response limit/);
  });

  it("times out POST response bodies that never complete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    await expect(
      postJson(
        "https://api.test/",
        "/api/test",
        { value: 1 },
        {},
        { timeoutMs: 10 },
      )
    ).rejects.toThrow(/body timed out/);
  });

  it("normalizes browser abort messages without an AbortError name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Signal is aborted without reason");
      })
    );

    await expect(
      postJson("https://api.test/", "/api/test", { value: 1 }, {}, { timeoutMs: 1 })
    ).rejects.toThrow("Network request failed. Check your connection and retry.");
  });

  it("normalizes SDK-style abort messages without an AbortError name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Zylith SDK request aborted");
      })
    );

    await expect(
      postJson("https://api.test/", "/api/test", { value: 1 }, {}, { timeoutMs: 1 })
    ).rejects.toThrow("Network request failed. Check your connection and retry.");
  });

  it("normalizes caller-aborted POST requests", async () => {
    const fetchMock = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      postJson(
        "https://api.test/",
        "/api/test",
        { value: 1 },
        {},
        { timeoutMs: 10_000, signal: controller.signal },
      )
    ).rejects.toThrow("Network request failed. Check your connection and retry.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
