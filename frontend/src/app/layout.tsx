import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "TradePersona · Behavioral Analytics",
  description:
    "Evidence-based trading history analytics with experimental machine learning, transparent uncertainty, and reproducible synthetic evaluation.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
