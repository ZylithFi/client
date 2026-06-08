import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSelectedStarknetProvider,
  connectStarknetProvider,
  connectedStarknetAddress,
  disconnectStarknetProvider,
  discoverStarknetWallets,
  discoverStarknetWalletsAsync,
  restoreConnectedStarknetWallet,
  selectedStarknetProvider,
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
    clearSelectedStarknetProvider();
    window.localStorage.removeItem(selectedWalletKey);
    window.localStorage.removeItem(connectedAddressKey);
    (window as typeof window & {
      starknetProviders?: unknown;
      starknet?: unknown;
      starknet_argentX?: unknown;
      starknet_braavos?: unknown;
      braavosStarknet?: unknown;
      zylithSelectedStarknetProvider?: unknown;
      zylithSelectedStarknetAddress?: unknown;
      ready?: unknown;
    }).starknet = undefined;
    (window as typeof window & { starknetProviders?: unknown }).starknetProviders = undefined;
    (window as typeof window & { starknet_argentX?: unknown }).starknet_argentX = undefined;
    (window as typeof window & { starknet_braavos?: unknown }).starknet_braavos = undefined;
    (window as typeof window & { braavosStarknet?: unknown }).braavosStarknet = undefined;
    (window as typeof window & { ready?: unknown }).ready = undefined;
    (window as typeof window & { zylithSelectedStarknetProvider?: unknown }).zylithSelectedStarknetProvider = undefined;
    (window as typeof window & { zylithSelectedStarknetAddress?: unknown }).zylithSelectedStarknetAddress = undefined;
    delete (window as unknown as { starknet_hidden_braavos?: unknown }).starknet_hidden_braavos;
  });

  it("clears local selected wallet state without requiring extension disconnect for switch wallet", async () => {
    const disconnect = vi.fn();
    const wallet = provider("0xabc", disconnect);
    const address = await connectStarknetProvider(wallet as never, wallet.id);

    expect(address).toBe("0xabc");
    expect(selectedStarknetProvider()).toBe(wallet);
    expect(connectedStarknetAddress()).toBe("0xabc");

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

  it("does not treat a stored address as an active wallet session", async () => {
    const wallet = providerWithoutAccount("ready");
    wallet.name = "ReadyX";
    (window as typeof window & { starknet?: unknown }).starknet = wallet;
    window.sessionStorage.setItem(selectedWalletKey, wallet.id);
    window.sessionStorage.setItem(connectedAddressKey, "0xstale");

    expect(selectedStarknetProvider()).toBe(wallet);
    expect(connectedStarknetAddress()).toBeNull();
    await expect(connectStarknetProvider(wallet as never, wallet.id)).resolves.toBeNull();
  });

  it("restores an already-authorized wallet session without opening a connect prompt", async () => {
    const request = vi.fn(async (rawRequest: { type?: string; params?: unknown }) => {
      const params = rawRequest.params as { silent_mode?: boolean } | undefined;
      if (rawRequest.type === "wallet_requestAccounts" && params?.silent_mode === true) {
        return [{ address: "0xrestored" }];
      }
      throw new Error("interactive prompt should not be used");
    });
    const wallet = {
      id: "braavos",
      name: "Braavos",
      request,
    };
    (window as typeof window & { starknet_braavos?: unknown }).starknet_braavos = wallet;
    window.sessionStorage.setItem(selectedWalletKey, wallet.id);

    await expect(restoreConnectedStarknetWallet()).resolves.toBe("0xrestored");

    expect(connectedStarknetAddress()).toBe("0xrestored");
    expect(request).toHaveBeenCalledWith({
      type: "wallet_requestAccounts",
      params: { silent_mode: true },
    });
  });

  it("discovers Braavos from object registries and ranks it before Ready wrappers", () => {
    const braavos = {
      id: "braavos-extension",
      name: "Braavos",
      request: vi.fn(async () => null),
    };
    const ready = {
      id: "ready",
      name: "ReadyX",
      request: vi.fn(async () => null),
    };
    (window as typeof window & { starknet?: unknown }).starknet = ready;
    (window as typeof window & { starknetProviders?: unknown }).starknetProviders = {
      braavos: { provider: braavos },
      ready: { provider: ready },
    };

    const wallets = discoverStarknetWallets();

    expect(wallets.map(wallet => wallet.name)).toEqual(["Braavos", "ReadyX"]);
    expect(wallets.map(wallet => wallet.id)).toEqual(["braavos", "ready"]);
  });

  it("uses the explicit Braavos injection key even when provider metadata is generic", () => {
    const braavos = {
      id: "wallet-provider",
      name: "Starknet wallet",
      request: vi.fn(async () => null),
    };
    (window as typeof window & { starknet_braavos?: unknown }).starknet_braavos = braavos;

    const wallets = discoverStarknetWallets();

    expect(wallets[0]?.name).toBe("Braavos");
    expect(wallets[0]?.id).toBe("braavos");
  });

  it("discovers Braavos when the injection key contains a nested provider", () => {
    const braavosProvider = {
      id: "wallet-provider",
      name: "Starknet wallet",
      request: vi.fn(async () => null),
    };
    ((window as unknown) as { starknet_braavos?: unknown }).starknet_braavos = {
      provider: braavosProvider,
    };

    const wallets = discoverStarknetWallets();

    expect(wallets[0]?.name).toBe("Braavos");
    expect(wallets[0]?.id).toBe("braavos");
  });

  it("discovers Braavos from nested wallet registries returned by async discovery fallback", async () => {
    const braavosProvider = {
      id: "wallet-provider",
      name: "Starknet wallet",
      request: vi.fn(async () => null),
    };
    (window as typeof window & { starknetProviders?: unknown }).starknetProviders = [{
      id: "braavos-wallet",
      name: "Braavos",
      wallet: { provider: braavosProvider },
    }];

    const wallets = await discoverStarknetWalletsAsync();

    expect(wallets[0]?.name).toBe("Braavos");
    expect(wallets[0]?.id).toBe("braavos");
  });

  it("discovers non-enumerable injected wallet properties", () => {
    const braavos = {
      id: "wallet-provider",
      name: "Starknet wallet",
      request: vi.fn(async () => null),
    };
    Object.defineProperty(window, "starknet_hidden_braavos", {
      configurable: true,
      enumerable: false,
      value: braavos,
    });

    const wallets = discoverStarknetWallets();

    expect(wallets[0]?.name).toBe("Braavos");
    expect(wallets[0]?.id).toBe("braavos");
  });

  it("does not show MetaMask Snap in the Zylith Starknet wallet list", () => {
    const metamaskSnap = {
      id: "metamask-snap",
      name: "MetaMask",
      request: vi.fn(async () => null),
    };
    const ready = {
      id: "ready",
      name: "ReadyX",
      request: vi.fn(async () => null),
    };
    (window as typeof window & { starknetProviders?: unknown }).starknetProviders = {
      metamask: { provider: metamaskSnap },
      ready: { provider: ready },
    };

    const wallets = discoverStarknetWallets();

    expect(wallets.map(wallet => wallet.name)).toEqual(["ReadyX"]);
  });
});
