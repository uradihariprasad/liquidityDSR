import Terminal from "@/components/Terminal";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PulseGrid — Market Movement, Liquidity & FMPI Intelligence",
};

export const dynamic = "force-dynamic";

export default function Page() {
  return <Terminal />;
}
