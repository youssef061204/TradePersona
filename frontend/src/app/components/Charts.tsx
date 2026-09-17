"use client";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type Analysis,
  type Evaluation,
  className,
  date,
  percent,
} from "@/lib/types";
const colors = ["#157b61", "#bd7832", "#6e68bd", "#3f83b0"];
const tooltipStyle = {
  border: "1px solid #dce5df",
  borderRadius: 10,
  fontSize: 12,
};
export function TrendChart({ trends }: { trends: Analysis["trends"] }) {
  const keys = ["calm_trader", "loss_aversion", "overtrader", "revenge_trader"];
  const rows = trends.map((row, index) => ({
    window: index + 1,
    range: date(row.start) + " – " + date(row.end),
    ...row.prediction.probabilities,
  }));
  return (
    <>
      <div
        className="chart"
        role="img"
        aria-label="Experimental class probabilities across trading windows; exact values are in the window details below"
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={280}
          initialDimension={{ width: 720, height: 280 }}
        >
          <LineChart
            data={rows}
            margin={{ top: 10, right: 15, left: -20, bottom: 5 }}
          >
            <CartesianGrid vertical={false} stroke="#e6ebe7" />
            <XAxis
              dataKey="window"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12 }}
            />
            <YAxis
              domain={[0, 1]}
              tickFormatter={(v) => percent(v, 0)}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11 }}
            />
            <Tooltip
              formatter={(v) => percent(Number(v))}
              labelFormatter={(v) => `Window ${v}`}
              contentStyle={tooltipStyle}
            />
            {keys.map((key, i) => (
              <Line
                key={key}
                type="linear"
                dataKey={key}
                name={className(key)}
                stroke={colors[i]}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-legend">
        {keys.map((key, i) => (
          <span key={key}>
            <i style={{ background: colors[i] }} />
            {className(key)}
          </span>
        ))}
      </div>
    </>
  );
}
export function AlignmentChart({
  alignment,
}: {
  alignment: Analysis["alignment"];
}) {
  const rows = alignment.dimensions.filter((row) => row.value != null);
  if (!rows.length)
    return <p className="muted">No comparison evidence available.</p>;
  return (
    <div className="probability-list">
      {rows.map((row) => {
        const maximum = Math.max(row.value ?? 0, row.target) * 1.15;
        return (
          <div key={row.dimension}>
            <div className="bar-label">
              <span>{row.dimension}</span>
              <strong>{row.value?.toFixed(2)}×</strong>
            </div>
            <div className="bar-track" style={{ position: "relative" }}>
              <div
                className="bar-fill"
                style={{ width: `${((row.value ?? 0) / maximum) * 100}%` }}
              />
              <span
                title={`Reference: ${row.target}×`}
                style={{
                  position: "absolute",
                  left: `${(row.target / maximum) * 100}%`,
                  top: 0,
                  height: "100%",
                  borderLeft: "2px solid #544a35",
                }}
              />
            </div>
            <p className="small muted">
              Marker: equal-behavior reference ({row.target}×)
            </p>
          </div>
        );
      })}
    </div>
  );
}
export function ReliabilityChart({
  calibration,
}: {
  calibration: Evaluation["calibration"];
}) {
  return (
    <div
      className="chart"
      role="img"
      aria-label="Reliability diagram comparing confidence with observed accuracy on the synthetic test set"
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        minHeight={280}
        initialDimension={{ width: 720, height: 280 }}
      >
        <ScatterChart margin={{ top: 10, right: 15, left: -15, bottom: 15 }}>
          <CartesianGrid stroke="#e6ebe7" />
          <XAxis
            type="number"
            dataKey="confidence"
            domain={[0, 1]}
            name="Confidence"
            tickFormatter={(v) => percent(v, 0)}
            tick={{ fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="accuracy"
            domain={[0, 1]}
            name="Accuracy"
            tickFormatter={(v) => percent(v, 0)}
            tick={{ fontSize: 11 }}
          />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ]}
            stroke="#9b9381"
            strokeDasharray="5 5"
          />
          <Scatter
            name="Raw"
            data={calibration.raw.reliability.filter((row) => row.count > 0)}
            fill="#ad9167"
            line
            isAnimationActive={false}
          />
          <Scatter
            name="Calibrated"
            data={calibration.calibrated.reliability.filter(
              (row) => row.count > 0,
            )}
            fill="#157b61"
            line
            isAnimationActive={false}
          />
          <Tooltip
            formatter={(v) => percent(Number(v))}
            contentStyle={tooltipStyle}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
