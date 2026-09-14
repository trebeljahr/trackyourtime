"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2, MailWarning } from "lucide-react";
import type { InvitationPreview } from "@starter/shared";

import { AuthHeader } from "@/components/auth-header";
import { Button } from "@/components/ui/button";
import {
  assignLocation,
  enterWorkspace,
  type Navigate,
} from "@/components/members/enter-workspace";
import {
  membershipErrorMessage,
  membershipRefusalOf,
  trpcErrorCode,
} from "@/components/members/membership-errors";
import { useAuth } from "@/hooks/use-auth";
import { useNativeSession } from "@/hooks/use-native-session";
import { useT } from "@/i18n/use-t";
import { signOut } from "@/lib/auth-client";
import { authPageHref } from "@/lib/safe-next";
import { trpc } from "@/lib/trpc";

/** Case and surrounding space never make two addresses different people. */
export const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? "").trim().toLowerCase() !== "" &&
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** This page's own address, which sign-in and signup return to. */
export const invitePath = (id: string): string => `/invite/?id=${encodeURIComponent(id)}`;

/**
 * An id the server cannot answer for — unknown, malformed, or from a
 * different server entirely. `BAD_REQUEST` is what a malformed id gets from
 * the input schema, and it means the same thing to the person holding it.
 */
const isUnknownInvitation = (error: unknown): boolean => {
  const code = trpcErrorCode(error);
  return code === "NOT_FOUND" || code === "BAD_REQUEST";
};

export type InviteAcceptanceProps = {
  /** Injected by tests; a full page load in the app. */
  navigate?: Navigate;
};

/**
 * The public page an invitation link opens: `/invite/?id=<id>`.
 *
 * Outside `(protected)` on purpose. The person holding the link often has no
 * account yet, and the protected layout would bounce them to /login before the
 * page could say whose workspace it is. A query parameter rather than a
 * `/invite/[id]` segment, because `output: "export"` can only serve paths it
 * generated at build time, and invitation ids do not exist then.
 *
 * What it shows comes from `invitations.preview`, which answers by id alone
 * with the workspace, the inviter, the invited address, the role and the
 * status — never who else is in the workspace. Whether the signed-in account
 * may accept is decided by the server (`invitation-email-mismatch`); the page
 * only avoids offering an Accept button the server would refuse.
 */
export function InviteAcceptance({
  navigate = assignLocation,
}: InviteAcceptanceProps): React.JSX.Element {
  const t = useT("members");
  const tc = useT("common");
  const id = (useSearchParams().get("id") ?? "").trim();

  const preview = trpc.invitations.preview.useQuery(
    { id },
    {
      enabled: id !== "",
      // An unknown id stays unknown; retrying it only delays saying so.
      retry: (failures, error) => !isUnknownInvitation(error) && failures < 2,
      refetchOnWindowFocus: false,
    },
  );

  let body: React.ReactNode;
  if (id === "" || (preview.isError && isUnknownInvitation(preview.error))) {
    body = (
      <StatusPanel
        title={t("invitePage.notFoundTitle")}
        body={t("invitePage.notFoundBody")}
        testId="invite-not-found"
      />
    );
  } else if (preview.isError) {
    body = (
      <div className="space-y-3 text-center" data-testid="invite-load-error">
        <p className="text-sm text-destructive">{t("invitePage.loadError")}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void preview.refetch()}
          data-testid="invite-retry"
        >
          {tc("actions.retry")}
        </Button>
      </div>
    );
  } else if (preview.data === undefined) {
    body = (
      <p
        className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
        data-testid="invite-loading"
      >
        <Loader2 className="size-4 animate-spin" />
        {t("invitePage.loading")}
      </p>
    );
  } else {
    body = (
      <InvitationBody
        invitation={preview.data}
        navigate={navigate}
        onStale={() => void preview.refetch()}
      />
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="mx-auto w-full max-w-md space-y-6" data-testid="invite-page">
        {/* The headline below is the subtitle: it differs per state. */}
        <AuthHeader title={t("invitePage.title")} subtitle="" />
        {body}
      </div>
    </div>
  );
}

