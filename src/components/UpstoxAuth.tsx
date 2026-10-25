"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePoll, timeAgo } from "@/lib/client/api";
import { Chip } from "@/components/ui";
import { KeyRound, LogOut, ShieldCheck, Loader2, ChevronDown, AlertTriangle } from "lucide-react";

/**
 * Upstox connect box (top-left of the header).
 * The token is sent only to this app's own /api/auth route and held in
 * server memory — it is never stored in the browser, never logged, never
 * persisted to the database.
 */
export default function UpstoxAuth({ onState }: { onState?: (s: any) => void }) {
  const { data, refresh } = usePoll("/api/auth", 12000);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canForce, setCanForce] = useState(false);
  const [promptedFor, setPromptedFor] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Portals require the document to exist; render only after hydration.
  useEffect(() => { setMounted(true); }, []);

  const expired = !!data?.expired;
  const connected = !!data?.connected && !expired;

  useEffect(() => { if (data && onState) onState(data); }, [data, onState]);

  // When the token expires, prompt for a new one automatically — once per
  // expiry event — and focus the input so the user can paste straight away.
  useEffect(() => {
    if (!expired || !data?.expiredAt) return;
    if (promptedFor === data.expiredAt) return;
    setPromptedFor(data.expiredAt);
    setOpen(true);
    setError(data.expiredReason ?? "The Upstox access token has expired.");
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [expired, data?.expiredAt, data?.expiredReason, promptedFor]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t)) return;      // the trigger button
      if (panelRef.current?.contains(t)) return;    // inside the portalled panel
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  // Escape closes the panel — important on mobile where the panel covers the screen
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const connect = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, force }),
      });
      const json = await res.json();
      if (json.ok) {
        setToken("");
        setCanForce(false);
        setOpen(false);
      } else {
        setError(json.error ?? "connection failed");
        setCanForce(!!json.canForce);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const logout = async () => {
    await fetch("/api/auth", { method: "DELETE" });
    refresh();
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => { setOpen((o) => !o); if (!open) setTimeout(() => inputRef.current?.focus(), 60); }}
        className={`flex items-center gap-1.5 sm:gap-2 h-9 sm:h-8 px-2 sm:px-2.5 rounded-md border text-[10px] sm:text-[11px] font-semibold transition-colors touch-manipulation ${
          expired
            ? "border-down/60 bg-down/15 text-down hover:bg-down/25 animate-pulse"
            : connected
              ? "border-up/50 bg-up/10 text-up hover:bg-up/15"
              : "border-warn/50 bg-warn/10 text-warn hover:bg-warn/15"
        }`}
        title={
          expired
            ? "Upstox token expired — click to enter a new access token"
            : connected
              ? `Upstox connected (${data?.source})`
              : "Connect your Upstox access token"
        }
      >
        {expired ? <AlertTriangle size={13} /> : <KeyRound size={13} />}
        {expired ? (
          <>
            <span className="hidden sm:inline">Token expired — enter new</span>
            <span className="sm:hidden">Enter token</span>
          </>
        ) : connected ? (
          <>
            <span className="hidden md:inline">{data.userName ? data.userName : "Upstox"} · {data.masked}</span>
            <span className="md:hidden">Upstox</span>
          </>
        ) : (
          <span>Connect Upstox</span>
        )}
        <ChevronDown size={11} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
      </button>

      {open && mounted && createPortal(
        <>
          {/* mobile scrim: large dismiss target + separates the panel from the
              data panels beneath. Hidden on sm+, where it floats as a popover. */}
          <div
            className="fixed inset-0 z-[290] bg-black/55 sm:hidden"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={panelRef}
            role="dialog"
          aria-modal="true"
          aria-label="Upstox access token"
          className="fixed z-[300] left-2 right-2 sm:left-3 sm:right-auto sm:top-14 sm:w-[352px] top-2 max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-4.5rem)] overflow-y-auto overscroll-contain upstox-auth-panel rounded-lg border border-line2 bg-panel2 shadow-2xl p-3 space-y-2.5">
          {!connected ? (
            <>
              {expired ? (
                <div className="flex items-start gap-2 rounded-md border border-down/45 bg-down/10 px-2.5 py-2">
                  <AlertTriangle size={14} className="text-down shrink-0 mt-0.5" />
                  <div>
                    <div className="text-[12px] font-bold text-down">Token expired</div>
                    <div className="text-[10px] text-ink2 mt-1 leading-relaxed">
                      {data?.expiredReason ?? "Upstox rejected the access token."} Live data is paused until a new token is entered.
                    </div>
                    {data?.expiredAt && (
                      <div className="text-[9px] text-ink3 mt-1 num">expired {timeAgo(data.expiredAt)} · was {data.masked}</div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <KeyRound size={14} className="text-warn" />
                  <div className="text-[12px] font-bold">Upstox access token</div>
                </div>
              )}
              <p className="text-[10px] text-ink3 leading-relaxed">
                {expired
                  ? "Generate a fresh token from the Upstox developer console (tokens expire daily) and paste it below to resume live data."
                  : <>Paste a token from the Upstox developer console (OAuth → access token). It is validated against<span className="text-ink2"> /v2/user/profile</span>, held in server memory only, and is never persisted, logged, or sent anywhere else.</>}
              </p>
              <input
                ref={inputRef}
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && token && !busy && connect(false)}
                placeholder={expired ? "Paste the NEW access token…" : "eyJ0eXAiOiJKV1QiLC…"}
                className={`w-full bg-panel3 border rounded-md px-2.5 py-2 text-[11px] font-mono outline-none placeholder:text-ink3 ${expired ? "border-down/50 focus:border-down" : "hairline2 focus:border-up/50"}`}
                autoComplete="off"
                spellCheck={false}
              />
              {!expired && error && (
                <div className="rounded-md border border-down/40 bg-down/10 px-2.5 py-2 text-[10px] text-down leading-snug">
                  {error}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => connect(false)}
                  disabled={!token || busy}
                  className={`flex-1 h-11 sm:h-8 rounded-md text-black text-[12.5px] sm:text-[11.5px] font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 ${expired ? "bg-down/90 hover:bg-down" : "bg-up/90 hover:bg-up"}`}
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                  {expired ? "Save new token & resume" : "Validate & connect"}
                </button>
                {canForce && (
                  <button
                    onClick={() => connect(true)}
                    disabled={busy}
                    className="h-8 px-2.5 rounded-md border border-warn/50 text-warn text-[10px] font-semibold hover:bg-warn/10"
                    title="Skip validation — API errors will be surfaced as data-quality states"
                  >
                    force
                  </button>
                )}
              </div>
              <div className="text-[9px] text-ink3 leading-snug">
                Live-data-only mode: with no token connected, the terminal stays idle instead of showing simulated prices.
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {data.validated ? <ShieldCheck size={14} className="text-up" /> : <AlertTriangle size={14} className="text-warn" />}
                <div className="text-[12px] font-bold">{data.userName ?? "Upstox account"}</div>
                <Chip tone="mute" className="ml-auto">{data.source}</Chip>
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                <div className="rounded border hairline bg-panel3 px-2 py-1.5"><span className="text-ink3">token</span><div className="num font-semibold">{data.masked}</div></div>
                <div className="rounded border hairline bg-panel3 px-2 py-1.5"><span className="text-ink3">validated</span><div className={`font-semibold ${data.validated ? "text-up" : "text-warn"}`}>{data.validated ? "yes" : "forced/unvalidated"}</div></div>
                <div className="rounded border hairline bg-panel3 px-2 py-1.5"><span className="text-ink3">connected</span><div className="num font-semibold">{data.connectedAt ? timeAgo(data.connectedAt) : "—"}</div></div>
                <div className="rounded border hairline bg-panel3 px-2 py-1.5"><span className="text-ink3">storage</span><div className="font-semibold">server memory only</div></div>
              </div>
              {data.validationError && <div className="text-[9.5px] text-warn leading-snug">{data.validationError}</div>}
              <button onClick={logout} className="w-full h-11 sm:h-8 rounded-md border border-down/40 text-down text-[12px] sm:text-[11px] font-semibold hover:bg-down/10 flex items-center justify-center gap-1.5">
                <LogOut size={12} /> Disconnect
              </button>
            </>
          )}
        </div>
        </>,
        document.body,
      )}
    </div>
  );
}
