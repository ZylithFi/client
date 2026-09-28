import type { SVGProps } from 'react';

function IconBase({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="m7 10 5 5 5-5" /></IconBase>;
}
export function WalletIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H19v14H6.5A2.5 2.5 0 0 1 4 16.5z"/><path d="M4 8h12.5A2.5 2.5 0 0 1 19 10.5V14h-4a2 2 0 1 1 0-4h4" /></IconBase>;
}
export function SwapIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M8 4v14"/><path d="m5 7 3-3 3 3"/><path d="M16 20V6"/><path d="m13 17 3 3 3-3" /></IconBase>;
}
export type ChartStyleIconVariant =
  | "bars"
  | "candles"
  | "hollow-candles"
  | "line"
  | "line-markers"
  | "step-line"
  | "area"
  | "hlc-area"
  | "baseline"
  | "columns"
  | "high-low"
  | "heikin-ashi";

export function ChartStyleIcon({ variant, ...props }: SVGProps<SVGSVGElement> & { variant: ChartStyleIconVariant }) {
  if (variant === "line") return <IconBase {...props}><path d="m4 16 5-5 3 2 6-7 2 2" /></IconBase>;
  if (variant === "line-markers") return <IconBase {...props}><path d="m4 16 5-5 3 2 6-7 2 2" /><circle cx="4" cy="16" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="11" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="13" r="1.4" fill="currentColor" stroke="none" /><circle cx="18" cy="6" r="1.4" fill="currentColor" stroke="none" /></IconBase>;
  if (variant === "step-line") return <IconBase {...props}><path d="M4 16h5v-5h5V7h6" /></IconBase>;
  if (variant === "area" || variant === "hlc-area") return <IconBase {...props}><path d="m4 17 5-6 3 2 6-7 2 2v10H4z" fill="currentColor" stroke="none" opacity=".32" /><path d="m4 17 5-6 3 2 6-7 2 2" /></IconBase>;
  if (variant === "baseline") return <IconBase {...props}><path d="M4 12h16" /><path d="m4 12 5-5 3 2 6-5 2 2v6H4z" fill="currentColor" stroke="none" opacity=".42" /><path d="m4 12 5 5 3-2 6 5 2-2v-6H4z" fill="currentColor" stroke="none" opacity=".22" /></IconBase>;
  if (variant === "columns") return <IconBase {...props}><rect x="4" y="12" width="3" height="8" fill="currentColor" stroke="none" /><rect x="10.5" y="7" width="3" height="13" fill="currentColor" stroke="none" /><rect x="17" y="10" width="3" height="10" fill="currentColor" stroke="none" /></IconBase>;
  if (variant === "bars" || variant === "high-low") return <IconBase {...props}><path d="M6 4v16M12 3v18M18 5v14" /><path d="M4 9h4M10 7h4M16 13h4" /><path d="M4 15h4M10 14h4M16 9h4" /></IconBase>;
  if (variant === "hollow-candles") return <IconBase {...props}><path d="M6 4v16M12 3v18M18 5v14" /><rect x="4" y="8" width="4" height="6" /><rect x="10" y="6" width="4" height="9" /><rect x="16" y="10" width="4" height="5" /></IconBase>;
  if (variant === "heikin-ashi") return <IconBase {...props}><path d="M6 4v16M12 3v18M18 5v14" /><rect x="4" y="10" width="4" height="4" fill="currentColor" stroke="none" /><rect x="10" y="5" width="4" height="11" fill="currentColor" stroke="none" opacity=".72" /><rect x="16" y="9" width="4" height="6" fill="currentColor" stroke="none" /></IconBase>;
  return <IconBase {...props}><path d="M6 4v16M12 3v18M18 5v14" /><rect x="4" y="8" width="4" height="6" fill="currentColor" stroke="none" /><rect x="10" y="6" width="4" height="9" fill="currentColor" stroke="none" /><rect x="16" y="10" width="4" height="5" fill="currentColor" stroke="none" /></IconBase>;
}
export function FullscreenIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M8 4H4v4"/><path d="M16 4h4v4"/><path d="M20 16v4h-4"/><path d="M4 16v4h4"/></IconBase>;
}
export function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M12 3 5 6v5c0 4.8 2.8 8.2 7 10 4.2-1.8 7-5.2 7-10V6z"/><path d="m9.5 12 1.7 1.7 3.6-4" /></IconBase>;
}
export function ArrowUpRightIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M7 17 17 7"/><path d="M8 7h9v9" /></IconBase>;
}
export function SlidersIcon(props: SVGProps<SVGSVGElement>) {
  return <IconBase {...props}><path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2" /></IconBase>;
}
