import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig, applyRuntimeConfig } from "@/lib/market/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // merge persisted overrides (best-effort)
  try {
    const { db } = await import("@/db");
    const { settings } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(settings).where(eq(settings.key, "runtime"));
    if (rows.length) applyRuntimeConfig(rows[0].value as any);
  } catch { /* defaults apply */ }
  return NextResponse.json({ config: getRuntimeConfig() });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const config = applyRuntimeConfig(body?.config ?? body ?? {});
    try {
      const { db } = await import("@/db");
      const { settings } = await import("@/db/schema");
      await db.insert(settings).values({ key: "runtime", value: config as any }).onConflictDoUpdate({ target: settings.key, set: { value: config as any, updatedAt: new Date() } });
    } catch { /* runtime update still applied */ }
    return NextResponse.json({ config });
  } catch {
    return NextResponse.json({ error: "invalid settings payload" }, { status: 400 });
  }
}
