import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../domain/deployment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../domain/deployment")>()),
  loadDeployment: vi.fn(async () => ({
    chain_id: "0x534e5f5345504f4c4941",
    network: "sepolia",
    rpc_url: "https://rpc.example",
  })),
}));

import {
  clearSelectedStarknetProvider,
  connectStarknetProvider,
} from "../domain/browserWallet";
import { selectInjectedStarknetProvider } from "./starknetProvider";

const SEPOLIA = "0x534e5f5345504f4c4941";

function injectedWallet(id: string, accounts: { silent: string[]; interactive: string[] | Error }) {
  const request = vi.fn(async ({ type, params }: { type: string; params?: { silent_mode?: boolean } }) => {
    if (type === "wallet_requestAccounts") {
      if (params?.silent_mode) return accounts.silent;
      if (accounts.interactive instanceof Error) throw accounts.interactive;
      return accounts.interactive;
    }
    if (type === "wallet_requestChainId") return SEPOLIA;
    return null;
  });
  return { id, name: id, request };
}

describe("selected wallet for private transactions", () => {
  beforeEach(() => {
    for (const name of ["localStorage", "sessionStorage"]) {
      const storage = new Map<string, string>();
      Object.defineProperty(window, name, {
        configurable: true,
        value: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => { storage.set(key, value); },
          removeItem: (key: string) => { storage.delete(key); },
        },
      });
    }
    clearSelectedStarknetProvider();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).starknet_xverse;
    delete (window as unknown as Record<string, unknown>).starknet_ready;
  });

  it("never prompts or switches to another installed wallet when the chosen one is unavailable", async () => {
    const xverse = injectedWallet("xverse", { silent: [], interactive: new Error("wallet is locked") });
    const ready = injectedWallet("ready", { silent: ["0xbbb"], interactive: ["0xbbb"] });
    Object.assign(window, { starknet_xverse: xverse, starknet_ready: ready });
    localStorage.setItem("zylith:selected-starknet-wallet", "xverse");

    await expect(selectInjectedStarknetProvider("0xaaa")).rejects.toThrow(/locked/i);
    expect(ready.request).not.toHaveBeenCalled();
    expect(localStorage.getItem("zylith:selected-starknet-wallet")).toBe("xverse");
  });

  it("rejects a wallet whose account differs from the authorized one", async () => {
    const xverse = injectedWallet("xverse", { silent: ["0xccc"], interactive: ["0xccc"] });
    Object.assign(window, { starknet_xverse: xverse });
    localStorage.setItem("zylith:selected-starknet-wallet", "xverse");

    await expect(selectInjectedStarknetProvider("0xaaa")).rejects.toThrow(/wallet changed/i);
  });

  it("rechecks the selected account instead of trusting a stale cached address", async () => {
    let activeAddress = "0xaaa";
    const xverse = {
      id: "xverse",
      name: "xverse",
      request: vi.fn(async ({ type }: { type: string }) => {
        if (type === "wallet_requestAccounts") return [activeAddress];
        if (type === "wallet_requestChainId") return SEPOLIA;
        return null;
      }),
    };
    Object.assign(window, { starknet_xverse: xverse });
    await connectStarknetProvider(xverse as never, "xverse");
    activeAddress = "0xbbb";

    await expect(selectInjectedStarknetProvider("0xaaa")).rejects.toThrow(/wallet changed/i);
  });

  it("returns the chosen wallet when its account matches", async () => {
    const xverse = injectedWallet("xverse", { silent: ["0xaaa"], interactive: ["0xaaa"] });
    Object.assign(window, { starknet_xverse: xverse });
    localStorage.setItem("zylith:selected-starknet-wallet", "xverse");

    await expect(selectInjectedStarknetProvider("0xaaa")).resolves.toBe(xverse);
  });
});
