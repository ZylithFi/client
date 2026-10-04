import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildZylithWalletAuthTypedData,
  connectedProviderAddress,
  ensureWalletChain,
  fetchTransactionReceiptStatus,
  walletErrorMessage,
} from "./starknetProvider";
import * as runtimeHttp from "../domain/runtimeHttp";

const deployment = {
  chain_id: "0x534e5f5345504f4c4941",
  network: "sepolia",
  rpc_url: "https://rpc.example",
};

describe("starknet provider safety", () => {
  beforeEach(() => vi.restoreAllMocks());

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

  it("shows the real origin and an explicit anti-phishing action in wallet auth", async () => {
    const typedData = await buildZylithWalletAuthTypedData({
      walletAddress: "0x123",
      chainId: deployment.chain_id,
      deploymentId: "deployment-v2",
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
        deploymentId: "deployment-v2",
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
