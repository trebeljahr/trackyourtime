"use client";
import * as React from "react";
import { privateDeviceUrl, PrivateDeviceCodeError } from "@starter/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createPrivateDeviceUnlock, privateDeviceWebOrigin, PrivateDeviceWebOriginError } from "@/lib/private-device";
import { privateDataOrigin } from "@/lib/private-session";
import { isElectron } from "@/lib/shell";
import { trpc } from "@/lib/trpc";
import { useT } from "@/i18n/use-t";
type Request = Awaited<ReturnType<typeof createPrivateDeviceUnlock>>;
const openBrowser = async (url: string) => {
  if (isElectron()) {
    if (!await window.electronAPI?.openExternal(url)) throw new Error("Could not open browser");
  } else {
    const { AppLauncher } = await import("@capacitor/app-launcher");
    await AppLauncher.openUrl({ url });
  }
};
export function PrivateDeviceUnlock({ userId }: { userId: string }): React.JSX.Element {
  const t = useT("settings");
  const createRequest = trpc.privacy.createDeviceUnlock.useMutation().mutateAsync;
  const pollStatus = trpc.privacy.deviceUnlockStatus.useMutation().mutateAsync;
  const cancelRequest = trpc.privacy.cancelDeviceUnlock.useMutation().mutateAsync;
  const request = React.useRef<Request | null>(null), url = React.useRef<string | null>(null);
  const [phase, setPhase] = React.useState<"idle" | "starting" | "waiting" | "confirm">("idle");
  const [code, setCode] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [problem, setProblem] = React.useState<"failed" | "codeMismatch" | "expired" | "browserAddress" | null>(null);
  const generation = React.useRef(0);
  const discard = React.useCallback(() => {
    generation.current++;
    setConfirming(false);
    const current = request.current; request.current = null; url.current = null; current?.cancel();
    if (current && current.invite.server === privateDataOrigin()) void cancelRequest({ requestId: current.invite.requestId }).catch(() => undefined);
  }, [cancelRequest]);
  // A ref avoids restarting a pending poll merely because mutation observers
  // published their loading state. Each iteration captures its request identity.
  const discardRef = React.useRef(discard);
  React.useLayoutEffect(() => { discardRef.current = discard; });
  React.useEffect(() => () => discardRef.current(), []);
  React.useEffect(() => {
    if (phase !== "waiting") return;
    const current = request.current; if (!current) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!active || request.current !== current) return;
      if (Date.now() >= current.invite.expiresAt) { discardRef.current(); setPhase("idle"); setProblem("expired"); return; }
      try {
        const reply = await pollStatus({ requestId: current.invite.requestId });
        if (!active || request.current !== current) return;
        if (reply.box) { await current.accept(reply.box); if (active && request.current === current) setPhase("confirm"); return; }
      } catch {
        if (active && request.current === current) { discardRef.current(); setPhase("idle"); setProblem("failed"); }
        return;
      }
      if (active) timer = setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [phase, pollStatus]);
  // Expiry also applies after delivery while the person reads the browser code.
  React.useEffect(() => {
    const current = request.current; if (!current || phase === "idle") return;
    const timer = setTimeout(() => { if (request.current === current) { discardRef.current(); setPhase("idle"); setProblem("expired"); } }, Math.max(0, current.invite.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [phase]);
  const start = async () => {
    discard(); const at = generation.current; setPhase("starting"); setProblem(null); setCode("");
    try {
      const web = privateDeviceWebOrigin();
      const next = await createPrivateDeviceUnlock(userId);
      if (at !== generation.current) { next.cancel(); return; }
      request.current = next;
      await createRequest({ requestId: next.invite.requestId, publicKey: next.invite.publicKey });
      if (at !== generation.current) return;
      const target = privateDeviceUrl(web, next.invite); url.current = target;
      await openBrowser(target);
      if (at === generation.current) setPhase("waiting");
    } catch (error) { if (at === generation.current) { discard(); setPhase("idle"); setProblem(error instanceof PrivateDeviceWebOriginError ? "browserAddress" : "failed"); } }
  };
  return <section className="space-y-2" data-testid="private-device-unlock">
    {phase === "idle" && <Button variant="outline" onClick={() => void start()}>{t("privateDevice.start")}</Button>}
    {phase === "starting" && <p role="status" className="text-sm">{t("privateDevice.starting")}</p>}
    {phase === "waiting" && <><p role="status" className="text-sm">{t("privateDevice.waiting")}</p><Button variant="outline" size="sm" onClick={() => { if (url.current) void openBrowser(url.current).catch(() => setProblem("failed")); }}>{t("privateDevice.reopen")}</Button></>}
    {phase === "confirm" && <div className="max-w-xs space-y-2">
      <Label htmlFor="private-device-code">{t("privateDevice.codeLabel")}</Label>
      <Input id="private-device-code" autoComplete="one-time-code" spellCheck={false} disabled={confirming} maxLength={9} value={code} onChange={(event) => setCode(event.target.value)} />
      <Button variant="outline" disabled={confirming || !/^[0-9a-fA-F]{8}$/.test(code.replace(/\s/g, ""))} onClick={async () => {
        const current = request.current, at = generation.current; setConfirming(true);
        try { if (!current) throw new Error("Private-device request is closed"); await current.confirm(code); if (at !== generation.current) return; discard(); setPhase("idle"); setCode(""); }
        catch (error) {
          if (at !== generation.current) return;
          if (error instanceof PrivateDeviceCodeError && !error.closed) { setProblem("codeMismatch"); setCode(""); }
          else { discard(); setPhase("idle"); setProblem(error instanceof PrivateDeviceCodeError ? "codeMismatch" : "failed"); }
        }
        finally { if (at === generation.current) setConfirming(false); }
      }}>{t("privateDevice.confirm")}</Button>
    </div>}
    {phase !== "idle" && <Button variant="ghost" size="sm" onClick={() => { discard(); setPhase("idle"); setCode(""); setProblem(null); }}>{t("privateDevice.cancel")}</Button>}
    {problem && <p role="alert" className="text-sm text-destructive">{t(`privateDevice.${problem}`)}</p>}
  </section>;
}
