import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineType,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BinanceCandle } from "../lib/binanceMarket";
import { formatQuotedPrice, marketPricePrecision } from "../lib/marketFormat";
import { ChartStyleIcon, FullscreenIcon } from "./Icons";

export type ChartInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1M";
type ChartStyle = "bars" | "candles" | "hollow-candles" | "line" | "line-markers" | "step-line" | "area" | "hlc-area" | "baseline" | "columns" | "high-low" | "heikin-ashi";

interface PriceChartProps {
  data: BinanceCandle[];
  activeInterval: ChartInterval;
  onIntervalChange: (interval: ChartInterval) => void;
  bboMidpoint: number;
  baseAsset: string;
  quoteAsset: string;
  loading?: boolean;
}

const intervals: Array<{ value: ChartInterval; label: string }> = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "D" },
  { value: "1w", label: "W" },
  { value: "1M", label: "M" },
];
const chartStyles: Array<{ value: ChartStyle; label: string; dividerBefore?: boolean }> = [
  { value: "bars", label: "Bars" },
  { value: "candles", label: "Candles" },
  { value: "hollow-candles", label: "Hollow candles" },
  { value: "line", label: "Line", dividerBefore: true },
  { value: "line-markers", label: "Line with markers" },
  { value: "step-line", label: "Step line" },
  { value: "area", label: "Area", dividerBefore: true },
  { value: "hlc-area", label: "HLC area" },
  { value: "baseline", label: "Baseline" },
  { value: "columns", label: "Columns", dividerBefore: true },
  { value: "high-low", label: "High-low" },
  { value: "heikin-ashi", label: "Heikin Ashi", dividerBefore: true },
];
const initialVisibleBars = 88;
const rightOffsetBars = 8;

