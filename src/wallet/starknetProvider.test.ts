import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildZylithWalletAuthTypedData,
  connectedProviderAddress,
  ensureWalletChain,
  preflightWalletAction,
  fetchTransactionReceiptStatus,
  walletErrorMessage,
  walletAuthDeploymentId,
  WalletNetworkSwitchUnsupportedError,
} from "./starknetProvider";
import * as runtimeHttp from "../domain/runtimeHttp";
import exampleDeployment from "../../public/deployment.example.json";

const deployment = {
  chain_id: "0x534e5f5345504f4c4941",
  network: "sepolia",
  rpc_url: "https://rpc.example",
};

describe("starknet provider safety", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns the exact canonical nonzero deployment felt signed by wallet authorization", async () => {
    const original = structuredClone(exampleDeployment);
    original.contracts.exchange = "0x123";
    original.contracts.privacy_deposit_bridge = "0x456";
    const id = await walletAuthDeploymentId(original as never, 2);
    const typed = await buildZylithWalletAuthTypedData({ walletAddress: "0xabc", chainId: original.chain_id, deploymentId: id, origin: "https://app.zylith.fi", messageVersion: 2 });
    expect(id).toBe(typed.message.deployment);
    expect(id).toMatch(/^0x[1-9a-f][0-9a-f]*$/);
    expect(BigInt(id)).toBeGreaterThan(0n);
    expect(BigInt(id)).toBeLessThan(0x800000000000011000000000000000000000000000000000000000000000001n);
    for (const change of ["chain", "exchange", "bridge", "funding"]) {
      const changed = structuredClone(original);
      if (change === "chain") changed.chain_id = "0x1";
      if (change === "exchange") changed.contracts.exchange = "0x789";
      if (change === "bridge") changed.contracts.privacy_deposit_bridge = "0x789";
      if (change === "funding") changed.funding.primary = "different";
      expect(await walletAuthDeploymentId(changed as never, 2)).not.toBe(id);
    }
    await expect(walletAuthDeploymentId(original as never, 1 as never)).rejects.toThrow(/version/i);
  });

  it("never accepts a chain switch unless the wallet reports the expected chain", async () => {
    const provider = {
      request: vi.fn(async ({ type }: { type?: string }) => {
        if (type === "wallet_switchStarknetChain") return true;
        return null;
      }),
    };
    await expect(ensureWalletChain(provider, deployment)).rejects.toThrow(
      /did not report its network/i,
    );
  });

  it("deduplicates concurrent network-switch prompts and reports that a switch occurred", async () => {
    let chainId = "0x1";
    let releaseSwitch!: () => void;
    const switchPending = new Promise<void>((resolve) => { releaseSwitch = resolve; });
    const provider = {
      request: vi.fn(async ({ type }: { type?: string }) => {
        if (type === "wallet_requestChainId") return chainId;
        if (type === "wallet_switchStarknetChain") {
          await switchPending;
          chainId = deployment.chain_id;
          return true;
        }
        return null;
      }),
    };

    const first = ensureWalletChain(provider, deployment);
    const second = ensureWalletChain(provider, deployment);
    await vi.waitFor(() => {
      expect(provider.request.mock.calls.filter(([request]) => request.type === "wallet_switchStarknetChain"))
        .toHaveLength(1);
    });
    releaseSwitch();

    await expect(first).resolves.toBe("switched");
    await expect(second).resolves.toBe("switched");
  });

  it("distinguishes an unsupported programmatic switch from a rejected switch", async () => {
    const unsupported = {
      request: vi.fn(async ({ type }: { type?: string }) => {
        if (type === "wallet_requestChainId") return "0x1";
        throw new Error("method not found");
      }),
    };
    await expect(ensureWalletChain(unsupported, deployment)).rejects.toBeInstanceOf(
      WalletNetworkSwitchUnsupportedError,
    );

    const rejected = {
      request: vi.fn(async ({ type }: { type?: string }) => {
        if (type === "wallet_requestChainId") return "0x1";
        throw new Error("user rejected");
      }),
    };
    await expect(ensureWalletChain(rejected, deployment)).rejects.toThrow(/user rejected/i);
  });

  it("rechecks wallet identity after a user-initiated network switch", async () => {
    const account = { address: "0xabc" };
    let chainId = "0x1";
    const provider = {
      account,
      request: vi.fn(async ({ type }: { type?: string }) => {
        if (type === "wallet_requestChainId") return chainId;
        if (type === "wallet_switchStarknetChain") {
          chainId = deployment.chain_id;
          account.address = "0xdef";
          return true;
        }
        return null;
      }),
    };

    await expect(preflightWalletAction(provider, deployment, "0xabc"))
      .rejects.toThrow(/wallet changed/i);
  });

  it("falls back to Xverse's wallet-owned network switch method", async () => {
    let chainId = "0x1";
    const provider = {
      account: { address: "0xabc" },
      request: vi.fn(async (request: { type?: string; method?: string; params?: unknown }) => {
        if (request.type === "wallet_requestChainId") return chainId;
        if (request.type === "wallet_switchStarknetChain") throw new Error("method not found");
        if (request.method === "wallet_switchStarknetChain") throw new Error("method not found");
        if (request.method === "wallet_changeNetwork") {
          expect(request.params).toEqual({ name: "Testnet" });
          chainId = deployment.chain_id;
          return null;
        }
        return null;
      }),
    };

    await expect(preflightWalletAction(provider, deployment, "0xabc"))
      .resolves.toBe("switched");
    expect(provider.request).toHaveBeenCalledWith({
      method: "wallet_changeNetwork",
      params: { name: "Testnet" },
    });
  });

  it("does not accept an Xverse error response as a successful switch", async () => {
    const provider = {
      request: vi.fn(async (request: { type?: string; method?: string }) => {
        if (request.type === "wallet_requestChainId") return "0x1";
        if (request.method === "wallet_changeNetwork") {
          return { status: "error", error: { message: "User rejected the request" } };
        }
        throw new Error("method not found");
      }),
    };

    await expect(ensureWalletChain(provider, deployment)).rejects.toThrow(/user rejected/i);
  });

  it("shows the real origin and an explicit anti-phishing action in wallet auth", async () => {
    const typedData = await buildZylithWalletAuthTypedData({
      walletAddress: "0x123",
      chainId: deployment.chain_id,
      deploymentId: "0x123",
      origin: "app.zylith.fi",
      messageVersion: 2,
    });

    expect(typedData.domain.version).toBe("2");
    expect(typedData.message.origin).toBe("app.zylith.fi");
    expect(typedData.message.action).toBe("Only sign on app.zylith.fi");
    await expect(
      buildZylithWalletAuthTypedData({
        walletAddress: "0x123",
        chainId: deployment.chain_id,
        deploymentId: "0x123",
        origin: "https://app.zylith.fi/is-not-a-shortstring",
        messageVersion: 2,
      }),
    ).rejects.toThrow(/readable short string/i);
  });

  it("does not treat a failed chain-switch request as accepted", async () => {
    const provider = {
      request: vi.fn(async ({ type }: { type?: string }) => {
        if (type === "wallet_switchStarknetChain") throw new Error("internal wallet failure");
        return null;
      }),
    };
    await expect(ensureWalletChain(provider, deployment)).rejects.toThrow(
      /internal wallet failure/i,
    );
  });

  it("rechecks runtime ownership before a chain-switch wallet prompt", async () => {
    const changed = new Error("wallet session changed");
    let checks = 0;
    const assertCurrent = vi.fn(() => {
      checks += 1;
      if (checks === 3) throw changed;
    });
    const provider = {
      request: vi.fn(async ({ type }: { type?: string }) => {
        if (type === "wallet_switchStarknetChain") return true;
        return "0x1";
      }),
    };

    await expect(ensureWalletChain(provider, deployment, assertCurrent)).rejects.toBe(changed);
    expect(provider.request.mock.calls.some(([request]) => request.type === "wallet_switchStarknetChain")).toBe(false);
  });

  it("rejects cyclic wallet chain responses without overflowing", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.result = cyclic;
    const provider = {
      request: vi.fn(async ({ type }: { type?: string }) => {
        if (type === "wallet_switchStarknetChain") return true;
        return cyclic;
      }),
    };

    await expect(ensureWalletChain(provider, deployment)).rejects.toThrow(
      /did not report its network/i,
    );
  });

  it("rejects malformed and cyclic connected addresses", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.account = cyclic;

    expect(connectedProviderAddress(cyclic as never)).toBeNull();
    expect(
      connectedProviderAddress({ account: { address: "not-a-felt" } }),
    ).toBeNull();
  });

  it("treats throwing wallet fields as unavailable", async () => {
    const provider = {
      request: vi.fn(async ({ type }: { type?: string }) => {
        if (type === "wallet_switchStarknetChain") return true;
        return Object.defineProperty({}, "chainId", {
          get: () => { throw new Error("broken chain getter"); },
        });
      }),
      get account(): never {
        throw new Error("broken account getter");
      },
      get selectedAddress(): never {
        throw new Error("broken selected address getter");
      },
    };

    expect(connectedProviderAddress(provider as never)).toBeNull();
    await expect(ensureWalletChain(provider, deployment)).rejects.toThrow(
      /did not report its network/i,
    );
  });

  it("bounds malformed wallet error objects", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.cause = cyclic;
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(walletErrorMessage(cyclic)).toBe("");
    expect(walletErrorMessage(proxy)).toBe("");
    expect(walletErrorMessage({ cause: { message: "User rejected" } })).toBe(
      "User rejected",
    );
  });

  it("requires accepted finality rather than execution success alone", async () => {
    vi.spyOn(runtimeHttp, "starknetRpc").mockResolvedValue({
      result: {
        execution_status: "SUCCEEDED",
        finality_status: "RECEIVED",
      },
    });
    await expect(fetchTransactionReceiptStatus("0x1", deployment)).resolves.toEqual({
      failed: false,
      notFound: false,
      confirmed: false,
    });
  });
});
