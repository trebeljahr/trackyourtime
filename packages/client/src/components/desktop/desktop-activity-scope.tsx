"use client";

import * as React from "react";

import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { useAuth } from "@/hooks/use-auth";
import { useIsElectron } from "@/hooks/use-shell";
import { desktopActivity } from "@/lib/desktop-activity";

/**
 * Tells the desktop app whose activity it is recording: the signed-in person
 * and the workspace the screens are showing (the switcher's choice, never the
 * session default). Renders nothing.
 *
 * Main records nothing until it has a scope, and moving to another account
 * deletes the previous one's rows there — so a scope is sent only when BOTH
 * halves are resolved. A pending session, or a cold offline launch where the
 * workspace list never answers, sends nothing and leaves the last scope in
 * place: "we do not know yet" is not "somebody else". Clearing it is
 * `forget()`, from the sign-out and account-deletion cleanup, and nothing else.
 */
export function DesktopActivityScope(): null {
  const electron = useIsElectron();
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const userId = user?.id ?? null;
  const workspaceId = workspace?.id ?? null;

  React.useEffect(() => {
    if (!electron || userId === null || workspaceId === null) return;
    const activity = desktopActivity();
    if (activity === null) return;
    void activity.setScope({ userId, workspaceId }).catch(() => undefined);
  }, [electron, userId, workspaceId]);

  return null;
}
