import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "PulseGrid — Market Movement, Liquidity & FMPI Intelligence",
  description:
    "Indian market intelligence: market movement classification, liquidity mapping, order-flow capability, FMPI momentum, F&O scanning, trade scenarios and replay/backtesting. Decision support, not a guaranteed prediction system.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg text-ink antialiased">{children}</body>
    </html>
  );
}
