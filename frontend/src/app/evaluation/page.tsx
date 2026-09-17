"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Download, RotateCcw } from "lucide-react";
import { getEvaluation } from "@/lib/api";
import {
  type Evaluation,
  className,
  humanize,
  number,
  percent,
} from "@/lib/types";
import Shell, { PageTitle, Panel, ScopeNotice } from "../components/Shell";
const ReliabilityChart = dynamic(
  () => import("../components/Charts").then((m) => m.ReliabilityChart),
  {
    ssr: false,
    loading: () => <div className="chart loading">Loading chart…</div>,
  },
);

function EvaluationReport({ data: d }: { data: Evaluation }) {
  const maxImportance = Math.max(
    ...d.feature_importance.map((row) => Math.abs(row.importance)),
    0.0001,
  );
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "tradepersona-evaluation.json";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <ScopeNotice />
      <div className="evaluation-intro">
        <div>
          <span className="tag">
            Selected model · {humanize(d.selected_model)}
          </span>
          <h2>Untouched synthetic holdout</h2>
          <p>{d.methodology}</p>
        </div>
        <button className="button secondary" onClick={download}>
          <Download size={16} /> Export evaluation
        </button>
      </div>
      <div className="metric-grid">
        {[
          [
            "Macro F1",
            d.test.macro_f1,
            `95% bootstrap CI ${d.test.macro_f1_ci95.map((v) => number(v, 3)).join(" – ")}`,
          ],
          [
            "Balanced accuracy",
            d.test.balanced_accuracy,
            "Equal weight to each class",
          ],
          ["Weighted F1", d.test.weighted_f1, "Weighted by class support"],
          ["Accuracy", d.test.accuracy, "All held-out histories"],
        ].map(([label, value, description]) => (
          <div className="metric-card" key={String(label)}>
            <p>{label}</p>
            <strong>{number(Number(value), 3)}</strong>
            <span>{description}</span>
          </div>
        ))}
      </div>
      <p className="small muted">
        Macro F1 gives each behavioral class equal weight. These scores estimate
        performance on the simulator, not on real trading behavior.
      </p>
      <Panel
        title="The data behind the result"
        eyebrow="Provenance & independence"
      >
        <p>{d.dataset.origin}</p>
        <div className="split-grid">
          {Object.entries(d.dataset.split_counts).map(([key, value]) => (
            <div key={key}>
              <span>{humanize(key)}</span>
              <strong>{number(value, 0)}</strong>
            </div>
          ))}
        </div>
        <p className="small muted">
          Prediction unit: {d.dataset.unit} · Feature schema:{" "}
          {d.feature_version}
        </p>
        <details>
          <summary>Dataset fingerprint</summary>
          <code className="fingerprint">{d.dataset.fingerprint}</code>
        </details>
      </Panel>
      <Panel
        title="Did model complexity help?"
        eyebrow="Selection-validation comparison"
      >
        <p className="muted">
          All candidates are compared on the selection validation split. The
          selected model’s final test scores are shown separately above.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Macro F1</th>
                <th>Weighted F1</th>
                <th>Balanced accuracy</th>
                <th>Accuracy</th>
              </tr>
            </thead>
            <tbody>
              {d.models.map((model) => (
                <tr
                  key={model.name}
                  className={
                    model.name === d.selected_model ? "selected-row" : ""
                  }
                >
                  <th>
                    {humanize(model.name)}{" "}
                    {model.name === d.selected_model ? (
                      <span className="tag">Selected</span>
                    ) : null}
                  </th>
                  <td>{number(model.validation.macro_f1, 3)}</td>
                  <td>{number(model.validation.weighted_f1, 3)}</td>
                  <td>{number(model.validation.balanced_accuracy, 3)}</td>
                  <td>{number(model.validation.accuracy, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="two-column">
        <Panel
          title="Where the model gets confused"
          eyebrow="Test confusion matrix"
        >
          <p className="muted">
            Rows are actual classes. Columns are predicted classes. Counts are
            independent held-out histories.
          </p>
          <div className="table-scroll">
            <table className="confusion-table">
              <thead>
                <tr>
                  <th>Actual ↓ / Predicted →</th>
                  {d.dataset.classes.map((key) => (
                    <th key={key}>{className(key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.test.confusion_matrix.map((row, index) => (
                  <tr key={d.dataset.classes[index]}>
                    <th>{className(d.dataset.classes[index])}</th>
                    {row.map((value, col) => (
                      <td className={index === col ? "diagonal" : ""} key={col}>
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel
          title="Performance for each pattern"
          eyebrow="Test classification report"
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pattern</th>
                  <th>Precision</th>
                  <th>Recall</th>
                  <th>F1</th>
                  <th>Support</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(d.test.per_class).map(([key, row]) => (
                  <tr key={key}>
                    <th>{className(key)}</th>
                    <td>{number(row.precision, 3)}</td>
                    <td>{number(row.recall, 3)}</td>
                    <td>{number(row.f1, 3)}</td>
                    <td>{row.support}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
      <div className="two-column">
        <Panel title="Do probabilities match outcomes?" eyebrow="Calibration">
          <p className="muted">
            {d.calibration.method} · Temperature{" "}
            {number(d.calibration.temperature, 3)}. A point on the dashed
            diagonal has matching confidence and observed accuracy.
          </p>
          <ReliabilityChart calibration={d.calibration} />
          <div className="chart-legend">
            <span>
              <i style={{ background: "#ad9167" }} />
              Raw
            </span>
            <span>
              <i style={{ background: "#157b61" }} />
              Calibrated
            </span>
            <span>Horizontal: confidence · Vertical: accuracy</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Test metric ↓ better</th>
                  <th>Raw</th>
                  <th>Calibrated</th>
                </tr>
              </thead>
              <tbody>
                {(["brier", "ece", "log_loss"] as const).map((key) => (
                  <tr key={key}>
                    <th>{humanize(key)}</th>
                    <td>{number(d.calibration.raw[key], 4)}</td>
                    <td>{number(d.calibration.calibrated[key], 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Reliability bin counts and values</summary>
            {(["raw", "calibrated"] as const).map((kind) => (
              <div key={kind}>
                <h3>{humanize(kind)}</h3>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Bin</th>
                        <th>Count</th>
                        <th>Confidence</th>
                        <th>Accuracy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.calibration[kind].reliability.map((row) => (
                        <tr key={row.lower}>
                          <th>
                            {percent(row.lower, 0)}–{percent(row.upper, 0)}
                          </th>
                          <td>{row.count}</td>
                          <td>{row.count ? percent(row.confidence) : "—"}</td>
                          <td>{row.count ? percent(row.accuracy) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </details>
        </Panel>
        <Panel
          title="The cost of saying “not enough evidence”"
          eyebrow="Coverage & abstention"
        >
          <p className="muted">
            Coverage is the share receiving a classification. Each threshold
            also applies the fixed margin, data-quality, and distribution
            checks. Scores describe only retained histories.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Confidence threshold</th>
                  <th>Coverage</th>
                  <th>Accuracy</th>
                  <th>Macro F1</th>
                </tr>
              </thead>
              <tbody>
                {d.coverage.map((row) => (
                  <tr key={row.threshold}>
                    <th>{percent(row.threshold, 0)}</th>
                    <td>{percent(row.coverage)}</td>
                    <td>{percent(row.accuracy)}</td>
                    <td>{number(row.macro_f1, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Higher selective performance can come at the cost of excluding more
            histories. Abstention does not establish safety on real-world data.
          </p>
        </Panel>
      </div>
      <div className="two-column">
        <Panel
          title="What the model relies on"
          eyebrow="Permutation importance"
        >
          <p className="muted">
            Validation score decrease when each feature is shuffled. Correlated
            features can share importance; a negative value means shuffling
            improved the measured score.
          </p>
          <div className="importance-list">
            {d.feature_importance.map((row) => (
              <div key={row.feature}>
                <div className="bar-label">
                  <span>{humanize(row.feature)}</span>
                  <strong>{number(row.importance, 4)}</strong>
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{
                      width: `${(Math.abs(row.importance) / maxImportance) * 100}%`,
                      background: row.importance < 0 ? "#ad9167" : undefined,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel
          title="Beyond a single clean benchmark"
          eyebrow="Robustness & distribution shift"
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Perturbation</th>
                  <th>Label agreement</th>
                  <th>Mean probability change</th>
                  <th>Coverage</th>
                </tr>
              </thead>
              <tbody>
                {d.robustness.map((row) => (
                  <tr key={row.perturbation}>
                    <th>{humanize(row.perturbation)}</th>
                    <td>{percent(row.agreement)}</td>
                    <td>{number(row.mean_probability_change, 4)}</td>
                    <td>{percent(row.coverage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="shift-callout">
            <p className="eyebrow">Shifted synthetic histories</p>
            <div>
              <span>
                Macro F1 <strong>{number(d.shift.macro_f1, 3)}</strong>
              </span>
              <span>
                Accuracy <strong>{percent(d.shift.accuracy)}</strong>
              </span>
            </div>
            <p className="small muted">
              This stress test changes simulator conditions. It is not a
              substitute for independently labeled real trading histories.
            </p>
          </div>
        </Panel>
      </div>
      <Panel title="What this benchmark cannot tell us" eyebrow="Limitations">
        <ul className="notice-list">
          {d.limitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="small muted">Scope: {d.scope}</p>
      </Panel>
    </>
  );
}
export default function EvaluationPage() {
  const [data, setData] = useState<Evaluation | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getEvaluation(controller.signal)
      .then((value) => {
        setData(value);
        setError("");
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Evaluation could not be loaded.",
          );
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <Shell active="evaluation">
      <PageTitle
        eyebrow="Evidence, before claims"
        title="A model is only as good as its evaluation."
      >
        Explore the saved experiment: baselines, held-out performance,
        calibration, and the limits of this synthetic benchmark.
      </PageTitle>
      {error ? (
        <div className="empty-state panel">
          <h2>Evaluation is currently unavailable</h2>
          <p role="alert">{error}</p>
          <button
            className="button secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RotateCcw size={15} /> Retry
          </button>
        </div>
      ) : data ? (
        <EvaluationReport data={data} />
      ) : (
        <div className="panel loading" role="status">
          Loading the saved evaluation artifact…
        </div>
      )}
    </Shell>
  );
}
