import type { Metadata } from "next";
import { Fustat, Roboto_Mono } from "next/font/google";
import "./globals.css";

const fustat = Fustat({
  variable: "--font-fustat",
  subsets: ["latin"],
  weight: ["200", "300", "400", "500", "600", "700", "800"],
});

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-roboto-mono",
});

export const metadata: Metadata = {
  title: "TradePersona",
  description: "Upload a trading CSV to uncover bias patterns, portfolio habits, and persona alignment.",
};

export default function RootLayout({ children }: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">

      <body className={`${fustat.variable} ${robotoMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
