"use client";

import * as React from "react";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@starter/core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { useT } from "@/i18n/use-t";
import {
  getActiveWorkspaceSnapshot,
  getServerActiveWorkspaceSnapshot,
  subscribeActiveWorkspace,
  switchWorkspace,
  type ActiveWorkspaceSnapshot,
} from "@/lib/active-workspace";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/** The active workspace and the last known list, as a React value. */
export const useActiveWorkspace = (): ActiveWorkspaceSnapshot =>
  React.useSyncExternalStore(
    subscribeActiveWorkspace,
    getActiveWorkspaceSnapshot,
    getServerActiveWorkspaceSnapshot,
  );

/**
 * Which workspace this device tracks into, and the way to change it.
 *
 * Rendered in the header cluster on every platform and hidden — by rendering
 * nothing — for a person in one workspace, which is nearly everyone. It never
 * branches on `isCapacitor()`: the prerender and the first client render both
 * see no list (`getServerActiveWorkspaceSnapshot`), so the served HTML and the
 * hydrated tree agree on every host.
 *
 * A controlled Dialog rather than a dropdown: `ui/dialog.tsx` registers a
 * controlled dialog on the overlay stack, so Android's back button closes it,
 * and on a 393pt phone header a list of workspace names with roles fits a
 * top-anchored sheet far better than a popover hanging off a 32px button.
 *
 * Switching is `switchWorkspace` in `lib/active-workspace.ts`: it points every
 * later request at the new workspace and resets the workspace-scoped caches,
 * so nothing from the old workspace is rendered under the new name. The
 * extension and Raycast keep their own choice and are unaffected.
 */
export function WorkspaceSwitcher(): React.JSX.Element | null {
  const t = useT("shell");
  const queryClient = useQueryClient();
  const setActive = trpc.workspaces.setActive.useMutation();
  const { activeId, workspaces } = useActiveWorkspace();
  const [open, setOpen] = React.useState(false);

  if (workspaces === null || workspaces.length <= 1) return null;

  const active = workspaces.find((workspace) => workspace.id === activeId) ?? null;

  const choose = async (workspace: WorkspaceSummary): Promise<void> => {
    setOpen(false);
    if (workspace.id === activeId) return;
    await switchWorkspace(workspace.id, {
      queryClient,
      setActive: (workspaceId) => setActive.mutateAsync({ workspaceId }),
    });
    toast.success(t("workspace.switched", { name: workspace.name }));
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="h-8 min-w-0 max-w-32 gap-1.5 px-2 sm:max-w-48"
        onClick={() => setOpen(true)}
        aria-label={
          active === null
            ? t("workspace.open")
            : t("workspace.current", { name: active.name })
        }
        aria-haspopup="dialog"
        data-testid="workspace-switcher"
        data-workspace-id={activeId ?? ""}
      >
        <Building2 className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate text-sm">{active?.name ?? t("workspace.open")}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="workspace-switcher-dialog">
          <DialogHeader>
            <DialogTitle>{t("workspace.title")}</DialogTitle>
            <DialogDescription>{t("workspace.description")}</DialogDescription>
          </DialogHeader>
          <ul className="grid gap-1" role="list">
            {workspaces.map((workspace) => {
              const current = workspace.id === activeId;
              return (
                <li key={workspace.id}>
                  <button
                    type="button"
                    onClick={() => {
                      void choose(workspace);
                    }}
                    aria-current={current ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-accent",
                      current && "border-border bg-accent/60",
                    )}
                    data-testid="workspace-option"
                    data-workspace-id={workspace.id}
                  >
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate text-sm font-medium">
                        {workspace.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t(`workspace.roles.${workspace.role}`)}
                        {" · "}
                        {t("workspace.members", { count: workspace.memberCount })}
                      </span>
                    </span>
                    {current ? (
                      <Check
                        className="size-4 shrink-0"
                        aria-label={t("workspace.active")}
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