function toSeriesData(candle: BinanceCandle): CandlestickData<UTCTimestamp> {
  return {
    time: candle.time as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function heikinAshi(data: BinanceCandle[]) {
  return data.reduce<BinanceCandle[]>((result, candle) => {
    const previous = result.at(-1);
    const close = (candle.open + candle.high + candle.low + candle.close) / 4;
    const open = previous ? (previous.open + previous.close) / 2 : (candle.open + candle.close) / 2;
    result.push({ time: candle.time, open, high: Math.max(candle.high, open, close), low: Math.min(candle.low, open, close), close });
    return result;
  }, []);
}

function seriesInput(data: BinanceCandle[], style: ChartStyle) {
  const candles = style === "heikin-ashi" ? heikinAshi(data) : data;
  if (["bars", "candles", "hollow-candles", "high-low", "heikin-ashi"].includes(style)) return candles.map(toSeriesData);
  return candles.map((candle) => ({ time: candle.time as UTCTimestamp, value: style === "hlc-area" ? candle.high : candle.close }));
}

function seriesPoint(candle: BinanceCandle, style: ChartStyle) {
  const source = style === "heikin-ashi" ? heikinAshi([candle])[0] : candle;
  if (["bars", "candles", "hollow-candles", "high-low", "heikin-ashi"].includes(style)) return toSeriesData(source);
  return { time: source.time as UTCTimestamp, value: style === "hlc-area" ? source.high : source.close };
}

function isSameHistory(previous: BinanceCandle[], next: BinanceCandle[]) {
  if (previous.length === 0 || next.length === 0) return false;
  if (next.length < previous.length || next.length > previous.length + 1) return false;
  const shared = Math.min(previous.length, next.length) - 1;
  for (let index = 0; index < shared; index += 1) {
    if (previous[index].time !== next[index].time) return false;
  }
  return true;
}

export function PriceChart({
  data,
  activeInterval,
  onIntervalChange,
  bboMidpoint,
  baseAsset,
  quoteAsset,
  loading = false,
}: PriceChartProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<any, Time> | null>(null);
  const midpointLineRef = useRef<IPriceLine | null>(null);
  const highLineRef = useRef<IPriceLine | null>(null);
  const lowLineRef = useRef<IPriceLine | null>(null);
  const previousDataRef = useRef<BinanceCandle[]>([]);
  const previousIntervalRef = useRef(activeInterval);
  const previousMarketRef = useRef(`${baseAsset}/${quoteAsset}`);
  const preservedViewRef = useRef<{ focusTime: number; visibleBars: number } | null>(null);
  const [hoveredCandle, setHoveredCandle] = useState<BinanceCandle | null>(null);
  const [chartStyle, setChartStyle] = useState<ChartStyle>("candles");
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const latestCandle = data.at(-1) ?? null;
  const activeCandle = hoveredCandle ?? latestCandle;
  const change = activeCandle && activeCandle.open !== 0
    ? ((activeCandle.close - activeCandle.open) / activeCandle.open) * 100
    : 0;
  const precision = useMemo(
    () => marketPricePrecision(bboMidpoint || latestCandle?.close || 1),
    [bboMidpoint, latestCandle?.close],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#080b10" },
        textColor: "#6f7886",
        attributionLogo: false,
        fontFamily: "Geist Variable, Geist, sans-serif",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(31, 40, 53, 0.58)" },
        horzLines: { color: "rgba(31, 40, 53, 0.58)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#4f6077", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#253044" },
        horzLine: { color: "#4f6077", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#253044" },
      },
      rightPriceScale: {
        autoScale: true,
        borderColor: "#202833",
        scaleMargins: { top: 0.1, bottom: 0.1 },
        minimumWidth: 72,
      },
      leftPriceScale: {
        visible: false,
      },
      timeScale: {
        borderColor: "#202833",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: rightOffsetBars,
        barSpacing: 9,
        minBarSpacing: 2.5,
        fixLeftEdge: true,
        shiftVisibleRangeOnNewBar: true,
        allowShiftVisibleRangeOnWhitespaceReplacement: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
      kineticScroll: { mouse: true, touch: true },
    });
    const series = chartStyle === "bars" || chartStyle === "high-low"
      ? chart.addSeries(BarSeries, { upColor: "#42ba8f", downColor: "#d75f68", thinBars: chartStyle === "high-low", priceLineVisible: true, lastValueVisible: true })
      : chartStyle === "candles" || chartStyle === "hollow-candles" || chartStyle === "heikin-ashi"
        ? chart.addSeries(CandlestickSeries, {
            upColor: chartStyle === "hollow-candles" ? "rgba(66,186,143,0)" : "#42ba8f",
            downColor: chartStyle === "hollow-candles" ? "rgba(215,95,104,0)" : "#d75f68",
            borderVisible: true,
            borderUpColor: "#42ba8f",
            borderDownColor: "#d75f68",
            wickUpColor: "#42ba8f",
            wickDownColor: "#d75f68",
            priceLineVisible: true,
            lastValueVisible: true,
          })
        : chartStyle === "area" || chartStyle === "hlc-area"
          ? chart.addSeries(AreaSeries, { lineColor: "#4f91df", topColor: "rgba(79,145,223,.34)", bottomColor: "rgba(79,145,223,0)", lineWidth: 2, priceLineVisible: true, lastValueVisible: true })
          : chartStyle === "baseline"
            ? chart.addSeries(BaselineSeries, { baseValue: { type: "price", price: bboMidpoint || 0 }, topLineColor: "#42ba8f", bottomLineColor: "#d75f68", topFillColor1: "rgba(66,186,143,.22)", topFillColor2: "rgba(66,186,143,0)", bottomFillColor1: "rgba(215,95,104,0)", bottomFillColor2: "rgba(215,95,104,.22)", priceLineVisible: true, lastValueVisible: true })
            : chartStyle === "columns"
              ? chart.addSeries(HistogramSeries, { color: "#4f91df", priceLineVisible: false, lastValueVisible: false })
              : chart.addSeries(LineSeries, { color: "#4f91df", lineWidth: 2, lineType: chartStyle === "step-line" ? LineType.WithSteps : LineType.Simple, pointMarkersVisible: chartStyle === "line-markers", priceLineVisible: true, lastValueVisible: true });

    chart.subscribeCrosshairMove((parameter) => {
      if (!parameter.time) {
        setHoveredCandle(null);
        return;
      }
      const point = parameter.seriesData.get(series);
      if (!point || !("open" in point)) {
        setHoveredCandle(null);
        return;
      }
      setHoveredCandle({
        time: Number(point.time),
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
      });
    });

    previousDataRef.current = [];
    chartRef.current = chart;
    seriesRef.current = series as ISeriesApi<any, Time>;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      midpointLineRef.current = null;
      highLineRef.current = null;
      lowLineRef.current = null;
    };
  }, [chartStyle]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.applyOptions({
      priceFormat: {
        type: "price",
        precision,
        minMove: 10 ** -precision,
      },
    });
  }, [precision, chartStyle]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || previousIntervalRef.current === activeInterval) return;
    const logicalRange = chart.timeScale().getVisibleLogicalRange();
    const previousData = previousDataRef.current;
    if (logicalRange && previousData.length > 0) {
      const focusIndex = Math.max(0, Math.min(previousData.length - 1, Math.floor(logicalRange.to)));
      preservedViewRef.current = {
        focusTime: previousData[focusIndex].time,
        visibleBars: Math.max(24, Math.round(logicalRange.to - logicalRange.from - rightOffsetBars + 1)),
      };
    }
    previousIntervalRef.current = activeInterval;
    previousDataRef.current = [];
    setHoveredCandle(null);
  }, [activeInterval, chartStyle]);

  useEffect(() => {
    const market = `${baseAsset}/${quoteAsset}`;
    if (previousMarketRef.current === market) return;
    previousMarketRef.current = market;
    previousDataRef.current = [];
    preservedViewRef.current = null;
    setHoveredCandle(null);
    seriesRef.current?.setData([]);
  }, [baseAsset, quoteAsset, chartStyle]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || data.length === 0) return;

    const previous = previousDataRef.current;
    if (chartStyle !== "heikin-ashi" && isSameHistory(previous, data)) {
      series.update(seriesPoint(data[data.length - 1], chartStyle));
    } else {
      let preservedView = preservedViewRef.current;
      if (!preservedView && previous.length > 0) {
        const logicalRange = chart.timeScale().getVisibleLogicalRange();
        if (logicalRange) {
          const focusIndex = Math.max(0, Math.min(previous.length - 1, Math.floor(logicalRange.to)));
          preservedView = {
            focusTime: previous[focusIndex].time,
            visibleBars: Math.max(24, Math.round(logicalRange.to - logicalRange.from - rightOffsetBars + 1)),
          };
        }
      }
      series.setData(seriesInput(data, chartStyle));
      if (preservedView) {
        let focusIndex = data.findIndex((candle) => candle.time >= preservedView.focusTime);
        if (focusIndex < 0) focusIndex = data.length - 1;
        const visibleBars = Math.min(preservedView.visibleBars, data.length);
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, focusIndex - visibleBars + 1),
          to: focusIndex + rightOffsetBars,
        });
        preservedViewRef.current = null;
      } else {
        chart.timeScale().setVisibleLogicalRange({
          // reserve right-side whitespace once, while keeping actual candles
          // flush with the chart's left edge.
          from: Math.max(0, data.length - initialVisibleBars - rightOffsetBars),
          to: data.length - 1 + rightOffsetBars,
        });
      }
    }
    previousDataRef.current = data;
  }, [data, chartStyle]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (!Number.isFinite(bboMidpoint) || bboMidpoint <= 0) {
      if (midpointLineRef.current) {
        series.removePriceLine(midpointLineRef.current);
        midpointLineRef.current = null;
      }
      return;
    }
    if (!midpointLineRef.current) {
      midpointLineRef.current = series.createPriceLine({
        price: bboMidpoint,
        color: "#2d5590",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "",
      });
      return;
    }
    midpointLineRef.current.applyOptions({ price: bboMidpoint });
  }, [bboMidpoint, chartStyle]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || data.length === 0) return;
    const high = Math.max(...data.map((candle) => candle.high));
    const low = Math.min(...data.map((candle) => candle.low));
    if (!highLineRef.current) {
      highLineRef.current = series.createPriceLine({ price: high, color: "rgba(110,130,158,.48)", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "H" });
      lowLineRef.current = series.createPriceLine({ price: low, color: "rgba(110,130,158,.48)", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "L" });
      return;
    }
    highLineRef.current.applyOptions({ price: high });
    lowLineRef.current?.applyOptions({ price: low });
  }, [data, chartStyle]);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === panelRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  async function toggleFullscreen() {
    if (!panelRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await panelRef.current.requestFullscreen();
  }

  return (
    <section ref={panelRef} className={`chart-panel ${fullscreen ? "chart-fullscreen" : ""}`} aria-label={`Binance ${baseAsset} ${quoteAsset} chart`}>
      <div className="chart-toolbar market-chart-toolbar">
        <div className="chart-context">
          <div className="chart-title-row"><strong>{baseAsset} / {quoteAsset}</strong><span>Spot market</span></div>
          <div className="chart-detail-row">
            {activeCandle && (
              <div className="ohlc-row" aria-label="Selected candle OHLC">
                <span>O <b>{activeCandle.open.toFixed(precision)}</b></span>
                <span>H <b>{activeCandle.high.toFixed(precision)}</b></span>
                <span>L <b>{activeCandle.low.toFixed(precision)}</b></span>
                <span>C <b>{activeCandle.close.toFixed(precision)}</b></span>
                <strong className={change >= 0 ? "positive" : "negative"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</strong>
              </div>
            )}
            <div className="chart-toolbar-actions">
              <div className="range-control" aria-label="Candle interval">
                {intervals.map((interval) => (
                  <button key={interval.value} className={interval.value === activeInterval ? "active" : ""} type="button" aria-label={interval.label} onClick={() => onIntervalChange(interval.value)}>{interval.label}</button>
                ))}
              </div>
              <span className="chart-control-divider" aria-hidden="true" />
              <div className="chart-style-control">
                <button className="chart-icon-button" type="button" aria-label="Chart type" aria-expanded={styleMenuOpen} aria-haspopup="menu" onClick={() => setStyleMenuOpen((open) => !open)}><ChartStyleIcon variant={chartStyle} className="icon-16" /></button>
                {styleMenuOpen && (
                  <div className="chart-style-menu" role="menu" aria-label="Chart type">
                    {chartStyles.map((style) => (
                      <button key={style.value} className={style.value === chartStyle ? "active" : ""} type="button" role="menuitemradio" aria-checked={style.value === chartStyle} data-divider-before={style.dividerBefore || undefined} onClick={() => { setChartStyle(style.value); setStyleMenuOpen(false); }}><ChartStyleIcon variant={style.value} className="chart-style-option-icon" /><span>{style.label}</span></button>
                    ))}
                  </div>
                )}
              </div>
              <span className="chart-control-divider" aria-hidden="true" />
              <button className="chart-icon-button" type="button" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen chart"} onClick={() => void toggleFullscreen()}><FullscreenIcon className="icon-16" /></button>
            </div>
          </div>
        </div>
      </div>

      <div className="chart-wrap candlestick-wrap">
        <div
          ref={containerRef}
          className="price-chart trading-chart"
          role="img"
          aria-label={`Binance ${baseAsset} ${quoteAsset} candlesticks${latestCandle ? `, latest close ${formatQuotedPrice(latestCandle.close, quoteAsset)}` : ""}`}
        />
        {loading && data.length === 0 && <div className="chart-empty chart-loading">Loading market history</div>}
        {!loading && data.length === 0 && <div className="chart-empty">Price data unavailable</div>}
      </div>

      <div className="chart-source-row">
        <span>Source</span><strong>Binance spot</strong><i/><span>Live Binance market data</span>
      </div>
    </section>
  );
}
