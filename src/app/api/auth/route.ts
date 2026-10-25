import { NextRequest, NextResponse } from "next/server";
import { getAuthState, setRuntimeToken, clearRuntimeToken, markValidation, store } from "@/lib/market/credentials";
import { validateToken } from "@/lib/market/upstox";
import { setUniverse } from "@/lib/market/universe";
import { invalidateScanCache } from "@/lib/market/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Revalidate at most this often so polling does not hammer Upstox. */
const RECHECK_MS = 3 * 60_000;

/** GET — current connection state (token always masked). */
export async function GET() {
  const state = getAuthState();
  // Proactively detect an expired token even when no data call is being made:
  // revalidate on a bounded interval while a credential is installed.
  if (state.connected && !state.expired && store.token && (!state.checkedAt || Date.now() - state.checkedAt > RECHECK_MS)) {
    const v = await validateToken(store.token);
    markValidation(v.valid, v.userName, v.error);
    return NextResponse.json(getAuthState());
  }
  return NextResponse.json(state);
}

/**
 * POST { token, force? } — validate against Upstox /v2/user/profile and hold
 * the token in server memory. With force=true the token is accepted without
 * validation (flagged as unvalidated) for environments without egress.
 */
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const token = String(body.token ?? "").trim();
  const force = body.force === true;
  if (token.length < 10) {
    return NextResponse.json({ ...getAuthState(), ok: false, error: "Token looks too short — paste the full access token from the Upstox developer console." }, { status: 400 });
  }

  let validation = { valid: false, userName: null as string | null, error: null as string | null };
  if (!force) {
    validation = await validateToken(token);
    if (!validation.valid) {
      return NextResponse.json({
        ...getAuthState(),
        ok: false,
        attempted: true,
        error: validation.error ?? "validation failed",
        canForce: true,
      }, { status: 200 });
    }
  }

  const state = setRuntimeToken(token, {
    validated: validation.valid,
    userName: validation.userName,
    error: force ? "Connected without validation (forced) — data correctness is not guaranteed; live-only paths will surface API errors honestly." : null,
  });
  invalidateScanCache();
  return NextResponse.json({ ...state, ok: true });
}

/** DELETE — forget the runtime token and clear the discovered universe. */
export async function DELETE() {
  clearRuntimeToken();
  setUniverse([], "NONE");
  invalidateScanCache();
  return NextResponse.json({ ...getAuthState(), ok: true });
}

/** PUT — re-validate the current token. */
export async function PUT() {
  const state = getAuthState();
  if (!state.connected) return NextResponse.json({ ...state, ok: false, error: "no token connected" }, { status: 400 });
  return NextResponse.json({ ...state, ok: true, note: "Token source is " + state.source + "; re-validation happens automatically on API calls." });
}
