import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/geist/wght.css";
import "@fontsource/ibm-plex-mono/300.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import App from "./App";
import { walletRuntime } from "./domain/browserWallet";
import { e2eHooksEnabled } from "./domain/e2eHooks";
import "./globals.css";

void import("./zylithWalletRuntime")
  .then(async module => {
    await module.installConfiguredZylithWalletRuntime();
    if (e2eHooksEnabled()) {
      (window as unknown as { zylithWallet?: unknown }).zylithWallet =
        walletRuntime();
    }
  });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
