import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStarknetAccountsChanged,
  clearSelectedStarknetProvider,
  connectStarknetProvider,
  connectedStarknetAddress,
  disconnectStarknetProvider,
  discoverStarknetWallets,
  discoverStarknetWalletsAsync,
  restoreConnectedStarknetWallet,
  selectedStarknetProvider,
  setWalletRuntime,
  subscribeStarknetProviderEvents,
  subscribeWalletRuntime,
} from "./browserWallet";

const selectedWalletKey = "zylith:selected-starknet-wallet";
const connectedAddressKey = "zylith:connected-starknet-address";
function provider(address: string, disconnect = vi.fn()) {
  return {
    id: `wallet-${address}`,
    name: `Wallet ${address}`,
    request: vi.fn(async ({ type }: { type?: string }) => {
      if (type === "wallet_requestAccounts") return [{ address }];
      return null;
    }),
    account: { address },
    disconnect,
  };
}

function providerWithoutAccount(id: string) {
  return {
    id,
    name: `Wallet ${id}`,
    request: vi.fn(async () => null),
  };
}

describe("browser wallet selection", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
        removeItem: vi.fn((key: string) => { storage.delete(key); }),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSelectedStarknetProvider();
    window.localStorage.removeItem(selectedWalletKey);
    window.localStorage.removeItem(connectedAddressKey);
    (window as typeof window & {
      starknetProviders?: unknown;
      starknet?: unknown;
      starknet_ready?: unknown;
      starknet_argentX?: unknown;
      starknet_xverse?: unknown;
      argentX?: unknown;
      ready?: unknown;
      xverse?: unknown;
    }).starknet = undefined;
    (window as typeof window & { starknetProviders?: unknown }).starknetProviders = undefined;
    delete (window as typeof window & { starknet_ready?: unknown }).starknet_ready;
    (window as typeof window & { starknet_argentX?: unknown }).starknet_argentX = undefined;
    (window as typeof window & { starknet_xverse?: unknown }).starknet_xverse = undefined;
    (window as typeof window & { argentX?: unknown }).argentX = undefined;
    (window as typeof window & { ready?: unknown }).ready = undefined;
    (window as typeof window & { xverse?: unknown }).xverse = undefined;
    delete (window as unknown as { starknet_hidden_ready?: unknown }).starknet_hidden_ready;
  });

  it("clears local selected wallet state without requiring extension disconnect for switch wallet", async () => {
    const disconnect = vi.fn();
    const wallet = provider("0xabc", disconnect);
    const address = await connectStarknetProvider(wallet as never, wallet.id);

    expect(address).toBe("0xabc");
    expect(selectedStarknetProvider()).toBe(wallet);
    expect(connectedStarknetAddress()).toBe("0xabc");
    expect("zylithSelectedStarknetProvider" in window).toBe(false);
    expect("zylithSelectedStarknetAddress" in window).toBe(false);

    clearSelectedStarknetProvider();

    expect(disconnect).not.toHaveBeenCalled();
    expect(selectedStarknetProvider()).toBeNull();
    expect(connectedStarknetAddress()).toBeNull();
  });

  it("disconnects the extension best-effort when the user chooses disconnect", async () => {
    const disconnect = vi.fn();
    const wallet = provider("0xdef", disconnect);
    await connectStarknetProvider(wallet as never, wallet.id);

    disconnectStarknetProvider();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(selectedStarknetProvider()).toBeNull();
    expect(connectedStarknetAddress()).toBeNull();
  });

  it("uses account-change payloads and forgets a revoked wallet permission", async () => {
    const wallet = provider("0xabc");
    await connectStarknetProvider(wallet as never, wallet.id);

    expect(applyStarknetAccountsChanged(["0xdef"])).toBe("0xdef");
    expect(window.sessionStorage.getItem(connectedAddressKey)).toBe("0xdef");

    expect(applyStarknetAccountsChanged([])).toBeNull();
    expect(selectedStarknetProvider()).toBeNull();
    expect(window.localStorage.getItem(selectedWalletKey)).toBeNull();
  });

  it("does not treat a stored address as an active wallet session", async () => {
    const wallet = providerWithoutAccount("ready");
    wallet.name = "Ready";
    (window as typeof window & { starknet?: unknown }).starknet = wallet;
    window.sessionStorage.setItem(selectedWalletKey, wallet.id);
    window.sessionStorage.setItem(connectedAddressKey, "0x123");

    expect(selectedStarknetProvider()).toBe(wallet);
    expect(connectedStarknetAddress()).toBeNull();
    await expect(connectStarknetProvider(wallet as never, wallet.id)).resolves.toBeNull();
  });

  it("rejects malformed wallet account addresses", async () => {
    const wallet = provider("not-a-felt");

    await expect(connectStarknetProvider(wallet as never, wallet.id)).resolves.toBeNull();
    expect(connectedStarknetAddress()).toBeNull();
  });

  it("rejects cyclic wallet account responses without overflowing", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.account = cyclic;
    const wallet = {
      id: "ready",
      name: "Ready",
      request: vi.fn(async () => cyclic),
    };

    await expect(
      connectStarknetProvider(wallet as never, wallet.id),
    ).resolves.toBeNull();
    expect(connectedStarknetAddress()).toBeNull();
  });

  it("does not crash while classifying a revoked provider error", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const wallet = {
      id: "ready",
      name: "Ready",
      request: vi.fn(async () => { throw proxy; }),
    };

    let rejectedOriginal = false;
    try {
      await connectStarknetProvider(wallet as never, wallet.id);
    } catch (error) {
      rejectedOriginal = error === proxy;
    }
    expect(rejectedOriginal).toBe(true);
  });

  it("isolates throwing provider fields during discovery and account parsing", async () => {
    const broken = Object.defineProperties({}, {
      id: { get: () => { throw new Error("broken id getter"); } },
      name: { get: () => { throw new Error("broken name getter"); } },
      request: { get: () => { throw new Error("broken request getter"); } },
      account: { get: () => { throw new Error("broken account getter"); } },
    });
    const ready = provider("0x456");
    ready.id = "ready";
    ready.name = "Ready";
    (window as typeof window & { starknetProviders?: unknown }).starknetProviders = {
      broken,
      ready,
    };

    expect(discoverStarknetWallets()).toEqual([
      expect.objectContaining({ id: "ready", provider: ready }),
    ]);
    await expect(connectStarknetProvider(ready as never, ready.id)).resolves.toBe("0x456");
  });

  it("treats throwing account getters as unavailable instead of crashing", () => {
    const wallet = {
      id: "ready",
      name: "Ready",
      request: vi.fn(async () => null),
      get account(): never {
        throw new Error("broken account getter");
      },
      get selectedAddress(): never {
        throw new Error("broken selected address getter");
      },
    };
    (window as typeof window & { starknet_ready?: unknown }).starknet_ready = wallet;

    expect(discoverStarknetWallets()).toEqual([
      expect.objectContaining({ id: "ready", provider: wallet }),
    ]);
    expect(connectedStarknetAddress()).toBeNull();
  });

  it("times out stalled interactive wallet requests", async () => {
    vi.useFakeTimers();
    const wallet = {
      id: "ready",
      name: "Ready",
      request: vi.fn(() => new Promise(() => undefined)),
    };

    const attempt = expect(
      connectStarknetProvider(wallet as never, wallet.id),
    ).rejects.toThrow(
      "Starknet wallet request timed out. Unlock your wallet and retry.",
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await attempt;
    vi.useRealTimers();
  });

  it("preserves provider request context for injected wallets", async () => {
    const wallet = {
      id: "ready",
      name: "Ready",
      account: { address: "0xabc" },
      request(this: { account?: { address?: string } }, rawRequest: { type?: string }) {
        if (rawRequest.type === "wallet_requestAccounts") {
          return Promise.resolve([{ address: this.account?.address }]);
        }
        return Promise.resolve(null);
      },
    };
    const requestSpy = vi.spyOn(wallet, "request");

    await expect(connectStarknetProvider(wallet as never, wallet.id)).resolves.toBe("0xabc");

    expect(requestSpy).toHaveBeenCalledWith({
      type: "wallet_requestAccounts",
      params: { silent_mode: false },
    });
  });

  it("does not persist the runtime selected-provider sentinel as a wallet id", async () => {
    const wallet = provider("0xabc");
    wallet.id = "ready";
    wallet.name = "Ready";

    await expect(connectStarknetProvider(wallet as never, wallet.id)).resolves.toBe("0xabc");
    expect(window.sessionStorage.getItem(selectedWalletKey)).toBe("ready");
    expect(window.localStorage.getItem(selectedWalletKey)).toBe("ready");

    await expect(connectStarknetProvider(wallet as never, "selected")).resolves.toBe("0xabc");
    expect(window.sessionStorage.getItem(selectedWalletKey)).toBe("ready");
  });

  it("restores the selected wallet after session storage is cleared", async () => {
    const wallet = provider("0x456");
    wallet.id = "ready";
    wallet.name = "Ready";
    (window as typeof window & { starknet_ready?: unknown }).starknet_ready = wallet;
    window.localStorage.setItem(selectedWalletKey, wallet.id);
    window.sessionStorage.clear();

    await expect(restoreConnectedStarknetWallet()).resolves.toBe("0x456");
    expect(selectedStarknetProvider()).toBe(wallet);
  });

  it("restores an already-authorized wallet session without opening a connect prompt", async () => {
    const request = vi.fn(async (rawRequest: { type?: string; params?: unknown }) => {
      const params = rawRequest.params as { silent_mode?: boolean } | undefined;
      if (rawRequest.type === "wallet_requestAccounts" && params?.silent_mode === true) {
        return [{ address: "0x456" }];
      }
      throw new Error("interactive prompt should not be used");
    });
    const wallet = {
      id: "ready",
      name: "Ready",
      request,
    };
    (window as typeof window & { starknet_ready?: unknown }).starknet_ready = wallet;
    window.sessionStorage.setItem(selectedWalletKey, wallet.id);

    await expect(restoreConnectedStarknetWallet()).resolves.toBe("0x456");

    expect(connectedStarknetAddress()).toBe("0x456");
    expect(request).toHaveBeenCalledWith({
      type: "wallet_requestAccounts",
      params: { silent_mode: true },
    });
  });

  it("does not let a stale silent restore replace a newly selected wallet", async () => {
    let finishRestore: ((value: Array<{ address: string }> | null) => void) | undefined;
    const oldWallet = provider("0x111") as Omit<ReturnType<typeof provider>, "account" | "request"> & {
      account?: { address: string };
      request: (request: { type?: string; params?: { silent_mode?: boolean } }) => Promise<unknown>;
    };
    oldWallet.id = "ready";
    await connectStarknetProvider(oldWallet as never, oldWallet.id);
    delete oldWallet.account;
    oldWallet.request = vi.fn(({ type, params }: { type?: string; params?: { silent_mode?: boolean } }) => {
      if (type === "wallet_requestAccounts" && params?.silent_mode) {
        return new Promise((resolve) => { finishRestore = resolve; });
      }
      return Promise.resolve(null);
    });

    const staleRestore = restoreConnectedStarknetWallet();
    const newWallet = provider("0x222");
    newWallet.id = "xverse";
    await expect(connectStarknetProvider(newWallet as never, newWallet.id)).resolves.toBe("0x222");
    finishRestore?.([{ address: "0x111" }]);

    await expect(staleRestore).resolves.toBeNull();
    expect(selectedStarknetProvider()).toBe(newWallet);
    expect(connectedStarknetAddress()).toBe("0x222");
  });

  it("does not retain a provider discovered after the user clears wallet state", async () => {
    const wallet = provider("0x333");
    wallet.id = "ready";
    let reads = 0;
    Object.defineProperty(window, "starknet_ready", {
      configurable: true,
      get() {
        reads += 1;
        return reads > 2 ? wallet : undefined;
      },
    });
    window.sessionStorage.setItem(selectedWalletKey, wallet.id);

    const staleRestore = restoreConnectedStarknetWallet();
    clearSelectedStarknetProvider();

    await expect(staleRestore).resolves.toBeNull();
    expect(selectedStarknetProvider()).toBeNull();
    expect(connectedStarknetAddress()).toBeNull();
  });

  it("discovers Ready and Xverse from object registries and ranks Ready first", () => {
    const xverse = {
      id: "xverse-extension",
      name: "Xverse",
      request: vi.fn(async () => null),
    };
    const ready = {
      id: "ready",
      name: "Ready",
      request: vi.fn(async () => null),
    };
    (window as typeof window & { starknetProviders?: unknown }).starknetProviders = {
      xverse: { provider: xverse },
      ready: { provider: ready },
    };

    const wallets = discoverStarknetWallets();

    expect(wallets.map(wallet => wallet.name)).toEqual(["Ready X", "Xverse"]);
    expect(wallets.map(wallet => wallet.id)).toEqual(["ready", "xverse"]);
  });

  it("discovers Ready under its current argentX provider identity", () => {
    const ready = {
      id: "argentX",
      name: "Argent X",
      request: vi.fn(async () => null),
    };
    Object.defineProperty(window, "starknet_argentX", {
      configurable: true,
      value: ready,
    });

    expect(discoverStarknetWallets()).toEqual([
      expect.objectContaining({ id: "ready", name: "Ready X", provider: ready }),
    ]);
  });

  it("uses the explicit Ready injection key even when provider metadata is generic", () => {
    const ready = {
      id: "wallet-provider",
      name: "Starknet wallet",
      request: vi.fn(async () => null),
    };
    (window as typeof window & { starknet_ready?: unknown }).starknet_ready = ready;

    const wallets = discoverStarknetWallets();

    expect(wallets[0]?.name).toBe("Ready X");
    expect(wallets[0]?.id).toBe("ready");
  });

  it("discovers Xverse when the injection key contains a nested provider", () => {
    const xverseProvider = {
      id: "wallet-provider",
      name: "Starknet wallet",
      request: vi.fn(async () => null),
    };
    ((window as unknown) as { starknet_xverse?: unknown }).starknet_xverse = {
      provider: xverseProvider,
    };

    const wallets = discoverStarknetWallets();

    expect(wallets[0]?.name).toBe("Xverse");
    expect(wallets[0]?.id).toBe("xverse");
  });

  it("discovers Ready from nested wallet registries returned by async discovery", async () => {
    const readyProvider = {
      id: "wallet-provider",
      name: "Starknet wallet",
      request: vi.fn(async () => null),
    };
    (window as typeof window & { starknetProviders?: unknown }).starknetProviders = [{
      id: "ready-wallet",
      name: "Ready",
      wallet: { provider: readyProvider },
    }];

    const wallets = await discoverStarknetWalletsAsync();

    expect(wallets[0]?.name).toBe("Ready X");
    expect(wallets[0]?.id).toBe("ready");
  });

  it("discovers non-enumerable injected wallet properties", () => {
    const ready = {
      id: "wallet-provider",
      name: "Starknet wallet",
      request: vi.fn(async () => null),
    };
    Object.defineProperty(window, "starknet_hidden_ready", {
      configurable: true,
      enumerable: false,
      value: ready,
    });

    const wallets = discoverStarknetWallets();

    expect(wallets[0]?.name).toBe("Ready X");
    expect(wallets[0]?.id).toBe("ready");
  });

  it("does not show unsupported wallets in the Zylith Starknet wallet list", () => {
    const unsupported = {
      id: "unsupported-extension",
      name: "Unsupported Starknet Wallet",
      request: vi.fn(async () => null),
    };
    const ready = {
      id: "ready",
      name: "Ready",
      request: vi.fn(async () => null),
    };
    (window as typeof window & { starknetProviders?: unknown }).starknetProviders = {
      unsupported: { provider: unsupported },
      ready: { provider: ready },
    };

    const wallets = discoverStarknetWallets();

    expect(wallets.map(wallet => wallet.name)).toEqual(["Ready X"]);
  });

  it("does not show MetaMask Snap in the Zylith Starknet wallet list", () => {
    const metamaskSnap = {
      id: "metamask-snap",
      name: "MetaMask",
      request: vi.fn(async () => null),
    };
    const ready = {
      id: "ready",
      name: "Ready",
      request: vi.fn(async () => null),
    };
    (window as typeof window & { starknetProviders?: unknown }).starknetProviders = {
      metamask: { provider: metamaskSnap },
      ready: { provider: ready },
    };

    const wallets = discoverStarknetWallets();

    expect(wallets.map(wallet => wallet.name)).toEqual(["Ready X"]);
  });

  it("does not discover enable-only wallet injections", () => {
    const enableOnlyReady = {
      id: "ready",
      name: "Ready",
      enable: vi.fn(async () => ["0xabc"]),
    };
    (window as typeof window & { starknet_ready?: unknown }).starknet_ready = enableOnlyReady;

    expect(discoverStarknetWallets()).toEqual([]);
  });

  it("notifies runtime subscribers without using browser events", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWalletRuntime(listener);

    setWalletRuntime({ isReady: () => true } as never);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setWalletRuntime(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores provider-specific unsupported event names and removes supported listeners", () => {
    const accountListener = vi.fn();
    const networkListener = vi.fn();
    const subscribed = new Map<string, (value: unknown) => void>();
    const wallet = {
      on: vi.fn((event: string, listener: (value: unknown) => void) => {
        if (event === "accountChanged" || event === "chainChanged") {
          throw new Error(`Unknwown event: ${event}`);
        }
        subscribed.set(event, listener);
      }),
      off: vi.fn((event: string) => {
        if (!subscribed.has(event)) throw new Error(`unsupported event: ${event}`);
        subscribed.delete(event);
      }),
    };

    const unsubscribe = subscribeStarknetProviderEvents(
      wallet,
      accountListener,
      networkListener,
    );

    expect([...subscribed.keys()]).toEqual(["accountsChanged", "networkChanged"]);
    subscribed.get("accountsChanged")?.(["0x123"]);
    subscribed.get("networkChanged")?.("0x534e5f5345504f4c4941");
    expect(accountListener).toHaveBeenCalledWith(["0x123"]);
    expect(networkListener).toHaveBeenCalledWith("0x534e5f5345504f4c4941");

    expect(() => unsubscribe()).not.toThrow();
    expect(subscribed.size).toBe(0);
  });
});
