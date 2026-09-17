"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  FileUp,
  Download,
  Check,
  ChartNoAxesCombined,
  Fingerprint,
  ScanLine,
  LoaderCircle,
} from "lucide-react";
import { ApiError, SESSION_KEY, uploadTrades } from "@/lib/api";
import Shell from "./components/Shell";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  function selectFile(next: File | undefined) {
    setError("");
    setFile(null);
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".csv")) {
      setError("Choose a CSV file.");
      return;
    }
    if (next.size > 50 * 1024 * 1024) {
      setError("Your file exceeds the 50 MB upload limit.");
      return;
    }
    setFile(next);
  }
  async function analyze() {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await uploadTrades(file);
      sessionStorage.setItem(SESSION_KEY, result.sessionId);
      router.push("/dashboard");
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Unable to analyze this file. Please try again.";
      const quality =
        cause instanceof ApiError && cause.quality?.malformed_rows
          ? ` ${cause.quality.malformed_rows} of ${cause.quality.total_rows} rows need correction.`
          : "";
      setError(message + quality);
      setBusy(false);
    }
  }
  return (
    <Shell active="upload">
      <div className="home-hero">
        <section className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" /> A clearer view of your trading
          </p>
          <h1>
            Your trades tell
            <br />a story.
            <br />
            <span>Start with the evidence.</span>
          </h1>
          <p className="hero-description">
            Explore activity, position sizing, and what happens after a loss.
            Turn a completed trade history into measurable patterns and a more
            thoughtful review.
          </p>
          <div className="hero-links">
            <Link href="/evaluation">
              See how the model is evaluated <ArrowRight size={16} />
            </Link>
          </div>
          <div className="scope-mini">
            <Fingerprint size={22} />
            <p>
              <strong>Patterns, with perspective.</strong>
              <br />
              An experimental model trained on synthetic histories. No
              personality diagnoses. No investment recommendations.
            </p>
          </div>
        </section>
        <section className="upload-card">
          <div className="upload-heading">
            <span className="icon-tile">
              <FileUp size={23} />
            </span>
            <span className="tag">01 / YOUR DATA</span>
          </div>
          <h2>Bring your trade history</h2>
          <p>
            One account. One row per completed trade.
            <br />
            We’ll take it from there.
          </p>
          <div
            className={`drop-zone ${dragging ? "dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (!busy) selectFile(event.dataTransfer.files[0]);
            }}
          >
            <FileUp size={30} strokeWidth={1.4} />
            <label htmlFor="csv-upload">
              {file ? file.name : "Choose a CSV or drop it here"}
            </label>
            <span>
              {file
                ? (file.size / 1024).toFixed(1) + " KB · Ready to analyze"
                : "CSV files up to 50 MB"}
            </span>
            <input
              ref={input}
              id="csv-upload"
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(event) => selectFile(event.target.files?.[0])}
            />
          </div>
          {error ? (
            <div role="alert" className="error-notice">
              {error}
            </div>
          ) : null}
          <button
            className="button primary full"
            onClick={analyze}
            disabled={!file || busy}
          >
            {busy ? (
              <>
                <LoaderCircle className="spin" size={17} /> Validating and
                analyzing…
              </>
            ) : (
              <>
                Analyze my trades <ArrowRight size={17} />
              </>
            )}
          </button>
          <p className="upload-privacy">
            Your analysis is held in server memory for 30 minutes. The session
            stays in this browser tab.
          </p>
          <a className="sample-link" href="/tradepersona-sample.csv" download>
            <Download size={16} /> Try a synthetic sample CSV
          </a>
        </section>
      </div>
      <section className="workflow-grid" aria-label="How analysis works">
        {[
          {
            icon: ScanLine,
            n: "01",
            title: "Validate the history",
            description:
              "See which rows were usable, what was missing, and the limits of the input.",
          },
          {
            icon: ChartNoAxesCombined,
            n: "02",
            title: "Inspect the evidence",
            description:
              "Explore measured behavior, experimental probabilities, and changes over time.",
          },
          {
            icon: Fingerprint,
            n: "03",
            title: "Understand the uncertainty",
            description:
              "Review why a prediction was made—or why the model withheld a classification.",
          },
        ].map(({ icon: Icon, n, title, description }) => (
          <div className="workflow-item" key={n}>
            <div>
              <Icon size={21} />
              <span>{n}</span>
            </div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
        ))}
      </section>
      <section className="input-guide">
        <div>
          <p className="eyebrow">Before you upload</p>
          <h2>A small, explicit data contract.</h2>
          <p>
            Completed trades in one currency, ordered by completion time. Naive
            timestamps are interpreted as UTC.
          </p>
        </div>
        <div>
          <p>
            <Check size={16} />
            <strong>Required columns</strong>
          </p>
          <div className="code-tags">
            {["timestamp", "quantity", "entry_price", "profit_loss"].map(
              (s) => (
                <code key={s}>{s}</code>
              ),
            )}
          </div>
          <p>
            <Check size={16} />
            <strong>Optional context</strong>
          </p>
          <div className="code-tags">
            {[
              "holding_minutes",
              "asset",
              "side",
              "trader_id",
              "account_id",
            ].map((s) => (
              <code key={s}>{s}</code>
            ))}
          </div>
          <p className="muted">
            Holding duration is needed for classification; without it, you still
            get available metrics. Quantity and entry price must be positive.
            Holding minutes must be nonnegative.
          </p>
          <p className="muted">
            Unsupported: multiple accounts, mixed currencies, negative
            quantities, overlapping open positions, and raw execution lots
            requiring reconstruction.
          </p>
        </div>
      </section>
    </Shell>
  );
}
