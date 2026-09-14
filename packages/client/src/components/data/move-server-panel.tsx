"use client";

import * as React from "react";
import { ArrowRightLeft, CheckCircle2, Download, Loader2, TriangleAlert } from "lucide-react";
import {
  AuthError,
  CLOUD_API_ORIGIN,
  CLOUD_SERVER_LABEL,
  checkServer,
  createApiClient,
  describeServerVersion,
  normalizeServerInput,
  sameServerOrigin,
  serverHost,
  serverLabel,
  signInWithPassword,
  signOutSession,
  signUpWithPassword,
  type ClientId,
  type ServerInfo,
} from "@starter/core";
import {
  formatDurationShort,
  type ImportInput,
  type ImportResult,
  type WorkspaceExportInfo,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { canDownloadFiles } from "@/components/reports/export-menu";
import { useIsNative } from "@/hooks/use-is-native";
import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { downloadBlob } from "@/lib/download";
import {
  exportMoveParts,
  moveWorkspace,
  movePartFilename,
  type MoveProgress,
  type MoveReport,
  type MoveSource,
  type MoveTarget,
} from "@/lib/server-move";
import { switchServer } from "@/lib/server-switch";
import { trpc } from "@/lib/trpc";

/**
 * Settings → Data → "Move to another server".
 *
 * Hosted to self-hosted, or back, in a few clicks: pick the server, sign in
 * there, copy. Two routes, chosen by what the target server will allow:
 *
 *  - **Direct.** This client signs in to the target with its own bearer
 *    session and imports there, part by part, while it still holds its session
 *    here. Possible whenever the target trusts this client's origin — always
 *    for the phone apps against a self-host with the defaults, and for the web
 *    app when the target lists its address. The target's `/api/health` says
 *    which (`originTrusted`), before anyone types a password.
 *  - **Through a file.** When the target does not trust this web page's
 *    origin — the usual case between a hosted web app and somebody's own
 *    server — the browser cannot talk to it at all. The same parts are saved
 *    as files instead, and imported on the other server's own Settings → Data.
 *
 * Nothing on the source is changed or deleted, on either route. A move is a
 * copy; leaving the old data behind is the person's decision to make after
 * they have seen the numbers on the new server.
 */

type Step =
  | { kind: "target" }
  | { kind: "account"; server: ServerInfo }
  | { kind: "ready"; server: ServerInfo; token: string; info: TargetInfo }
  | { kind: "copying"; server: ServerInfo; progress: MoveProgress | null }
  | { kind: "done"; server: ServerInfo; token: string; report: MoveReport }
  | { kind: "file"; server: ServerInfo; reason: FileReason };

type FileReason = "untrusted" | "blocked";

type TargetInfo = { entries: number };

const MOVE_ACCOUNT_LABEL = "Move to another server";

const count = (value: number): string => value.toLocaleString("en-US");

const plural = (value: number, one: string, many: string): string =>
  `${count(value)} ${value === 1 ? one : many}`;

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/** A fetch that never reached the server — CORS refusals included. */
const isTransportError = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof Error && /failed to fetch|load failed|networkerror/i.test(error.message));

