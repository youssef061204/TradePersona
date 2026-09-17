"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, RotateCcw } from "lucide-react";
import { ApiError, getAnalysis, SESSION_KEY } from "@/lib/api";
import type { Analysis } from "@/lib/types";
import Shell, { PageTitle } from "../components/Shell";
import AnalysisReport from "../components/AnalysisReport";
export default function DashboardPage() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      try {
        const id = sessionStorage.getItem(SESSION_KEY);
        if (!id) {
          setError("Upload a completed trade history to begin your analysis.");
          return;
        }
        const result = await getAnalysis(id, controller.signal);
        setAnalysis(result.analysis);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (
          cause instanceof ApiError &&
          (cause.status === 404 || cause.status === 410)
        ) {
          sessionStorage.removeItem(SESSION_KEY);
          setError(
            "Your analysis session has expired or is no longer available. Upload your CSV again to start a new session.",
          );
        } else
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load the analysis.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt]);
  return (
    <Shell active="dashboard">
      <div className="title-row">
        <PageTitle
          eyebrow="Your trading history"
          title="Less guesswork. More perspective."
        >
          A review of measurable behavior, model uncertainty, and the evidence
          in your completed trades.
        </PageTitle>
        <Link href="/" className="button secondary">
          New analysis <ArrowRight size={16} />
        </Link>
      </div>
      {loading ? (
        <div className="loading panel" role="status">
          <span className="status-dot" /> Loading your analysis…
        </div>
      ) : error ? (
        <div className="empty-state panel">
          <h2>Your analysis starts here</h2>
          <p role="alert">{error}</p>
          <div className="inline-actions">
            <Link className="button primary" href="/">
              Upload trade history <ArrowRight size={16} />
            </Link>
            <button
              className="button secondary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RotateCcw size={15} /> Retry
            </button>
          </div>
        </div>
      ) : analysis ? (
        <AnalysisReport analysis={analysis} />
      ) : null}
    </Shell>
  );
}
