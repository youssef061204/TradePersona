import Link from "next/link";
import { Activity, ArrowUpRight } from "lucide-react";
export default function Shell({
  children,
  active,
}: {
  children: React.ReactNode;
  active: "upload" | "dashboard" | "evaluation";
}) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="brand" href="/">
            <span className="brand-icon">
              <Activity size={20} />
            </span>
            TradePersona<span className="brand-beta">LAB</span>
          </Link>
          <nav aria-label="Main navigation">
            {[
              ["/", "upload", "Upload"],
              ["/dashboard", "dashboard", "Your analysis"],
              ["/evaluation", "evaluation", "Model evaluation"],
            ].map(([href, key, label]) => (
              <Link
                key={key}
                href={href}
                aria-current={active === key ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
          <span className="header-note">
            <span className="status-dot" /> Research preview
          </span>
        </div>
      </header>
      <main id="main" className="page-container">
        {children}
      </main>
      <footer className="site-footer">
        <span>TradePersona · Behavioral analytics, with evidence.</span>
        <Link href="/evaluation">
          Explore the methodology <ArrowUpRight size={14} />
        </Link>
        <span>Educational use · Synthetic benchmark</span>
      </footer>
    </div>
  );
}
export function PageTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="subtitle">{children}</p>
    </div>
  );
}
export function Panel({
  title,
  eyebrow,
  children,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h2>{title}</h2>
      {children}
    </section>
  );
}
export function ScopeNotice() {
  return (
    <div className="scope-notice">
      <strong>Synthetic benchmark</strong>
      <span>
        Model probabilities describe simulated trading patterns. They are not
        validated on real traders and do not diagnose psychology.
      </span>
    </div>
  );
}
