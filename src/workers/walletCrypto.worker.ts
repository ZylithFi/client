import {
  createWalletCryptoWorkerReplySink,
  createWalletCryptoWorkerDispatcher,
  dispatchWalletCryptoWorkerMessage,
  type WalletSessionModule,
} from "./walletCryptoProtocol";
import {
  createIndexedDbWalletDeviceOwnedKeyStore,
  createWalletDeviceWorkerService,
} from "../domain/walletDeviceSession";
import { createWalletSignatureVaultWorkerService } from "../domain/walletLocalCrypto";

interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: "messageerror", listener: () => void): void;
  postMessage(message: unknown): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
const WALLET_WASM_MODULE_URL = "/wallet/zylith_wallet_wasm.js";
let terminateDispatcher: ReturnType<typeof createWalletCryptoWorkerDispatcher>["terminate"] = () => undefined;
const replySink = createWalletCryptoWorkerReplySink(
  scope,
  (code) => terminateDispatcher(code),
);
const dispatcher = createWalletCryptoWorkerDispatcher({
  signatureVault: createWalletSignatureVaultWorkerService(),
  deviceSessions: createWalletDeviceWorkerService({
    keyStore: createIndexedDbWalletDeviceOwnedKeyStore(),
  }),
  loadWalletModule: async () => {
    const module = await import(/* @vite-ignore */ WALLET_WASM_MODULE_URL);
    return module as unknown as WalletSessionModule;
  },
  onAsyncTerminal: (code) => replySink.fail(code),
});
terminateDispatcher = (code) => dispatcher.terminate(code);

scope.addEventListener("message", (event) => {
  void dispatchWalletCryptoWorkerMessage(dispatcher, replySink, event.data);
});

scope.addEventListener("messageerror", () => {
  replySink.fail("INVALID_MESSAGE");
});
