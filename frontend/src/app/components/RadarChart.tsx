"use client";

import {
  Chart as ChartJS,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend
} from "chart.js";

import { Radar } from "react-chartjs-2";

ChartJS.register(
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend
);

type Props = {
  result: any;
  label?: string;
  color?: string;
};

export default function RadarChart({
  result,
  label = "Your trading profile",
  color = "54,162,235"
}: Props) {
  if (!result?.normalizedMetrics) return null;

  const m = result.normalizedMetrics;

  const data = {
    labels: [
      "Trade frequency",
      "Avg trade size",
      "Holding patience",
      "After-loss reactivity",
      "Size variability"
    ],
    datasets: [
      {
        label,
        data: [
          m.trade_frequency * 100,
          m.avg_trade_size * 100,
          m.holding_period == null ? 0 : m.holding_period * 100,
          m.after_loss == null ? 0 : m.after_loss * 100,
          m.size_variability * 100
        ],
        fill: true,
        backgroundColor: `rgba(${color}, 0.18)`,
        borderColor: `rgb(${color})`,
        borderWidth: 2,
        pointBackgroundColor: `rgb(${color})`,
        pointBorderColor: "#e2e8f0",
        pointHoverBackgroundColor: "#f8fafc",
      }
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      r: {
        min: 0,
        max: 100,

        ticks: {
          stepSize: 20,
          backdropColor: "transparent",
          color: "#cbd5e1"
        },

        pointLabels: {
          color: "#e2e8f0",
          font: {
            size: 12
          }
        },

        grid: {
          color: "rgba(148,163,184,0.2)"
        },

        angleLines: {
          color: "rgba(148,163,184,0.18)"
        }
      }
    },
    plugins: {
      legend: {
        labels: {
          color: "#e2e8f0"
        }
      }
    }
  };

  return (
    <div
      className="
        h-[260px]
        rounded-[1.25rem]
        bg-slate-950/35
        p-3
      "
    >
      <Radar
        data={data}
        options={options as any}
      />
    </div>
  );
}
