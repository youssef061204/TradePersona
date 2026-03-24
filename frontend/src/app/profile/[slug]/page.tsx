"use client";

import Image from "next/image";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, Sparkles } from "lucide-react";
import PortfolioRadar from "@/app/components/RadarChart";
import BiasPieChart from "@/app/components/BiasPieChart";
import CountUp from "@/app/components/CountUp";
import PortfolioTimeline from "@/app/components/PortfolioTimeline";

type ProfileData = {
  name: string;
  avatarUrl?: string;
  bio?: string;
  tradingStyle?: string;
  riskProfile?: string;
  stats?: Record<string, string | number>;
};

const PERSONAS = [
  { label: "Warren Buffett", slug: "warren-buffett", investorId: "buffett_berkshire" },
  { label: "Cathie Wood", slug: "cathie-wood", investorId: "cathie_ark" },
  { label: "Michael Burry", slug: "michael-burry", investorId: "burry_scion" }
];

function getPersonaImage(slug: string) {
  const map: Record<string, string> = {
    "warren-buffett": "/profile1.jpg",
    "cathie-wood": "/profile2.jpg",
    "michael-burry": "/profile3.jpg"
  };

  return map[slug] ?? "/profile1.jpg";
}

const HARDCODED_PERSONA_RADAR: Record<string, any> = {
  "warren-buffett": {
    normalizedMetrics: {
      trade_frequency: 0.1,
      avg_trade_size: 0.85,
      holding_period: 0.95,
      after_loss: 0.2,
      size_variability: 0.25
    }
  },
  "cathie-wood": {
    normalizedMetrics: {
      trade_frequency: 0.75,
      avg_trade_size: 0.6,
      holding_period: 0.5,
      after_loss: 0.7,
      size_variability: 0.75
    }
  },
  "michael-burry": {
    normalizedMetrics: {
      trade_frequency: 0.35,
      avg_trade_size: 0.8,
      holding_period: 0.7,
      after_loss: 0.55,
      size_variability: 0.45
    }
  }
};

const shellClass =
  "relative min-h-screen overflow-hidden bg-[#07111f] text-slate-100";
const cardClass =
  "rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-6 shadow-[0_28px_80px_rgba(0,0,0,0.32)] backdrop-blur-md";
const subCardClass =
  "rounded-[1.5rem] border border-white/10 bg-slate-900/65 p-5";
const monoLabel =
  "font-mono text-xs uppercase tracking-[0.3em] text-cyan-200/75";

