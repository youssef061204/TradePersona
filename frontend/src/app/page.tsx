"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  ArrowRight,
  BrainCircuit,
  CandlestickChart,
  Download,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";

const highlights = [
  {
    title: "Behavioral fingerprinting",
    copy: "Turn a raw trade log into bias ratios, risk reactivity, and discipline signals.",
    icon: BrainCircuit,
  },
  {
    title: "Investor persona matching",
    copy: "Compare your habits to iconic investors and see where your style drifts.",
    icon: CandlestickChart,
  },
  {
    title: "Actionable coaching",
    copy: "Get simple guardrails you can actually use before the next trading session.",
    icon: ShieldCheck,
  },
];

const steps = [
  "Upload a CSV with timestamps, side, asset, quantity, entry price, and profit/loss.",
  "TradePersona scores your behavior, bias mix, and portfolio habits.",
  "Pick a persona and see how your trading style stacks up against theirs.",
];

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<string>("");
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();

  const fileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextFile = e.target.files?.[0] ?? null;
    setFile(nextFile);
    setResult("");
  };

  const removeFile = () => {
    setFile(null);
    setResult("");
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const confirmUpload = async () => {
    if (!file || isUploading) return;

    const formData = new FormData();
    formData.append("file", file);

    setIsUploading(true);
    setResult("Uploading and analyzing your trades...");

    try {
      const res = await fetch("http://localhost:3001/api/uploads/usertrades", {
        method: "POST",
        body: formData,
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setResult(data?.error || data?.message || "Upload failed.");
        return;
      }

      if (data?.sessionId) {
        localStorage.setItem("sessionId", data.sessionId);
      }

      setResult("Upload complete. Opening persona selection...");
      router.push("/select-person");
    } catch (err: any) {
      setResult(`Upload failed: ${err?.message || "Unknown error"}`);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#07111f] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(48,163,255,0.24),_transparent_32%),radial-gradient(circle_at_80%_20%,_rgba(255,147,41,0.2),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(19,214,155,0.18),_transparent_32%)]" />
      <div className="absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:72px_72px]" />
      <div className="absolute inset-0 opacity-[0.07] mix-blend-screen">
        <Image src="/noise_overlay.png" alt="" fill className="object-cover" />
      </div>

      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-8 md:px-10 lg:px-12">
        <header className="flex items-center justify-between border-b border-white/10 pb-6">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-200/80">
              TradePersona
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-white md:text-3xl">
              Read the psychology hiding in your trade history.
            </h1>
          </div>

          <a
            href="/tradepersona-sample.csv"
            download
            className="hidden items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-white/90 transition hover:bg-white/14 md:flex"
          >
            <Download className="h-4 w-4" />
            Download sample CSV
          </a>
        </header>

        <section className="grid flex-1 grid-cols-1 gap-10 py-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-300/25 bg-amber-300/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.28em] text-amber-100">
              <Sparkles className="h-4 w-4" />
              Bias-aware trading review
            </div>

            <h2 className="mt-6 max-w-3xl text-5xl font-semibold leading-[0.96] text-white md:text-6xl">
              Upload a CSV and see whether your trading feels disciplined,
              reactive, or self-sabotaging.
            </h2>

            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
              TradePersona turns your executions into a behavioral profile:
              overtrading pressure, loss aversion, revenge patterns, portfolio
              patience, and coachable gaps versus legendary investor personas.
            </p>

            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {highlights.map(({ title, copy, icon: Icon }) => (
                <div
                  key={title}
                  className="rounded-3xl border border-white/10 bg-white/[0.06] p-5 backdrop-blur-sm"
                >
                  <Icon className="h-5 w-5 text-cyan-300" />
                  <h3 className="mt-4 text-base font-semibold text-white">
                    {title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    {copy}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-8 rounded-[2rem] border border-cyan-300/18 bg-slate-950/45 p-6">
              <p className="font-mono text-xs uppercase tracking-[0.3em] text-cyan-200/80">
                How it works
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                {steps.map((step, index) => (
                  <div key={step} className="rounded-2xl bg-white/[0.04] p-4">
                    <p className="text-sm font-semibold text-cyan-200">
                      0{index + 1}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      {step}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-[2rem] border border-white/12 bg-slate-950/55 p-6 shadow-[0_32px_80px_rgba(0,0,0,0.35)] backdrop-blur-md md:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.32em] text-slate-400">
                  Start analysis
                </p>
                <h3 className="mt-3 text-3xl font-semibold text-white">
                  Upload your trade log
                </h3>
                <p className="mt-3 text-sm leading-6 text-slate-300">
                  Use your own CSV or the sample file to explore the full
                  TradePersona flow end to end.
                </p>
              </div>
              <div className="rounded-2xl bg-cyan-400/12 p-3 text-cyan-200">
                <Upload className="h-5 w-5" />
              </div>
            </div>

            <div className="mt-8 rounded-[1.75rem] border border-dashed border-white/18 bg-white/[0.04] p-5">
              <input
                ref={inputRef}
                id="csv-upload"
                type="file"
                accept=".csv"
                onChange={fileChange}
                className="hidden"
              />

              <p className="text-sm font-medium text-white">
                Preferred format
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                Include `timestamp`, `side`, `asset`, `quantity`,
                `entry_price`, and `profit_loss` for the richest analysis.
              </p>

              <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-100"
                >
                  <Upload className="h-4 w-4" />
                  {file ? "Replace CSV" : "Choose CSV"}
                </button>

                <button
                  type="button"
                  onClick={confirmUpload}
                  disabled={!file || isUploading}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {isUploading ? "Analyzing..." : "Analyze My Trades"}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-5 rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                {file ? (
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">
                        {file.name}
                      </p>
                      <p className="mt-1 text-xs uppercase tracking-[0.22em] text-emerald-200/80">
                        Ready to upload
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={removeFile}
                      className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-semibold text-white">
                      No file selected yet
                    </p>
                    <p className="mt-1 text-sm text-slate-400">
                      Start with the sample CSV if you just want to explore the
                      experience.
                    </p>
                  </div>
                )}
              </div>

              <a
                href="/tradepersona-sample.csv"
                download
                className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-cyan-200 transition hover:text-cyan-100 md:hidden"
              >
                <Download className="h-4 w-4" />
                Download sample CSV
              </a>
            </div>

            {result ? (
              <div className="mt-5 rounded-2xl border border-cyan-300/18 bg-cyan-300/10 p-4 text-sm leading-6 text-cyan-50">
                {result}
              </div>
            ) : null}

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl bg-white/[0.04] p-4">
                <p className="font-mono text-xs uppercase tracking-[0.28em] text-slate-500">
                  Outputs
                </p>
                <p className="mt-2 text-sm text-slate-300">
                  Bias pie chart, radar profile, timeline replay, persona fit,
                  and coaching guardrails.
                </p>
              </div>
              <div className="rounded-2xl bg-white/[0.04] p-4">
                <p className="font-mono text-xs uppercase tracking-[0.28em] text-slate-500">
                  Best for
                </p>
                <p className="mt-2 text-sm text-slate-300">
                  Retail trading logs, broker exports, and fast iteration on
                  behavior analysis demos.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
