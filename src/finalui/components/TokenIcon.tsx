interface TokenIconProps {
  token: string;
  size?: number;
}

export function TokenIcon({ token, size = 24 }: TokenIconProps) {
  const icon = token.toLowerCase();
  if (["strk", "usdc", "eth"].includes(icon)) {
    return (
      <img
        className="token-icon token-icon-image"
        src={`/tokens/${icon}.svg`}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
      />
    );
  }
  return <span className="token-icon token-icon-strk" style={{ width: size, height: size }} aria-hidden="true">{token.slice(0, 1)}</span>;
}
