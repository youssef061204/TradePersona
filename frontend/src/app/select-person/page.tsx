"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft, Search, Sparkles } from "lucide-react";

function slugify(name: string) {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

const PROFILES = [
  {
    name: "Warren Buffett",
    image: "/profile1.jpg",
    description:
      "Long-term value investor focused on durable businesses, patience, and disciplined capital allocation."
  },
  {
    name: "Cathie Wood",
    image: "/profile2.jpg",
    description:
      "High-conviction growth investor centered on disruptive innovation, momentum, and aggressive upside bets."
  },
  {
    name: "Michael Burry",
    image: "/profile3.jpg",
    description:
      "Contrarian investor who hunts for mispriced risk, asymmetric setups, and uncomfortable opportunities."
  }
];

export default function SelectPersonPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");

  const filteredProfiles = useMemo(
    () =>
      PROFILES.filter((p) =>
        p.name.toLowerCase().includes(search.toLowerCase())
      ),
    [search]
  );

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#07111f] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(48,163,255,0.18),_transparent_32%),radial-gradient(circle_at_80%_20%,_rgba(255,147,41,0.16),_transparent_26%),radial-gradient(circle_at_bottom_right,_rgba(19,214,155,0.12),_transparent_30%)]" />
      <div className="absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(255,255,255,0.55)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.55)_1px,transparent_1px)] [background-size:72px_72px]" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-8 md:px-10 lg:px-12">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.28em] text-cyan-100">
              <Sparkles className="h-4 w-4" />
              Persona match
            </div>
            <h1 className="mt-5 text-4xl font-semibold text-white md:text-5xl">
              Choose the investor you want to trade more like.
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">
              Pick a persona to compare your trade behavior against their style
              signature, then read the coaching plan built from that gap.
            </p>
          </div>

          <button
            onClick={() => router.push("/")}
            className="inline-flex items-center justify-center gap-2 self-start rounded-full border border-white/10 bg-white/[0.06] px-5 py-3 text-sm font-medium text-slate-100 transition hover:bg-white/[0.1]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>

        <div className="mt-8 max-w-xl">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search investor persona..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-full border border-white/10 bg-slate-950/75 py-3 pl-11 pr-4 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-400/20"
            />
          </label>
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {filteredProfiles.map((profile) => (
            <button
              key={profile.name}
              type="button"
              onClick={() => router.push(`/profile/${slugify(profile.name)}`)}
              className="group rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-6 text-left shadow-[0_28px_80px_rgba(0,0,0,0.32)] backdrop-blur-md transition duration-300 hover:-translate-y-1 hover:border-cyan-300/20 hover:bg-slate-900/70"
            >
              <div className="relative h-56 overflow-hidden rounded-[1.4rem] border border-white/10">
                <Image
                  src={profile.image}
                  alt={profile.name}
                  fill
                  sizes="(max-width: 1024px) 100vw, 33vw"
                  className="object-cover transition duration-500 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/25 to-transparent" />
              </div>

              <div className="mt-5">
                <p className="font-mono text-xs uppercase tracking-[0.28em] text-cyan-200/70">
                  Investor persona
                </p>
                <h2 className="mt-3 text-2xl font-semibold text-white">
                  {profile.name}
                </h2>
                <p className="mt-3 text-sm leading-7 text-slate-300">
                  {profile.description}
                </p>
              </div>
            </button>
          ))}
        </div>

        {!filteredProfiles.length ? (
          <div className="mt-10 rounded-[1.5rem] border border-white/10 bg-slate-950/55 p-6 text-sm text-slate-300">
            No personas matched that search.
          </div>
        ) : null}
      </div>
    </main>
  );
}