export function MoveServerPanel(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const here = serverLabel(getAbsoluteApiOrigin());

  return (
    <Card data-testid="move-server-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft className="size-4" />
          Move to another server
        </CardTitle>
        <CardDescription>
          Copy this workspace from {here} to another Track Your Time server —
          your own, or {CLOUD_SERVER_LABEL}. Entries, clients, projects, tasks,
          tags, workspace settings and your pinned quick starts arrive; nothing
          here is changed or deleted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(true)}
          data-testid="move-server-open"
        >
          <ArrowRightLeft className="size-4" />
          Move my data…
        </Button>
      </CardContent>
      {open ? <MoveServerDialog onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

function MoveServerDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const native = useIsNative();
  const utils = trpc.useUtils();
  const currentOrigin = getAbsoluteApiOrigin();
  const here = serverLabel(currentOrigin);
  const clientId: ClientId = native ? "trackyourtime-mobile" : "web";

  const [step, setStep] = React.useState<Step>({ kind: "target" });
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const sourceInfo = trpc.data.exportInfo.useQuery({});
  const running = trpc.entries.current.useQuery(undefined);

  const source: MoveSource = React.useMemo(
    () => ({
      countEntries: async (range) =>
        (await utils.client.data.exportInfo.query(range)).entries,
      exportJson: (range) => utils.client.data.exportJson.mutate(range),
    }),
    [utils],
  );

  const targetClient = React.useCallback(
    (server: ServerInfo, token: string) => {
      const api = createApiClient({ baseUrl: server.origin, token, clientId });
      const target: MoveTarget = {
        countEntries: async () =>
          (await api.query<WorkspaceExportInfo>("data.exportInfo", {})).entries,
        commit: (input: ImportInput) => api.mutate<ImportResult>("data.commit", input),
      };
      return target;
    },
    [clientId],
  );

  /** Leave the target's session behind when this device is not going there. */
  const releaseTarget = React.useCallback(
    (current: Step): void => {
      if (current.kind === "ready" || current.kind === "done") {
        void signOutSession({ baseUrl: current.server.origin, clientId }, current.token);
      }
    },
    [clientId],
  );

  const close = (): void => {
    if (busy) return;
    releaseTarget(step);
    onClose();
  };

  // ── step 1: which server ───────────────────────────────────────────

  const [mode, setMode] = React.useState<"cloud" | "own">(
    sameServerOrigin(currentOrigin, CLOUD_API_ORIGIN) ? "own" : "cloud",
  );
  const [address, setAddress] = React.useState("");

  const checkTarget = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    let origin = CLOUD_API_ORIGIN;
    if (mode === "own") {
      const parsed = normalizeServerInput(address);
      if (!parsed.ok) {
        setError(parsed.message);
        return;
      }
      origin = parsed.origin;
    }
    if (sameServerOrigin(origin, currentOrigin)) {
      setError(`That is ${here}, the server this workspace is already on.`);
      return;
    }

    setBusy(true);
    try {
      const result = await checkServer(origin);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.server.originTrusted === false) {
        if (native) {
          setError(
            `${serverHost(origin)} does not accept sign-ins from this app yet. Its administrator needs to set TRUST_STORE_APPS=true, or add capacitor://localhost and https://localhost to TRUSTED_ORIGINS.`,
          );
          return;
        }
        setStep({ kind: "file", server: result.server, reason: "untrusted" });
        return;
      }
      setStep({ kind: "account", server: result.server });
    } finally {
      setBusy(false);
    }
  };

  // ── step 2: an account on the target ───────────────────────────────

  const [authMode, setAuthMode] = React.useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  const signInToTarget = async (event: React.FormEvent, server: ServerInfo): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const options = { baseUrl: server.origin, clientId };
    try {
      const issued =
        authMode === "sign-in"
          ? await signInWithPassword(options, { email, password })
          : await signUpWithPassword(options, { name, email, password });
      const entries = await targetClient(server, issued.token).countEntries();
      setPassword("");
      setStep({ kind: "ready", server, token: issued.token, info: { entries } });
    } catch (caught) {
      if (!native && isTransportError(caught)) {
        // The health check could not say (an older server), and the browser
        // refused the cross-origin sign-in. A file still works.
        setStep({ kind: "file", server, reason: "blocked" });
        return;
      }
      setError(
        caught instanceof AuthError
          ? caught.message
          : errorText(caught, `Could not sign in to ${serverHost(server.origin)}.`),
      );
    } finally {
      setBusy(false);
    }
  };

  // ── step 3: copy ───────────────────────────────────────────────────

  const copy = async (server: ServerInfo, token: string): Promise<void> => {
    setError(null);
    setBusy(true);
    setStep({ kind: "copying", server, progress: null });
    try {
      const report = await moveWorkspace({
        source,
        target: targetClient(server, token),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        onProgress: (progress) =>
          setStep({ kind: "copying", server, progress }),
      });
      setStep({ kind: "done", server, token, report });
    } catch (caught) {
      setError(errorText(caught, "The move stopped."));
      const entries = await targetClient(server, token)
        .countEntries()
        .catch(() => 0);
      setStep({ kind: "ready", server, token, info: { entries } });
    } finally {
      setBusy(false);
    }
  };

  // ── the file route ─────────────────────────────────────────────────

  const [saved, setSaved] = React.useState<number | null>(null);

  const downloadParts = async (): Promise<void> => {
    if (!canDownloadFiles()) {
      setError("This app cannot save files. Open Track Your Time in a browser to move through a file.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const parts = await exportMoveParts(source);
      const stamp = new Date().toISOString().slice(0, 10);
      for (const [index, part] of parts.entries()) {
        downloadBlob(
          movePartFilename(index, parts.length, stamp),
          new Blob([part.text], { type: "application/json" }),
        );
      }
      setSaved(parts.length);
    } catch (caught) {
      setError(errorText(caught, "Could not export this workspace."));
    } finally {
      setBusy(false);
    }
  };

  // ── render ─────────────────────────────────────────────────────────

  const exportable = sourceInfo.data?.entries ?? null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="move-server-dialog">
        <DialogHeader>
          <DialogTitle>{MOVE_ACCOUNT_LABEL}</DialogTitle>
          <DialogDescription>
            From {here}
            {"server" in step ? ` to ${serverLabel(step.server.origin)}` : ""}.
          </DialogDescription>
        </DialogHeader>

        {step.kind === "target" ? (
          <form className="space-y-4" onSubmit={(event) => void checkTarget(event)}>
            <div role="radiogroup" aria-label="Move to" className="space-y-2 text-sm">
              {sameServerOrigin(currentOrigin, CLOUD_API_ORIGIN) ? null : (
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="move-target"
                    checked={mode === "cloud"}
                    onChange={() => setMode("cloud")}
                    data-testid="move-target-cloud"
                  />
                  {CLOUD_SERVER_LABEL}
                </label>
              )}
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="move-target"
                  checked={mode === "own"}
                  onChange={() => setMode("own")}
                  data-testid="move-target-own"
                />
                My own server
              </label>
            </div>
            {mode === "own" ? (
              <div className="space-y-2">
                <Label htmlFor="move-target-address">Server address</Label>
                <Input
                  id="move-target-address"
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="https://track.example.com"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  data-testid="move-target-address"
                />
              </div>
            ) : null}
            <MoveError message={error} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || (mode === "own" && address.trim() === "")}
                data-testid="move-target-check"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Check server
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step.kind === "account" ? (
          <form
            className="space-y-4"
            onSubmit={(event) => void signInToTarget(event, step.server)}
          >
            <ServerFound server={step.server} />
            <p className="text-sm text-muted-foreground">
              {authMode === "sign-in"
                ? `Sign in to your account on ${serverLabel(step.server.origin)}. The data is copied into that account's workspace.`
                : `Create an account on ${serverLabel(step.server.origin)} to copy the data into.`}
            </p>
            {authMode === "sign-up" ? (
              <div className="space-y-2">
                <Label htmlFor="move-name">Name</Label>
                <Input
                  id="move-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  data-testid="move-account-name"
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="move-email">Email</Label>
              <Input
                id="move-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                data-testid="move-account-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="move-password">Password</Label>
              <Input
                id="move-password"
                type="password"
                autoComplete={authMode === "sign-in" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                data-testid="move-account-password"
              />
            </div>
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              onClick={() => {
                setAuthMode(authMode === "sign-in" ? "sign-up" : "sign-in");
                setError(null);
              }}
              data-testid="move-account-toggle"
            >
              {authMode === "sign-in"
                ? "No account there yet? Create one"
                : "Already have an account there? Sign in"}
            </button>
            <MoveError message={error} />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setStep({ kind: "target" });
                  setError(null);
                }}
              >
                Back
              </Button>
              <Button type="submit" disabled={busy} data-testid="move-account-submit">
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {authMode === "sign-in" ? "Sign in" : "Create account"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step.kind === "ready" ? (
          <div className="space-y-4 text-sm">
            <ServerFound server={step.server} />
            <ul className="list-disc space-y-1 pl-5">
              <li data-testid="move-ready-count">
                {exportable === null
                  ? "Counting the entries to copy…"
                  : `${plural(exportable, "finished entry", "finished entries")} will be copied from ${here}.`}
              </li>
              {step.info.entries > 0 ? (
                <li data-testid="move-ready-target-busy">
                  The workspace on {serverLabel(step.server.origin)} already
                  has {plural(step.info.entries, "entry", "entries")}. Entries
                  already there are skipped, and its workspace settings are
                  left as they are.
                </li>
              ) : (
                <li>
                  Workspace settings — currency, rates, week start — come
                  along too.
                </li>
              )}
              <li>
                Clients, projects, tasks and tags arrive with the entries that
                use them. Issued invoices are not re-created.
              </li>
              {running.data ? (
                <li className="text-destructive" data-testid="move-ready-running">
                  A timer is running. It is not copied until it is stopped.
                </li>
              ) : null}
              {sourceInfo.data?.moneyRedacted ? (
                <li className="text-destructive" data-testid="move-ready-redacted">
                  Your role does not include other members&rsquo; money, so
                  every rate is left out of the copy.
                </li>
              ) : null}
            </ul>
            <MoveError message={error} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={busy || exportable === 0}
                onClick={() => void copy(step.server, step.token)}
                data-testid="move-copy"
              >
                Copy to {serverLabel(step.server.origin)}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step.kind === "copying" ? (
          <p className="flex items-center gap-2 text-sm" role="status" data-testid="move-copying">
            <Loader2 className="size-4 animate-spin" />
            {step.progress === null
              ? "Getting ready…"
              : step.progress.phase === "exporting"
                ? `Exporting from ${here} (part ${step.progress.done} of ${step.progress.total})…`
                : `Importing on ${serverLabel(step.server.origin)} (part ${Math.min(step.progress.done + 1, step.progress.total)} of ${step.progress.total})…`}
          </p>
        ) : null}

        {step.kind === "done" ? (
          <MoveDone
            report={step.report}
            server={step.server}
            here={here}
            native={native}
            onSwitch={async () => {
              setBusy(true);
              await switchServer(
                {
                  origin: step.server.origin,
                  webUrl: step.server.webUrl,
                  release: step.server.release,
                },
                { token: step.token },
              );
            }}
            onClose={close}
            busy={busy}
          />
        ) : null}

        {step.kind === "file" ? (
          <div className="space-y-4 text-sm" data-testid="move-file">
            <ServerFound server={step.server} />
            <p>
              {step.reason === "untrusted"
                ? `${serverLabel(step.server.origin)} does not accept requests from this page's address (${window.location.origin}), so the data goes across in a file.`
                : `Your browser could not sign in to ${serverLabel(step.server.origin)} from this page, so the data goes across in a file.`}
            </p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void downloadParts()}
                  data-testid="move-file-download"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                  Download the move file
                </Button>
                {saved !== null ? (
                  <span className="ml-2 text-muted-foreground" data-testid="move-file-saved">
                    {saved === 1 ? "Saved 1 file." : `Saved ${saved} files — import all of them.`}
                  </span>
                ) : null}
              </li>
              <li>
                Open{" "}
                {step.server.webUrl ? (
                  <a
                    href={`${step.server.webUrl.replace(/\/+$/, "")}/settings/?tab=data`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                    data-testid="move-file-target-link"
                  >
                    {serverHost(step.server.webUrl)}
                  </a>
                ) : (
                  serverLabel(step.server.origin)
                )}{" "}
                and sign in, or create an account.
              </li>
              <li>
                In Settings → Data → Import your history, choose the file and
                import it. The preview shows the entries before anything is
                written.
              </li>
            </ol>
            <p className="text-muted-foreground">
              To copy directly next time, add {window.location.origin} to that
              server&apos;s TRUSTED_ORIGINS.
            </p>
            <MoveError message={error} />
            <DialogFooter>
              <Button type="button" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ServerFound({ server }: { server: ServerInfo }): React.JSX.Element {
  return (
    <p className="text-sm text-muted-foreground" data-testid="move-server-found">
      Found {describeServerVersion(server)} at {serverHost(server.origin)}.
    </p>
  );
}

function MoveError({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null;
  return (
    <p className="text-sm text-destructive" role="alert" data-testid="move-error">
      {message}
    </p>
  );
}

function MoveDone({
  report,
  server,
  here,
  native,
  onSwitch,
  onClose,
  busy,
}: {
  report: MoveReport;
  server: ServerInfo;
  here: string;
  native: boolean;
  onSwitch: () => Promise<void>;
  onClose: () => void;
  busy: boolean;
}): React.JSX.Element {
  const there = serverLabel(server.origin);
  const missing = report.entriesExported - report.entriesCreated - report.entriesSkipped;
  const rows: Array<[string, string, string]> = [
    ["Entries copied", count(report.entriesCreated), "move-done-entries"],
    ["Entries already there", count(report.entriesSkipped), "move-done-skipped"],
    ["Clients", count(report.clientsCreated), "move-done-clients"],
    ["Projects", count(report.projectsCreated), "move-done-projects"],
    ["Tasks", count(report.tasksCreated), "move-done-tasks"],
    ["Tags", count(report.tagsCreated), "move-done-tags"],
    ["Pinned quick starts", count(report.favoritesCreated), "move-done-favorites"],
    ["Workspace settings", report.settingsRestored ? "Restored" : "Left as they were", "move-done-settings"],
  ];

  return (
    <div className="space-y-4 text-sm" data-testid="move-done">
      {report.complete ? (
        <p className="flex items-center gap-2 font-medium" data-testid="move-done-complete">
          <CheckCircle2 className="size-4 text-primary" />
          All {plural(report.entriesExported, "entry is", "entries are")} on {there}
          {report.totalSec > 0 ? ` — ${formatDurationShort(report.totalSec)} of tracked time copied` : ""}.
        </p>
      ) : (
        <p className="flex items-center gap-2 font-medium text-destructive" data-testid="move-done-incomplete">
          <TriangleAlert className="size-4" />
          {plural(missing, "entry", "entries")} of {count(report.entriesExported)} did not
          arrive. Run the move again — entries already there are skipped.
        </p>
      )}
      <table className="w-full text-left">
        <tbody>
          {rows.map(([label, value, testId]) => (
            <tr key={testId} className="border-b last:border-b-0">
              <th scope="row" className="py-1 font-normal text-muted-foreground">
                {label}
              </th>
              <td className="py-1 text-right tabular-nums" data-testid={testId}>
                {value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted-foreground">
        Nothing on {here} was changed. Delete it there once you have checked
        the data on {there}.
      </p>
      <DialogFooter className="flex-wrap gap-2">
        {native ? (
          <>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Stay on {here}
            </Button>
            <Button
              type="button"
              onClick={() => void onSwitch()}
              disabled={busy}
              data-testid="move-done-switch"
            >
              Switch this device to {there}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={onClose}>
              Done
            </Button>
            {server.webUrl ? (
              <Button asChild>
                <a
                  href={server.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="move-done-open"
                >
                  Open {serverHost(server.webUrl)}
                </a>
              </Button>
            ) : null}
          </>
        )}
      </DialogFooter>
    </div>
  );
}