function StatusPanel({
  title,
  body,
  testId,
  action,
}: {
  title: string;
  body: string;
  testId: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4 text-center" data-testid={testId}>
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}

function InvitationBody({
  invitation,
  navigate,
  onStale,
}: {
  invitation: InvitationPreview;
  navigate: Navigate;
  onStale: () => void;
}): React.JSX.Element {
  const t = useT("members");
  const { user, isLoading: authLoading } = useAuth();
  const { ready: sessionReady } = useNativeSession();
  const accept = trpc.invitations.accept.useMutation();
  const decline = trpc.invitations.decline.useMutation();
  const [declined, setDeclined] = React.useState(false);
  const [joining, setJoining] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const names = {
    inviter: invitation.inviterName,
    workspace: invitation.workspaceName,
  };

  if (declined) {
    return (
      <StatusPanel
        title={t("invitePage.rejectedTitle")}
        body={t("invitePage.declined")}
        testId="invite-declined"
      />
    );
  }

  if (invitation.status !== "pending") {
    const openApp = (
      <Button asChild variant="outline">
        <Link href="/track" data-testid="invite-open-app">
          {t("invitePage.openApp")}
        </Link>
      </Button>
    );
    switch (invitation.status) {
      case "expired":
        return (
          <StatusPanel
            title={t("invitePage.expiredTitle")}
            body={t("invitePage.expiredBody", names)}
            testId="invite-expired"
          />
        );
      case "canceled":
        return (
          <StatusPanel
            title={t("invitePage.canceledTitle")}
            body={t("invitePage.canceledBody", names)}
            testId="invite-canceled"
          />
        );
      case "accepted":
        return (
          <StatusPanel
            title={t("invitePage.acceptedTitle")}
            body={t("invitePage.acceptedBody", names)}
            testId="invite-accepted"
            action={openApp}
          />
        );
      case "rejected":
        return (
          <StatusPanel
            title={t("invitePage.rejectedTitle")}
            body={t("invitePage.rejectedBody", names)}
            testId="invite-rejected"
          />
        );
      default: {
        const unhandled: never = invitation.status;
        return <>{String(unhandled)}</>;
      }
    }
  }

  const next = invitePath(invitation.id);
  const headline = (
    <p className="text-center" data-testid="invite-headline">
      {t("invitePage.headline", {
        inviter: invitation.inviterName,
        email: invitation.email,
        workspace: invitation.workspaceName,
        role: invitation.role,
      })}
    </p>
  );

  // On the phone the session token comes out of the Keychain after mount, so
  // "no user yet" is not "signed out" until the store says it is ready.
  if (authLoading || !sessionReady) {
    return (
      <div className="space-y-4">
        {headline}
        <p className="flex justify-center" data-testid="invite-auth-loading">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </p>
      </div>
    );
  }

  if (user === null) {
    return (
      <div className="space-y-4" data-testid="invite-signed-out">
        {headline}
        <p className="text-center text-sm text-muted-foreground">
          {t("invitePage.signedOutHint", { email: invitation.email })}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button asChild>
            <Link
              href={authPageHref("login", { next, email: invitation.email })}
              data-testid="invite-sign-in"
            >
              {t("invitePage.signIn")}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link
              href={authPageHref("signup", { next, email: invitation.email })}
              data-testid="invite-create-account"
            >
              {t("invitePage.createAccount")}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!sameEmail(user.email, invitation.email)) {
    const switchAccount = async (): Promise<void> => {
      await signOut();
      navigate(authPageHref("login", { next, email: invitation.email }));
    };
    return (
      <div className="space-y-4" data-testid="invite-mismatch">
        {headline}
        <div className="space-y-2 rounded-lg border border-border p-4">
          <p className="flex items-center gap-2 font-medium">
            <MailWarning className="size-4 shrink-0" />
            {t("invitePage.mismatchTitle", { email: invitation.email })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("invitePage.mismatchBody", { current: user.email, email: invitation.email })}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => void switchAccount()}
          data-testid="invite-switch-account"
        >
          {t("invitePage.switchAccount")}
        </Button>
      </div>
    );
  }

  const busy = joining || decline.isPending;

  const handleAccept = async (): Promise<void> => {
    setError(null);
    setJoining(true);
    try {
      const { workspaceId } = await accept.mutateAsync({ id: invitation.id });
      enterWorkspace(workspaceId, navigate);
    } catch (failure) {
      setJoining(false);
      setError(membershipErrorMessage(failure));
      if (membershipRefusalOf(failure) === "invitation-not-pending") onStale();
    }
  };

  const handleDecline = async (): Promise<void> => {
    setError(null);
    try {
      await decline.mutateAsync({ id: invitation.id });
      setDeclined(true);
    } catch (failure) {
      setError(membershipErrorMessage(failure));
      if (membershipRefusalOf(failure) === "invitation-not-pending") onStale();
    }
  };

  return (
    <div className="space-y-4" data-testid="invite-ready">
      {headline}
      {error !== null ? (
        <p className="text-center text-sm text-destructive" role="alert" data-testid="invite-error">
          {error}
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Button
          type="button"
          disabled={busy}
          onClick={() => void handleAccept()}
          data-testid="invite-accept"
        >
          {joining ? t("invitePage.accepting") : t("invitePage.accept")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void handleDecline()}
          data-testid="invite-decline"
        >
          {t("invitePage.decline")}
        </Button>
      </div>
    </div>
  );
}
