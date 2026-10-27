"use client";
import Link from "next/link";
import type { SyncStatus } from "@starter/core";
import type { PrivateSyncState } from "@/lib/private-workspace-sync";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
const colors: Record<SyncStatus, string> = { open: "bg-emerald-500", connecting: "bg-amber-500 animate-pulse", closed: "bg-red-500" };
/** Socket connectivity alone cannot promise private journal delivery. Pending
 * private work keeps the existing indicator amber and exposes its local count. */
export function WorkspaceSyncIndicator({ status: socket, privateSync }: { status: SyncStatus; privateSync: PrivateSyncState | null }) {
  const t = useT("shell");
  const status: SyncStatus = !privateSync ? socket : privateSync.phase === "saved" ? "open" : privateSync.phase === "conflict" || privateSync.phase === "unavailable" ? "closed" : "connecting";
  const label = privateSync ? t(`sync.private.${privateSync.phase}`, { count: privateSync.pending ?? 0 }) : t(`sync.${socket}`);
  const dot = <><span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", colors[status])} />{privateSync && (privateSync.pending ?? 0) > 0 && <span aria-hidden="true" className="hidden text-xs text-muted-foreground sm:inline">{t("sync.private.count", { count: privateSync.pending! })}</span>}</>;
  return <Tooltip><TooltipTrigger asChild>{privateSync
    ? <Link href="/app/settings/#private-workspace-backup" aria-label={label} data-testid="sync-status" data-status={status} className="flex min-h-8 min-w-6 items-center justify-center gap-2 rounded-sm underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2">{dot}</Link>
    : <span aria-label={label} data-testid="sync-status" data-status={status} className="flex size-6 items-center justify-center">{dot}</span>}
  </TooltipTrigger><TooltipContent className="max-w-xs">{label}</TooltipContent></Tooltip>;
}
