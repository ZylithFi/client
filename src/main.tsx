import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/ibm-plex-mono/300.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import App from "./App";
import "./globals.css";
import { installOfflineRenewalOperatorRuntime } from "./offlineRenewalOperator";
import { installConfiguredZylithWalletRuntime } from "./zylithWalletRuntime";

void installConfiguredZylithWalletRuntime();
installOfflineRenewalOperatorRuntime();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