export default function ProfilePage() {
  const params = useParams();
  const slug = params.slug as string;
  const router = useRouter();

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [personaResult, setPersonaResult] = useState<any>(null);
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [biasRatios, setBiasRatios] = useState<Record<string, number> | null>(null);
  const [geminiAnalysis, setGeminiAnalysis] = useState<{ summary?: string; suggestions?: string[] } | null>(null);
  const [geminiError, setGeminiError] = useState<string | null>(null);
  const [coachingData, setCoachingData] = useState<any>(null);
  const [coachingLoading, setCoachingLoading] = useState(false);
  const [coachingError, setCoachingError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rawApiData, setRawApiData] = useState<any>(null);

  useEffect(() => {
    if (!slug) return;

    setLoading(true);
    const selectedPersona = PERSONAS.find((item) => item.slug === slug);

    setProfile({
      name: selectedPersona?.label ?? slug.replace(/-/g, " ")
    });

    setPersonaResult(HARDCODED_PERSONA_RADAR[slug]);

    const load = async () => {
      try {
        const res = await fetch("http://localhost:3001/api/uploads/usertrades");
        if (!res.ok) {
          throw new Error("No uploaded data yet");
        }
        const data = await res.json();
        setRawApiData(data);
        const uploadSessionId =
          data.sessionId ||
          (typeof window !== "undefined" ? localStorage.getItem("sessionId") : null);
        if (uploadSessionId) {
          setSessionId(uploadSessionId);
          if (typeof window !== "undefined") {
            localStorage.setItem("sessionId", uploadSessionId);
          }
        }

        const pm = data.metrics?.portfolio_metrics;
        const biasTypeRatios = data.metrics?.bias_type_ratios ?? null;

        if (!pm) {
          setAnalysisResult(null);
          setBiasRatios(biasTypeRatios);
        } else {
          const radarData = {
            normalizedMetrics: {
              trade_frequency: pm.trade_frequency_score / 100,
              holding_period: pm.holding_patience_score / 100,
              after_loss: pm.risk_reactivity_score / 100,
              avg_trade_size: pm.consistency_score / 100,
              size_variability: pm.consistency_score / 100
            }
          };

          setAnalysisResult(radarData);
          setBiasRatios(biasTypeRatios);
        }

        setLoading(false);

        if (data.metrics) {
          setGeminiAnalysis(null);
          setGeminiError(null);

          fetch("http://localhost:3001/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ metrics: data.metrics }),
          })
            .then(async (analysisRes) => {
              const analysisData = await analysisRes.json().catch(() => ({}));
              if (analysisRes.ok) {
                setGeminiAnalysis(Array.isArray(analysisData) ? {} : analysisData);
              } else {
                setGeminiError(analysisData?.error || "Failed to generate analysis");
              }
            })
            .catch((err) => {
              console.error("Gemini analysis error:", err);
              setGeminiError(err?.message || "Failed to load analysis");
            });
        }

        if (uploadSessionId && selectedPersona?.investorId) {
          setCoachingLoading(true);
          setCoachingError(null);

          fetch(`http://localhost:3001/coach/${uploadSessionId}/${selectedPersona.investorId}`)
            .then(async (coachRes) => {
              const coachData = await coachRes.json().catch(() => ({}));
              if (coachRes.ok) {
                setCoachingData(Array.isArray(coachData) ? {} : coachData);
              } else {
                setCoachingError(coachData?.error || "Failed to generate coaching");
              }
            })
            .catch((err) => {
              console.error("Coaching error:", err);
              setCoachingError(err?.message || "Failed to load coaching");
            })
            .finally(() => setCoachingLoading(false));
        }
      } catch (err: any) {
        console.error(err);
        setRawApiData({ error: err.message });
        setAnalysisResult(null);
        setBiasRatios(null);
        setLoading(false);
      }
    };

    load();
  }, [slug]);

  if (loading) {
    return (
      <main className={shellClass}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(48,163,255,0.18),_transparent_32%),radial-gradient(circle_at_80%_20%,_rgba(255,147,41,0.16),_transparent_26%),radial-gradient(circle_at_bottom_right,_rgba(19,214,155,0.12),_transparent_30%)]" />
        <div className="relative z-10 mx-auto flex min-h-screen max-w-7xl items-center px-6 py-8 md:px-10">
          <div className={cardClass}>Loading profile...</div>
        </div>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className={shellClass}>
        <div className="relative z-10 mx-auto flex min-h-screen max-w-7xl items-center px-6 py-8 md:px-10">
          <div className={cardClass}>Profile not found.</div>
        </div>
      </main>
    );
  }

  const behavioral = rawApiData?.metrics?.behavioral;
  const overtrading = behavioral?.overtrading;
  const lossAversion = behavioral?.loss_aversion;
  const revengeTrading = behavioral?.revenge_trading;
  const martingaleStats = revengeTrading?.martingale_stats || null;
  const martingaleHasSignal =
    (typeof revengeTrading?.tilt_indicator_pct === "number" &&
      revengeTrading.tilt_indicator_pct > 0.1) ||
    (martingaleStats &&
      Object.values(martingaleStats).some(
        (v: any) => Number.isFinite(Number(v)) && Number(v) > 0.001
      ));
  const formatNumber = (value: number | null | undefined, digits = 2) =>
    value == null || Number.isNaN(value) ? "--" : value.toFixed(digits);
  const formatLabel = (str: string | undefined | null) => {
    if (!str || typeof str !== "string") return "--";
    return str
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  };
  const biasLabels: Record<string, string> = {
    overtrader: "overtrader",
    loss_aversion: "loss-averse trader",
    revenge_trader: "revenge trader",
    calm_trader: "calm trader"
  };
  const biasEntries = biasRatios ? Object.entries(biasRatios) : [];
  const topBias = biasEntries.length
    ? biasEntries.reduce(
        (acc, [key, value]) => (value > acc.value ? { key, value } : acc),
        { key: biasEntries[0][0], value: biasEntries[0][1] }
      )
    : null;
  const topBiasLabel = topBias ? biasLabels[topBias.key] ?? topBias.key : null;
  const topBiasValue = topBias ? Number(topBias.value.toFixed(1)) : null;
  const personaImage = getPersonaImage(slug);

  return (
    <main className={shellClass}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(48,163,255,0.2),_transparent_32%),radial-gradient(circle_at_82%_18%,_rgba(255,147,41,0.16),_transparent_26%),radial-gradient(circle_at_bottom_right,_rgba(19,214,155,0.12),_transparent_30%)]" />
      <div className="absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(255,255,255,0.55)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.55)_1px,transparent_1px)] [background-size:72px_72px]" />

      <div className="relative z-10 mx-auto max-w-7xl px-6 py-8 md:px-10 lg:px-12">
        <section className="mb-8 flex flex-col gap-6 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-col gap-5 md:flex-row md:items-center">
            <div className="relative h-24 w-24 overflow-hidden rounded-[1.5rem] border border-white/10 bg-slate-900/80 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
              <Image
                src={personaImage}
                alt={profile.name}
                fill
                sizes="96px"
                className="object-cover"
              />
            </div>
            <div>
              <p className={monoLabel}>TradePersona Report</p>
              <h1 className="mt-3 text-4xl font-semibold text-white md:text-5xl">
                {profile.name}
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
                Your behavior is being compared against this persona using live
                trade metrics, bias ratios, and a dark-mode dashboard tuned for
                the charts below.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-2">
              <span className="text-xs uppercase tracking-[0.24em] text-slate-400">
                Change persona
              </span>
              <select
                value={slug}
                onChange={(e) => router.push(`/profile/${e.target.value}`)}
                className="rounded-2xl border border-white/10 bg-slate-950/75 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-400/20"
              >
                {PERSONAS.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              onClick={() => router.push("/")}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-5 py-3 text-sm font-medium text-slate-100 transition hover:bg-white/[0.1]"
            >
              <ArrowLeft className="h-4 w-4" />
              Home
            </button>
          </div>
        </section>

        <section className={`${cardClass} mb-10`}>
          <div className="grid gap-8 xl:grid-cols-[1.05fr_0.95fr]">
            <div>
              <p className={monoLabel}>Behavioral Mix</p>
              <h2 className="mt-3 text-2xl font-semibold text-white">
                Bias ratio snapshot
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300">
                This chart shows how your recent trading behavior clusters
                across overtrading, loss aversion, revenge trading, and calm
                execution.
              </p>

              <div className="mt-6 rounded-[1.5rem] border border-white/10 bg-slate-900/70 p-5">
                {biasRatios ? (
                  <BiasPieChart ratios={biasRatios} showSummary={false} />
                ) : (
                  <p className="text-sm text-slate-400">
                    No bias ratio data yet. Upload a CSV first.
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="rounded-[1.5rem] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(8,47,73,0.95),rgba(15,23,42,0.85),rgba(15,118,110,0.28))] p-6">
                <p className={monoLabel}>Dominant Bias</p>
                {topBiasLabel && topBiasValue != null ? (
                  <>
                    <div className="mt-4 text-3xl font-semibold text-white md:text-4xl">
                      You are{" "}
                      <CountUp
                        from={0}
                        to={topBiasValue}
                        duration={1.4}
                        className="inline-block bg-gradient-to-r from-cyan-300 via-sky-300 to-emerald-300 bg-clip-text text-transparent"
                      />{" "}
                      % a {topBiasLabel}
                    </div>
                    <p className="mt-4 text-sm leading-7 text-slate-200/85">
                      This is the strongest pattern showing up in your uploaded
                      trades right now.
                    </p>
                  </>
                ) : (
                  <p className="mt-4 text-sm text-slate-300">
                    Upload data to see your bias highlight.
                  </p>
                )}
              </div>

              <div className="rounded-[1.5rem] border border-white/10 bg-slate-950/75 p-6">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-300" />
                  <p className={monoLabel}>AI Readout</p>
                </div>

                {geminiAnalysis?.summary ? (
                  <p className="mt-4 text-sm leading-7 text-slate-300">
                    {geminiAnalysis.summary}
                  </p>
                ) : geminiError ? (
                  <p className="mt-4 text-sm text-rose-300">
                    {geminiError}
                  </p>
                ) : (
                  <p className="mt-4 animate-pulse text-sm text-slate-400">
                    Loading AI analysis...
                  </p>
                )}

                {geminiAnalysis?.suggestions?.length ? (
                  <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-300 marker:text-cyan-300">
                    {geminiAnalysis.suggestions.map((item, idx) => (
                      <li key={`${idx}-${item}`}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <section className="mb-10">
          <div className="mb-4">
            <p className={monoLabel}>Metric Breakdown</p>
            <h2 className="mt-3 text-2xl font-semibold text-white">
              Where the signals are coming from
            </h2>
          </div>

          <div className="grid gap-5 md:grid-cols-3">
            <div className={subCardClass}>
              <h3 className="text-lg font-semibold text-white">Overtrading</h3>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <p>Avg trades/hour: {formatNumber(overtrading?.avg_trades_per_hour)}</p>
                <p>Max trades/hour: {overtrading?.max_trades_in_one_hour ?? "--"}</p>
              </div>
            </div>

            <div className={subCardClass}>
              <h3 className="text-lg font-semibold text-white">Loss aversion</h3>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <p>Avg loss: {formatNumber(lossAversion?.avg_abs_loss)}</p>
                <p>Avg win: {formatNumber(lossAversion?.avg_win)}</p>
                <p>Disposition ratio: {formatNumber(lossAversion?.disposition_ratio, 3)}</p>
              </div>
            </div>

            <div className={subCardClass}>
              <h3 className="text-lg font-semibold text-white">Revenge trading</h3>
              <p className="mt-4 text-sm text-slate-300">
                Tilt indicator:{" "}
                <span
                  className={`font-semibold ${
                    revengeTrading?.tilt_indicator_pct &&
                    revengeTrading.tilt_indicator_pct > 60
                      ? "text-rose-300"
                      : "text-amber-200"
                  }`}
                >
                  {formatNumber(revengeTrading?.tilt_indicator_pct)}%
                </span>
              </p>

              {martingaleStats && Object.keys(martingaleStats).length > 0 ? (
                <div className="mt-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Martingale escalation
                  </p>
                  {martingaleHasSignal ? (
                    <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                      {Object.entries(martingaleStats)
                        .sort(([a], [b]) => Number(a) - Number(b))
                        .slice(0, 12)
                        .map(([streak, avgSize]) => {
                          const streakNum = Number(streak);
                          const size = Number(avgSize);
                          const baselineSize = Number(martingaleStats[0] ?? 0);
                          const hasBaseline =
                            Number.isFinite(baselineSize) && baselineSize !== 0;
                          const pctChange = hasBaseline
                            ? ((size - baselineSize) / baselineSize) * 100
                            : 0;
                          const isDangerous =
                            hasBaseline && Math.abs(pctChange) > 20 && streakNum > 0;
                          const pctLabel =
                            streakNum > 0
                              ? hasBaseline
                                ? `(${pctChange > 0 ? "+" : ""}${pctChange.toFixed(0)}%)`
                                : "(n/a)"
                              : "";

                          return (
                            <div
                              key={streak}
                              className={`flex justify-between rounded-2xl border px-3 py-2 text-xs ${
                                isDangerous
                                  ? "border-rose-400/30 bg-rose-400/10 text-rose-200"
                                  : "border-white/8 bg-white/[0.03] text-slate-300"
                              }`}
                            >
                              <span>
                                {streakNum === 0
                                  ? "Baseline"
                                  : `After ${streakNum} loss${streakNum > 1 ? "es" : ""}`}
                                :
                              </span>
                              <span>
                                $
                                {Number.isFinite(size)
                                  ? size.toLocaleString("en-US", {
                                      maximumFractionDigits: 0,
                                    })
                                  : "--"}{" "}
                                {pctLabel}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">
                      No escalation detected. Position sizing looks relatively
                      flat after losses.
                    </p>
                  )}
                </div>
              ) : (
                <p className="mt-4 text-xs text-slate-400">No martingale data</p>
              )}
            </div>
          </div>
        </section>

        <section className="mb-10">
          <div className="mb-4">
            <p className={monoLabel}>Replay</p>
            <h2 className="mt-3 text-2xl font-semibold text-white">
              Portfolio timeline
            </h2>
          </div>
          <PortfolioTimeline sessionId={sessionId} />
        </section>

        <section className="mb-10 grid gap-6 lg:grid-cols-2">
          <div className={cardClass}>
            <p className={monoLabel}>Persona Profile</p>
            <h2 className="mt-3 text-2xl font-semibold text-white">
              {profile.name}'s style radar
            </h2>
            <div className="mt-6 rounded-[1.5rem] border border-white/10 bg-slate-900/70 p-5">
              {personaResult && (
                <PortfolioRadar
                  result={personaResult}
                  label={profile.name}
                  color="255,159,64"
                />
              )}
            </div>
          </div>

          <div className={cardClass}>
            <p className={monoLabel}>Your Profile</p>
            <h2 className="mt-3 text-2xl font-semibold text-white">
              Your trading radar
            </h2>
            <div className="mt-6 rounded-[1.5rem] border border-white/10 bg-slate-900/70 p-5">
              {analysisResult ? (
                <PortfolioRadar
                  result={analysisResult}
                  label="Your trading profile"
                  color="56,189,248"
                />
              ) : (
                <p className="text-sm text-slate-400">
                  No uploaded data yet. Upload a CSV first.
                </p>
              )}
            </div>
          </div>
        </section>

        <section className={`${cardClass} mb-10`}>
          <p className={monoLabel}>Coaching</p>
          <h2 className="mt-3 text-2xl font-semibold text-white">
            How to trade more like {profile?.name}
          </h2>

          {coachingLoading ? (
            <p className="mt-4 animate-pulse text-sm text-slate-400">
              Loading personalized coaching...
            </p>
          ) : coachingError ? (
            <div className="mt-6 rounded-[1.5rem] border border-rose-400/25 bg-rose-400/10 p-4">
              <p className="text-sm text-rose-200">{coachingError}</p>
            </div>
          ) : coachingData?.coaching ? (
            <div className="mt-6 space-y-6">
              {coachingData.coaching.summary && (
                <div className="rounded-[1.5rem] border border-cyan-300/18 bg-cyan-400/10 p-5">
                  <h3 className="text-base font-semibold text-cyan-100">
                    Analysis
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-slate-200">
                    {coachingData.coaching.summary}
                  </p>
                </div>
              )}

              {coachingData.comparison?.alignment?.score != null && (
                <div className="rounded-[1.5rem] border border-white/10 bg-slate-900/70 p-5">
                  <h3 className="text-base font-semibold text-white">
                    Alignment score
                  </h3>
                  <div className="mt-3 bg-gradient-to-r from-cyan-300 via-sky-300 to-emerald-300 bg-clip-text text-4xl font-bold text-transparent">
                    {Math.round(coachingData.comparison.alignment.score)}%
                  </div>
                  <p className="mt-2 text-xs uppercase tracking-[0.2em] text-slate-400">
                    How closely your trading matches {profile?.name}
                  </p>
                </div>
              )}

              {coachingData.coaching.keyGaps?.length > 0 && (
                <div className="rounded-[1.5rem] border border-white/10 bg-slate-900/70 p-5">
                  <h3 className="mb-4 text-base font-semibold text-white">
                    Key differences
                  </h3>
                  <ul className="space-y-3">
                    {coachingData.coaching.keyGaps.map((gap: any, idx: number) => (
                      <li
                        key={idx}
                        className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm text-slate-300"
                      >
                        <span className="font-medium text-slate-100">
                          {formatLabel(gap.dimension)}:
                        </span>{" "}
                        {gap.description}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {coachingData.coaching.actionPlan?.length > 0 && (
                <div className="rounded-[1.5rem] border border-white/10 bg-slate-900/70 p-5">
                  <h3 className="mb-4 text-base font-semibold text-white">
                    Action plan
                  </h3>
                  <div className="space-y-4">
                    {coachingData.coaching.actionPlan.map((action: any, idx: number) => (
                      <div
                        key={idx}
                        className="rounded-2xl border border-cyan-300/12 bg-cyan-400/8 p-4"
                      >
                        <h4 className="text-sm font-semibold text-white">
                          {action.objective}
                        </h4>
                        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-300 marker:text-cyan-300">
                          {action.steps?.map((step: string, sIdx: number) => (
                            <li key={sIdx}>{step}</li>
                          ))}
                        </ul>
                        {action.targetThreshold && (
                          <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-400">
                            Target: {formatLabel(action.metric)} {action.targetThreshold}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {coachingData.coaching.guardrails?.length > 0 && (
                <div className="rounded-[1.5rem] border border-amber-300/20 bg-amber-400/10 p-5">
                  <h3 className="mb-3 text-base font-semibold text-amber-100">
                    Guardrails
                  </h3>
                  <ul className="list-disc space-y-2 pl-5 text-sm text-amber-50/90 marker:text-amber-200">
                    {coachingData.coaching.guardrails.map((rule: string, idx: number) => (
                      <li key={idx}>{rule}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">
              Upload trading data to get personalized coaching.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
