import { Brand } from "./Brand";
import { ChevronDownIcon, WalletIcon } from "./Icons";
import { TokenIcon } from "./TokenIcon";
import { fmtAddr } from "../../domain/browserWallet";

export type AppPage = "trade" | "assets" | "orders";

const nav: Array<{ page: AppPage; label: string }> = [
  { page: "trade", label: "Trade" },
  { page: "assets", label: "Assets" },
  { page: "orders", label: "Orders" },
];

export function AppHeader({
  activePage,
  starknetAddress,
  walletReady,
  onNavigate,
  onWallet,
}: {
  activePage: AppPage;
  starknetAddress: string | null;
  walletReady: boolean;
  onNavigate: (page: AppPage) => void;
  onWallet: () => void;
}) {
  const walletLabel = starknetAddress
    ? walletReady
      ? fmtAddr(starknetAddress)
      : "Authorize trading"
    : "Connect wallet";

  return (
    <header className="app-header">
      <button type="button" className="brand-link" aria-label="Zylith home" onClick={() => onNavigate("trade")}>
        <Brand />
      </button>
      <nav className="primary-nav" aria-label="Primary navigation">
        {nav.map(({ page, label }) => (
          <button
            key={page}
            type="button"
            className={`nav-link ${activePage === page ? "active" : ""}`}
            aria-current={activePage === page ? "page" : undefined}
            onClick={() => onNavigate(page)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="header-actions">
        <button className="network-button" type="button" aria-label="Network: Starknet Sepolia">
          <TokenIcon token="STRK" size={19} />
          <span className="network-name">Starknet</span>
          <ChevronDownIcon className="icon-16" />
        </button>
        <button className="wallet-button" type="button" aria-label={walletLabel} onClick={onWallet}>
          <WalletIcon className="icon-16" />
          <span>{walletLabel}</span>
        </button>
      </div>
    </header>
  );
}
