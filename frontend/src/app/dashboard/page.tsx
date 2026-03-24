import Link from "next/link";

export default function DashboardPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <h1 className="text-3xl font-semibold text-slate-900">Dashboard</h1>
      <p className="mt-3 text-sm text-slate-600">
        Upload a trade file from the home page, then open a persona profile to
        see your bias breakdown, timeline, and coaching.
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/"
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Back to Upload
        </Link>
        <Link
          href="/select-person"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
        >
          Choose Persona
        </Link>
      </div>
    </main>
  );
}
