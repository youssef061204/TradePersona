"use client";
import dynamic from "next/dynamic";
import {
  type Analysis,
  className,
  date,
  humanize,
  number,
  percent,
} from "@/lib/types";
import { Panel, ScopeNotice } from "./Shell";
const TrendChart = dynamic(() => import("./Charts").then((m) => m.TrendChart), {
  ssr: false,
  loading: () => <div className="chart loading">Loading chart…</div>,
});
const AlignmentChart = dynamic(
  () => import("./Charts").then((m) => m.AlignmentChart),
  {
    ssr: false,
    loading: () => <div className="chart loading">Loading chart…</div>,
  },
);

export default function AnalysisReport({
  analysis: a,
}: {
  analysis: Analysis;
}) {
  const p = a.prediction;
  const probabilities = Object.entries(p.probabilities).sort(
    (x, y) => y[1] - x[1],
  );
  return (
    <>
      <ScopeNotice />
      <div className="report-top-grid">
        <section
          className={`prediction-card ${p.status !== "classified" ? "abstained" : ""}`}
        >
          <p className="eyebrow">Experimental model result</p>
          <span className="tag">
            {p.status === "classified"
              ? "Pattern identified"
              : p.status === "unavailable"
                ? "Model unavailable"
                : "Classification withheld"}
          </span>
          <h2>
            {p.status === "classified"
              ? className(p.label)
              : "Insufficient evidence for a confident classification."}
          </h2>
          <p>
            {p.status === "classified"
              ? "The closest learned pattern in this synthetic benchmark. Review the measured evidence before drawing conclusions."
              : "Available measurements remain useful. A class label is withheld when the history does not meet the model’s evidence requirements."}
          </p>
          {p.reasons.length ? (
            <ul className="reason-list">
              {p.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <div className="prediction-meta">
            <span>
              Top probability <strong>{percent(p.confidence)}</strong>
            </span>
            <span>
              Top-two margin <strong>{percent(p.margin)}</strong>
            </span>
          </div>
        </section>
        <Panel title="Experimental probabilities" eyebrow="Model output">
          <p className="muted">
            Relative probabilities across the four synthetic classes, not a
            percentage of your personality.
          </p>
          {probabilities.length ? (
            <div className="probability-list">
              {probabilities.map(([key, value], index) => (
                <div key={key}>
                  <div className="bar-label">
                    <span>{className(key)}</span>
                    <strong>{percent(value)}</strong>
                  </div>
                  <div className="bar-track">
                    <div
                      className={`bar-fill color-${index}`}
                      style={{
                        width: `${Math.max(0, Math.min(1, value)) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-inline">
              Probabilities are unavailable for this input.
            </div>
          )}
          <p className="small muted">
            Calibration: {p.calibration}. Version: {p.model_version}.
          </p>
        </Panel>
      </div>
      <Panel title="A transparent view of your data" eyebrow="Data quality">
        <div className="quality-grid">
          {[
            ["Rows received", a.quality.total_rows],
            ["Usable trades", a.quality.usable_rows],
            ["Malformed rows", a.quality.malformed_rows],
            ["Duplicate rows", a.quality.duplicate_rows],
          ].map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{number(Number(value), 0)}</strong>
            </div>
          ))}
        </div>
        <p className="small muted">
          {a.quality.date_range.start && a.quality.date_range.end
            ? `${date(a.quality.date_range.start)} – ${date(a.quality.date_range.end)} · UTC completion times`
            : "No valid date range available."}
        </p>
        {a.quality.missing_fields.length ? (
          <p className="warning-text">
            Missing fields: {a.quality.missing_fields.join(", ")}
          </p>
        ) : null}
        {a.quality.warnings.length ? (
          <ul className="notice-list">
            {a.quality.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No data-quality warnings reported.</p>
        )}
      </Panel>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Measured behavior</p>
          <h2>The evidence behind the pattern</h2>
        </div>
        <span className="tag">Deterministic features</span>
      </div>
      <div className="evidence-grid">
        {a.evidence.map((item) => (
          <div className="evidence-card" key={item.feature}>
            <p>{item.label}</p>
            <strong>
              {number(item.value)}{" "}
              <small>{item.value == null ? "" : item.unit}</small>
            </strong>
          </div>
        ))}
      </div>
      <div className="two-column">
        <Panel title="What moves the model" eyebrow="Local explanation">
          <p className="muted">{a.explanation_method}</p>
          {a.explanations.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th>Observed</th>
                    <th>Reference</th>
                    <th>Probability effect</th>
                  </tr>
                </thead>
                <tbody>
                  {a.explanations.map((item) => (
                    <tr key={item.feature}>
                      <th>{humanize(item.feature)}</th>
                      <td>{number(item.value)}</td>
                      <td>{number(item.reference)}</td>
                      <td
                        className={
                          item.probability_delta >= 0 ? "positive" : "muted"
                        }
                      >
                        {item.probability_delta > 0 ? "+" : ""}
                        {number(item.probability_delta * 100)} pp
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-inline">
              No model explanation is available for this input.
            </div>
          )}
          <p className="small muted">
            A model sensitivity explanation, not evidence of causation. Effects
            need not add up to the prediction.
          </p>
        </Panel>
        <Panel
          title="What if the history changed?"
          eyebrow="Counterfactual scenarios"
        >
          <p className="muted">
            Simulated edits to the trade history, followed by recomputation of
            all features. These are model experiments, not predicted financial
            outcomes.
          </p>
          {a.counterfactuals.length ? (
            a.counterfactuals.map((item, index) => (
              <div className="counterfactual" key={`${item.title}-${index}`}>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
                <div className="counterfactual-values">
                  <span>{className(item.label)}</span>
                  <strong>
                    {percent(item.original_probability)} <span>→</span>{" "}
                    {percent(item.counterfactual_probability)}
                  </strong>
                </div>
                <details>
                  <summary>Features changed</summary>
                  <p>{item.changed_features.map(humanize).join(", ")}</p>
                </details>
              </div>
            ))
          ) : (
            <div className="empty-inline">
              No applicable counterfactual scenarios for this history.
            </div>
          )}
        </Panel>
      </div>
      <Panel title="Behavior over time" eyebrow="Window-level analysis">
        <p className="muted">
          Nonoverlapping seven-day windows with at least 30 completed trades,
          from the most recent 12 weeks. Windows may abstain even when the full
          history is classified. These are descriptive changes, not independent
          validation observations.
        </p>
        {a.trends.length ? (
          <>
            <TrendChart trends={a.trends} />
            <details>
              <summary>Inspect window evidence and uncertainty</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Window (UTC)</th>
                      <th>Trades</th>
                      <th>Result</th>
                      <th>Top probability</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.trends.map((row, index) => (
                      <tr key={`${row.start}-${index}`}>
                        <th>
                          {index + 1}. {date(row.start)} – {date(row.end)}
                        </th>
                        <td>{row.trades}</td>
                        <td>
                          {row.prediction.status === "classified"
                            ? className(row.prediction.label)
                            : "Classification withheld"}
                          <div className="small muted">
                            {row.prediction.reasons.join(" ")}
                          </div>
                        </td>
                        <td>{percent(row.prediction.confidence)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        ) : (
          <div className="empty-inline">
            More completed trades are needed to compare windows.
          </div>
        )}
      </Panel>
      <div className="two-column">
        <Panel
          title="A structured review, for next time"
          eyebrow="Educational coaching"
        >
          <p>{a.coaching.summary}</p>
          <ol className="coaching-list">
            {a.coaching.actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ol>
          <p className="small muted">
            Source: deterministic feature-based guidance. Educational
            reflection, not investment advice or an assessment of your
            personality.
          </p>
        </Panel>
        <Panel
          title="Illustrative style alignment"
          eyebrow="Separate from the model"
        >
          <p className="muted">{a.alignment.disclaimer}</p>
          <AlignmentChart alignment={a.alignment} />
          <details>
            <summary>View measured dimensions</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Dimension</th>
                    <th>Your history</th>
                    <th>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {a.alignment.dimensions.map((item) => (
                    <tr key={item.dimension}>
                      <th>{humanize(item.dimension)}</th>
                      <td>{number(item.value)}</td>
                      <td>{number(item.target)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">Source: {a.alignment.source}</p>
          </details>
        </Panel>
      </div>
      <details className="panel">
        <summary>Inspect all extracted features</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(a.features).map(([key, value]) => (
                <tr key={key}>
                  <th>{humanize(key)}</th>
                  <td>{number(value, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
