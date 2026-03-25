"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
} from "recharts";
import { motion } from "motion/react";
import { AlertTriangle, TrendingDown } from "lucide-react";
import { apiUrl } from "@/lib/api";

interface TradePoint {
  ts: string;
  value: number;
  asset?: string | null;
  side?: string | null;
}

interface ChartsPayload {
  timeline?: TradePoint[];
  cumulativeLabel?: string;
  timelineLabel?: string;
  hasPL?: boolean;
}

type TimelinePoint = {
  iso: string;
  dateLabel: string;
  cumulative: number;
  tradeValue: number;
  asset?: string | null;
  side?: string | null;
};

type Props = {
  sessionId?: string | null;
  className?: string;
};

const formatCurrency = (value: number) =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

export default function PortfolioTimeline({ sessionId, className }: Props) {
  const [timeline, setTimeline] = useState<TradePoint[]>([]);
  const [labels, setLabels] = useState({ cumulative: "Cumulative", timeline: "Trade" });
  const [hasPL, setHasPL] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBaseline, setShowBaseline] = useState(true);
  const [hoverPoint, setHoverPoint] = useState<TimelinePoint | null>(null);

  useEffect(() => {
    const sid = sessionId || (typeof window !== "undefined" ? localStorage.getItem("sessionId") : null);
    if (!sid) {
      setError("Upload trades to see your timeline.");
      return;
    }

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(apiUrl(`/analyze/${sid}`));
        const body: { charts?: ChartsPayload; error?: string } = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || "Failed to load timeline data");

        const charts = body.charts;
        if (!charts?.timeline || !charts.timeline.length) throw new Error("No timeline returned for this session");

        let timelineData = charts.timeline;
        const maxPoints = 1200;
        if (Array.isArray(timelineData) && timelineData.length > maxPoints) {
          const step = Math.ceil(timelineData.length / maxPoints);
          timelineData = timelineData.filter((_, idx) => idx % step === 0);
        }

        setTimeline(timelineData);
        setLabels({
          cumulative: charts.cumulativeLabel || "Cumulative",
          timeline: charts.timelineLabel || "Trade",
        });
        setHasPL(Boolean(charts.hasPL));
      } catch (err: any) {
        setError(err?.message || "Unable to load timeline");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [sessionId]);

  const points: TimelinePoint[] = useMemo(() => {
    if (!Array.isArray(timeline) || !timeline.length) return [];

    let cumulative = 0;
    return timeline
      .filter((t) => t && t.ts && Number.isFinite(new Date(t.ts).valueOf()))
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
      .map((t) => {
        const tradeValueRaw = Number(t.value);
        const tradeValue = Number.isFinite(tradeValueRaw) ? tradeValueRaw : 0;
        cumulative = Number.isFinite(cumulative + tradeValue) ? cumulative + tradeValue : cumulative;
        const dt = new Date(t.ts);
        const dateLabel = dt.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        return {
          iso: dt.toISOString(),
          dateLabel,
          cumulative: Number.isFinite(cumulative) ? Number(cumulative.toFixed(2)) : 0,
          tradeValue,
          asset: t.asset,
          side: t.side?.toUpperCase() ?? null,
        } as TimelinePoint;
      });
  }, [timeline]);

  const baselineData = useMemo(() => {
    if (!points.length) return [];
    const start = points[0].cumulative;
    const end = points[points.length - 1].cumulative;
    const span = Math.max(points.length - 1, 1);
    return points.map((p, idx) => ({
      ...p,
      baseline: start + ((end - start) * idx) / span,
    }));
  }, [points]);

  // Determine bias trades (top 5 losses) and label type heuristically
  const biasMeta = useMemo(() => {
    const map = new Map<string, { type: string }>();
    if (!points.length) return map;
    const lossPoints = [...points].filter((p) => p.tradeValue < 0);
    const worst = lossPoints.sort((a, b) => a.tradeValue - b.tradeValue).slice(0, 5);
    worst.forEach((p) => {
      const i = points.findIndex((x) => x.iso === p.iso);
      const prev = i > 0 ? points[i - 1] : null;
      const prevIsLoss = prev && prev.tradeValue < 0;
      const minutesGap = prev
        ? Math.abs((new Date(p.iso).getTime() - new Date(prev.iso).getTime()) / 60000)
        : Infinity;
      let type = "High-stress trade";
      if (p.side === "SELL" && p.tradeValue < 0) type = "Panic sell";
      if (prevIsLoss && minutesGap <= 15 && p.tradeValue < 0) type = "Revenge trade";
      if (p.side === "BUY" && p.tradeValue < 0) type = "FOMO buy";
      map.set(p.iso, { type });
    });
    return map;
  }, [points]);

  const emotionalTrades = useMemo(() => new Set(biasMeta.keys()), [biasMeta]);

  const emotionalImpact = useMemo(
    () =>
      points
        .filter((p) => emotionalTrades.has(p.iso))
        .reduce((sum, p) => sum + p.tradeValue, 0),
    [points, emotionalTrades]
  );

  // keep at most top 3 buys and top 3 sells as markers
  const buyMarkerSet = useMemo(() => {
    const buys = points
      .filter((p) => p.side === "BUY")
      .sort((a, b) => Math.abs(b.tradeValue) - Math.abs(a.tradeValue))
      .slice(0, 3)
      .map((p) => p.iso);
    return new Set(buys);
  }, [points]);

  const sellMarkerSet = useMemo(() => {
    const sells = points
      .filter((p) => p.side === "SELL")
      .sort((a, b) => Math.abs(b.tradeValue) - Math.abs(a.tradeValue))
      .slice(0, 3)
      .map((p) => p.iso);
    return new Set(sells);
  }, [points]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null;
    const data: TimelinePoint = payload[0].payload;
    const biasType = biasMeta.get(data.iso)?.type;

    return (
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 shadow-xl text-sm">
        <p className="text-slate-400 text-xs mb-1">
          {new Date(data.iso).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
        <p className="text-blue-400 font-semibold text-base">{formatCurrency(data.cumulative)}</p>
        <p className="text-slate-400 text-xs mt-1">
          Trade: {data.tradeValue >= 0 ? "+" : ""}
          {data.tradeValue.toFixed(2)}
          {data.asset ? ` - ${data.asset}` : ""}
          {data.side ? ` - ${data.side}` : ""}
        </p>
        {biasType && (
          <p className="text-rose-400 text-xs mt-1 font-semibold">Bias: {biasType}</p>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-800 p-6 text-slate-400">
        Loading timeline...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4 text-rose-100">
        {error}
      </div>
    );
  }

  if (!points.length) {
    return (
      <div className="rounded-2xl border border-slate-800 p-6 text-slate-400">
        No timeline data yet.
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={`bg-gradient-to-br from-slate-900 to-slate-800 rounded-2xl p-6 border border-slate-700/50 ${className ?? ""}`}
    >
      <div className="flex items-start justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold text-white">Portfolio Replay</h3>
          <p className="text-slate-400 text-sm">
            {labels.cumulative} based on your uploaded trades{hasPL ? " (P/L)" : " (trade value)"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowBaseline((v) => !v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              showBaseline ? "bg-slate-700 text-white" : "bg-slate-800 text-slate-500 hover:text-slate-300"
            }`}
          >
            Trend line
          </button>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-rose-400/40 bg-rose-500/10 text-rose-200 text-xs font-medium">
            <AlertTriangle className="w-4 h-4" />
            {biasMeta.size} bias trades
          </div>
        </div>
      </div>

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={baselineData}
            margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            onMouseMove={(state: any) => {
              const pt = state?.activePayload?.[0]?.payload;
              setHoverPoint(pt ?? null);
            }}
            onMouseLeave={() => setHoverPoint(null)}
          >
            <defs>
              <linearGradient id="portfolioGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="baselineGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#94A3B8" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#94A3B8" stopOpacity={0} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} />
            <XAxis
              dataKey="dateLabel"
              axisLine={false}
              tickLine={false}
              minTickGap={20}
              tick={{ fill: "#94A3B8", fontSize: 11 }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#94A3B8", fontSize: 11 }}
              tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
              domain={["dataMin - 500", "dataMax + 500"]}
            />
            <Tooltip
              content={<CustomTooltip />}
              wrapperStyle={{ outline: "none" }}
              cursor={{ stroke: "#38bdf8", strokeDasharray: "3 3" }}
            />

            {showBaseline && (
              <Area
                type="monotone"
                dataKey="baseline"
                stroke="#94A3B8"
                strokeWidth={1.5}
                strokeDasharray="5 5"
                fill="url(#baselineGradient)"
              />
            )}

            <Area
              type="monotone"
              dataKey="cumulative"
              stroke="#3B82F6"
              strokeWidth={2}
              fill="url(#portfolioGradient)"
              activeDot={{ r: 6, stroke: "#1E293B", strokeWidth: 2 }}
            />

            {baselineData.map((entry) => {
              const key = entry.iso;
              const isBias = biasMeta.has(entry.iso);
              const biasType = biasMeta.get(entry.iso)?.type;
              const isBuy = buyMarkerSet.has(entry.iso);
              const isSell = sellMarkerSet.has(entry.iso);
              if (!isBias && !isBuy && !isSell) return null;
              const color = isBias ? "#F43F5E" : isBuy ? "#10B981" : "#F59E0B";
              const radius = isBias ? 9 : 5;
              return (
                <ReferenceDot
                  key={key}
                  x={entry.dateLabel}
                  y={entry.cumulative}
                  r={radius}
                  fill={color}
                  stroke="#0f172a"
                  strokeWidth={3}
                  label={isBias ? { value: biasType, position: "top", fill: "#f43f5e", fontSize: 10 } : undefined}
                />
              );
            })}

            {hoverPoint && (
              <ReferenceDot
                x={hoverPoint.dateLabel}
                y={hoverPoint.cumulative}
                r={7}
                fill="#38bdf8"
                stroke="#0f172a"
                strokeWidth={2}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-800">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 text-emerald-200 text-xs">
            <div className="w-3 h-3 rounded-full bg-emerald-500" />
            <span>Buy</span>
          </div>
          <div className="flex items-center gap-2 text-amber-200 text-xs">
            <div className="w-3 h-3 rounded-full bg-amber-500" />
            <span>Sell</span>
          </div>
          <div className="flex items-center gap-2 text-rose-200 text-xs">
            <div className="w-3 h-3 rounded-full bg-rose-500" />
            <span>Bias trade</span>
          </div>
        </div>
        <div className="text-right text-xs text-rose-200">
          <p className="text-slate-400">Cumulative impact</p>
          <p className="text-rose-300 font-semibold flex items-center justify-end gap-1">
            <TrendingDown className="w-4 h-4" />
            {emotionalImpact >= 0
              ? `+$${formatCurrency(emotionalImpact)}`
              : `-$${formatCurrency(Math.abs(emotionalImpact))}`}
          </p>
        </div>
      </div>

      <div className="mt-3 text-xs text-slate-300">
        {hoverPoint ? (
          <span>
            {new Date(hoverPoint.iso).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
            {" - "}
            {hoverPoint.tradeValue >= 0 ? "+" : ""}
            {hoverPoint.tradeValue.toFixed(2)} {hoverPoint.asset ? ` - ${hoverPoint.asset}` : ""}
            {biasMeta.has(hoverPoint.iso) ? (
              <span className="text-rose-400"> - {biasMeta.get(hoverPoint.iso)?.type}</span>
            ) : null}
          </span>
        ) : (
          <span>Hover over the chart to inspect trades</span>
        )}
      </div>
    </motion.div>
  );
}
