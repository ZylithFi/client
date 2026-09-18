import type { VenueBbo } from "../lib/venueBbo";

function formatPrice(value: number) {
  return value > 0 ? value.toLocaleString("en-US", { maximumFractionDigits: 8 }) : "-";
}

export function BboFeedBar({
  feeds,
}: {
  feeds: VenueBbo[];
}) {
  return (
    <section className="bbo-bar" aria-label="BBO feeds">
      <div className="bbo-label">BBO feeds</div>
      {feeds.map((feed) => (
        <div className="bbo-venue" key={feed.venue}>
          <span className={`feed-state ${Boolean(feed.observedAtUnixMs && Date.now() - feed.observedAtUnixMs < 30_000 && feed.bid > 0 && feed.ask > 0) ? "live" : "stale"}`} aria-hidden="true" />
          <strong>{feed.venue}</strong>
          <span className="bbo-quote"><span className="bid">{formatPrice(feed.bid)}</span><span className="quote-slash">/</span><span className="ask">{formatPrice(feed.ask)}</span></span>
        </div>
      ))}
    </section>
  );
}
