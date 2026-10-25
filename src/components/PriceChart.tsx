"use client";

import { useEffect, useRef } from "react";

interface Props {
  bundle: any;
  height?: number;
  showEma?: boolean;
  showVwap?: boolean;
  showZones?: boolean;
  showEvents?: boolean;
  showScenario?: boolean;
  /** §7 show raw structural labels (SWING HIGH, EQUAL_LOWS, …). OFF by default. */
  showAdvancedLabels?: boolean;
  /** §7 show additional secondary/historical zones beyond R1/R2/S1/S2 */
  showAllLevels?: boolean;
}

const IST_SHIFT = 19800; // seconds — for IST wall-clock display on the time axis
const t = (ms: number) => Math.floor(ms / 1000) + IST_SHIFT;

export default function PriceChart({ bundle, height = 420, showEma = true, showVwap = true, showZones = true, showEvents = true, showScenario = true, showAdvancedLabels = false, showAllLevels = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const apiRef = useRef<any>({});
  const symbolTfRef = useRef<string>("");

  const key = `${bundle?.symbol}|${bundle?.tf}`;

  // create chart once per symbol/tf
  useEffect(() => {
    let disposed = false;
    (async () => {
      const L = await import("lightweight-charts");
      if (disposed || !hostRef.current) return;
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
      const chart = L.createChart(hostRef.current, {
        height,
        layout: {
          background: { type: L.ColorType.Solid, color: "transparent" },
          textColor: "#8b96a5",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
        },
        grid: { vertLines: { color: "rgba(26,33,44,0.55)" }, horzLines: { color: "rgba(26,33,44,0.55)" } },
        crosshair: { mode: L.CrosshairMode.Normal, vertLine: { color: "#38445a", labelBackgroundColor: "#1c2531" }, horzLine: { color: "#38445a", labelBackgroundColor: "#1c2531" } },
        rightPriceScale: { borderColor: "#1a212c" },
        timeScale: { borderColor: "#1a212c", timeVisible: true, secondsVisible: false, rightOffset: 6 },
        localization: { priceFormatter: (v: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(v) },
      });
      const candles = chart.addCandlestickSeries({
        upColor: "#17c784", downColor: "#ea3943",
        wickUpColor: "#17c784", wickDownColor: "#ea3943",
        borderVisible: false,
      });
      const volume = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", color: "#2a3442" });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      candles.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.2 } });
      const mk = (color: string, width: 1 | 2, dashed: boolean, title?: string) =>
        chart.addLineSeries({ color, lineWidth: width, lineStyle: dashed ? L.LineStyle.Dashed : L.LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title });
      apiRef.current = {
        candles, volume,
        ema9: mk("#5aa2ff", 1, false, "EMA9"),
        ema21: mk("#f0b90b", 1, false, "EMA21"),
        ema50: mk("#a371f7", 1, false, "EMA50"),
        ema200: mk("#4b5563", 2, false, "EMA200"),
        vwap: mk("#3fd3d3", 1, true, "VWAP"),
      };
      chartRef.current = chart;
      symbolTfRef.current = key;
      (window as any).__lc = L;

      const ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width;
        if (w && chartRef.current) chartRef.current.applyOptions({ width: Math.floor(w) });
      });
      ro.observe(hostRef.current);
      (chartRef.current as any).__ro = ro;
    })();
    return () => {
      disposed = true;
      const ro = (chartRef.current as any)?.__ro as ResizeObserver | undefined;
      ro?.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      apiRef.current = {};
    };
  }, [key, height]);

  // push data
  useEffect(() => {
    const chart = chartRef.current;
    const api = apiRef.current;
    if (!chart || !api.candles || !bundle?.candles?.length) return;
    const L = (window as any).__lc;

    const cs = bundle.candles as any[];
    api.candles.setData(cs.map((c) => ({ time: t(c.ts) as any, open: c.open, high: c.high, low: c.low, close: c.close })));
    api.volume.setData(cs.map((c) => ({ time: t(c.ts) as any, value: c.volume, color: c.close >= c.open ? "rgba(23,199,132,0.45)" : "rgba(234,57,67,0.45)" })));

    const lineData = (arr: (number | null)[]) =>
      cs.map((c, i) => (arr[i] != null ? { time: t(c.ts) as any, value: arr[i] as number } : null)).filter(Boolean) as any[];
    api.ema9.setData(showEma ? lineData(bundle.indicators.ema9) : []);
    api.ema21.setData(showEma ? lineData(bundle.indicators.ema21) : []);
    api.ema50.setData(showEma ? lineData(bundle.indicators.ema50) : []);
    api.ema200.setData(showEma ? lineData(bundle.indicators.ema200) : []);
    api.vwap.setData(showVwap ? lineData(bundle.indicators.vwap) : []);

    /**
     * §7 UNIFIED RENDERING — consumes bundle.srEngine.levels (R1/R2/S1/S2)
     * and bundle.srEngine.zones. There is NO second frontend ranking
     * algorithm; the chart draws exactly what the engine selected.
     */
    (api.candles as any).__lines?.forEach((pl: any) => api.candles.removePriceLine(pl));
    const lines: any[] = [];
    if (showZones && L) {
      const sr = (bundle as any).srEngine;
      const levels = sr?.scenario?.levels;
      const allZones: any[] = sr?.zones ?? [];

      // --- the four dynamic levels -------------------------------------
      const four = [
        { key: "R1", sel: levels?.R1, tone: "#ea3943", strong: true },
        { key: "R2", sel: levels?.R2, tone: "#ea3943", strong: false },
        { key: "S1", sel: levels?.S1, tone: "#17c784", strong: true },
        { key: "S2", sel: levels?.S2, tone: "#17c784", strong: false },
      ] as const;

      for (const { key, sel, tone, strong } of four) {
        if (!sel?.zone) continue;
        const z = sel.zone;
        const width = strong ? 2 : 1;
        const style = L.LineStyle.Solid;
        const label = strong
          ? `${key} · ${key.startsWith("R") ? "PRIMARY RESISTANCE" : "PRIMARY SUPPORT"}`
          : `${key} · ${key.startsWith("R") ? "SECONDARY RESISTANCE" : "SECONDARY SUPPORT"}`;
        lines.push(api.candles.createPriceLine({
          price: z.top, color: tone, lineWidth: width, lineStyle: style,
          axisLabelVisible: strong, title: label,
        }));
        if (Math.abs(z.top - z.bottom) > (bundle.last?.atr ?? 0) * 0.04) {
          lines.push(api.candles.createPriceLine({
            price: z.bottom, color: tone, lineWidth: width, lineStyle: style,
            axisLabelVisible: false, title: "",
          }));
        }
      }

      // --- interaction zone (price currently inside) -------------------
      if (levels?.interactionZone) {
        const iz = levels.interactionZone;
        lines.push(api.candles.createPriceLine({
          price: iz.mid, color: "#f0b90b", lineWidth: 1,
          lineStyle: L.LineStyle.Dotted, axisLabelVisible: false,
          title: "INSIDE ZONE",
        }));
      }

      // --- optional: all other valid zones ----------------------------
      if (showAllLevels) {
        const chosen = new Set<string>([levels?.R1?.zone?.id, levels?.R2?.zone?.id, levels?.S1?.zone?.id, levels?.S2?.zone?.id].filter(Boolean));
        for (const z of allZones.filter((x: any) => !chosen.has(x.id)).slice(0, 8)) {
          const tone = z.currentRole === "resistance" ? "#ea3943" : "#17c784";
          const broken = z.machineState === "CONFIRMED_BREAKOUT" || z.machineState === "CONFIRMED_BREAKDOWN"
            || z.machineState === "FAILED_BREAKOUT" || z.machineState === "FAILED_BREAKDOWN";
          lines.push(api.candles.createPriceLine({
            price: z.top, color: tone, lineWidth: 1,
            lineStyle: L.LineStyle[broken ? "Dashed" : "Dotted"],
            axisLabelVisible: false, title: showAdvancedLabels ? z.type : "",
          }));
        }
      }

      // --- optional: raw structural labels (OFF by default) -----------
      if (showAdvancedLabels) {
        for (const z of (bundle.zones ?? []).filter((x: any) => x.status !== "INVALIDATED").slice(0, 9)) {
          const tone = z.type === "POC" ? "#a371f7"
            : z.type === "VAH" || z.type === "VAL" ? "#8b6fd0"
            : z.type === "PDH" || z.type === "PDL" || z.type === "PWH" || z.type === "PWL" ? "#f0b90b"
            : z.type === "ORH" || z.type === "ORL" || z.type === "SESSION_HIGH" || z.type === "SESSION_LOW" ? "#5aa2ff"
            : z.type === "VWAP" || z.type === "VWAP_UPPER" || z.type === "VWAP_LOWER" ? "#3fd3d3"
            : z.side === "resistance" ? "#ea3943" : "#17c784";
          lines.push(api.candles.createPriceLine({
            price: z.mid, color: tone, lineWidth: 1,
            lineStyle: L.LineStyle[z.status === "BROKEN" || z.status === "RECLAIMED" || z.status === "POTENTIALLY_SWEPT" ? "Dashed" : "Solid"],
            axisLabelVisible: false,
            title: `${z.type} ${z.strength}`,
          }));
        }
      }

      // --- scenario markers -------------------------------------------
      const sc = sr?.scenario;
      if (sc?.nextTarget?.level != null) {
        lines.push(api.candles.createPriceLine({ price: sc.nextTarget.level, color: "#f0b90b", lineWidth: 1, lineStyle: L.LineStyle.LargeDashed, axisLabelVisible: true, title: "TARGET" }));
      }
      if (sc?.invalidationLevel?.level != null) {
        lines.push(api.candles.createPriceLine({ price: sc.invalidationLevel.level, color: "#ea3943", lineWidth: 2, lineStyle: L.LineStyle.Dashed, axisLabelVisible: true, title: "INVALIDATION" }));
      }
      if (sc?.continuationTrigger?.level != null) {
        lines.push(api.candles.createPriceLine({ price: sc.continuationTrigger.level, color: "#5aa2ff", lineWidth: 1, lineStyle: L.LineStyle.Solid, axisLabelVisible: false, title: "TRIGGER" }));
      }
    }

    if (showScenario && L && bundle.scenario && bundle.scenario.status !== "NO_TRADE") {
      const s = bundle.scenario;
      if (s.entryZone) for (const p of s.entryZone) lines.push(api.candles.createPriceLine({ price: p, color: "#5aa2ff", lineWidth: 1, lineStyle: L.LineStyle.Solid, title: "ENTRY" }));
      if (s.stop) lines.push(api.candles.createPriceLine({ price: s.stop, color: "#ea3943", lineWidth: 2, lineStyle: L.LineStyle.Solid, title: "SL" }));
      if (s.t1) lines.push(api.candles.createPriceLine({ price: s.t1, color: "#17c784", lineWidth: 1, lineStyle: L.LineStyle.Dashed, title: "T1" }));
      if (s.t2) lines.push(api.candles.createPriceLine({ price: s.t2, color: "#17c784", lineWidth: 1, lineStyle: L.LineStyle.Dotted, title: "T2" }));
    }
    (api.candles as any).__lines = lines;

    // markers
    if (showEvents && bundle.events?.length) {
      const markers = (bundle.events as any[])
        .map((e) => ({
          time: t(e.ts) as any,
          position: e.kind === "SWEEP" ? "aboveBar" : e.kind === "BOS" || e.kind === "CHOCH" ? "belowBar" : "aboveBar",
          color: e.kind === "SWEEP" ? "#f0b90b" : e.kind === "CHOCH" ? "#a371f7" : e.kind === "BOS" ? "#5aa2ff" : "#55606f",
          shape: e.kind === "SWEEP" ? "arrowDown" : e.kind === "BOS" || e.kind === "CHOCH" ? "arrowUp" : "circle",
          text: e.kind,
          size: 0,
        }))
        .sort((a, b) => (a.time as number) - (b.time as number));
      api.candles.setMarkers(markers as any);
    } else {
      api.candles.setMarkers([]);
    }

    // keep the visible window stable around the right edge
    chart.timeScale().scrollToRealTime();
  }, [bundle, showEma, showVwap, showZones, showEvents, showScenario, showAdvancedLabels, showAllLevels]);

  return <div ref={hostRef} style={{ height }} className="w-full [&_a]:hidden" />;
}
