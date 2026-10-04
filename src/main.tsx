import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/geist/wght.css";
import "@fontsource/ibm-plex-mono/300.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import App from "./App";
import { setWalletRuntime, walletRuntime } from "./domain/browserWallet";
import { e2eHooksEnabled } from "./domain/e2eHooks";
import "./globals.css";

// read before the app normalizes the route, which drops the query string.
const exposeE2eHooks = e2eHooksEnabled();

void import("./zylithWalletRuntime")
  .then(async module => {
    await module.installConfiguredZylithWalletRuntime();
    if (exposeE2eHooks) {
      (window as unknown as { zylithWallet?: unknown }).zylithWallet =
        walletRuntime();
    }
  })
  .catch(() => setWalletRuntime(null, "Private trading failed to load."));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
