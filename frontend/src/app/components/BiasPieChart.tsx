"use client";

import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

const LABELS: Record<string, string> = {
  overtrader: "Overtrading",
  loss_aversion: "Loss aversion",
  revenge_trader: "Revenge trading",
  calm_trader: "Calm trading"
};

const COLORS: Record<string, string> = {
  overtrader: "#ef4444",
  loss_aversion: "#f59e0b",
  revenge_trader: "#8b5cf6",
  calm_trader: "#10b981"
};

type Props = {
  ratios: Record<string, number>;
  showSummary?: boolean;
};

export default function BiasPieChart({ ratios, showSummary = true }: Props) {
  const data = Object.keys(LABELS).map((key, index) => ({
    id: index,
    label: LABELS[key],
    value: Number(ratios?.[key] ?? 0),
    color: COLORS[key]
  }));
  const total = data.reduce((sum, item) => sum + item.value, 0);

  const top = data.reduce(
    (acc, item) => (item.value > acc.value ? item : acc),
    data[0]
  );

  return (
    <div className="w-full text-slate-200">
      <div className="h-[240px] w-full">
        {total > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="label"
                innerRadius={52}
                outerRadius={84}
                paddingAngle={3}
                strokeWidth={0}
              >
                {data.map((item) => (
                  <Cell key={item.id} fill={item.color} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value) => `${Number(value ?? 0).toFixed(1)}%`}
                contentStyle={{
                  borderRadius: "12px",
                  border: "1px solid rgba(148, 163, 184, 0.25)",
                  backgroundColor: "#020617",
                  color: "#e2e8f0",
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-white/15 text-sm text-slate-400">
            Upload trades to generate bias ratios.
          </div>
        )}
      </div>

      {showSummary && (
        <div className="mt-3 text-sm text-slate-300">
          <span className="font-semibold text-slate-100">
            Highest bias:
          </span>{" "}
          {top.label} ({top.value.toFixed(1)}%)
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300">
        {data.map((item) => (
          <div key={item.id} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span>
              {item.label}: {item.value.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
