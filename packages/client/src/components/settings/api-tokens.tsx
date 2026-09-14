"use client";

import * as React from "react";
import { KeyRound, Plus } from "lucide-react";
import { apiTokenDisplayId, type ApiTokenSummary } from "@starter/shared";

import { Badge } from "@/components/ui/badge";
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
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import type { ClientLocale } from "@/i18n/config";
import { formatDate } from "@/i18n/format";
import { getActiveLocale } from "@/i18n/locale-store";
import { translate } from "@/i18n/translate";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { CreateApiTokenDialog } from "./create-api-token-dialog";
import { userErrorMessage } from "@/lib/error-message";

/**
 * Absolute dates, not "3 days ago".
 *
 * A session is minutes old and reads best relatively; a token lives for months
 * and the question people actually ask of it is "which day does this stop
 * working", which a relative string cannot answer.
 */
export const formatDay = (
  iso: string,
  locale: ClientLocale = getActiveLocale(),
): string =>
  formatDate(iso, locale, "medium") || translate("common")("status.unknown");

export type ApiTokenState = "active" | "expired" | "revoked";

/**
 * Which of the three states a token is in.
 *
 * Expiry is derived rather than stored, so a token that lapsed overnight reads
 * as expired on the next render without anything having written to it.
 */
export function apiTokenState(
  token: ApiTokenSummary,
  now: number = Date.now(),
): ApiTokenState {
  if (token.revokedAt !== null) return "revoked";
  if (token.expiresAt !== null && Date.parse(token.expiresAt) <= now) {
    return "expired";
  }
  return "active";
}

/** A literal the reader types into their own tool — never translated. */
const AUTHORIZATION_HEADER = "Authorization: Bearer <token>";

// ── revoke dialog ────────────────────────────────────────────────────

type RevokeApiTokenDialogProps = {
  token: ApiTokenSummary | null;
  onOpenChange: (open: boolean) => void;
};

function RevokeApiTokenDialog({
  token,
  onOpenChange,
}: RevokeApiTokenDialogProps): React.JSX.Element {
  const utils = trpc.useUtils();
  const t = useT("settings");
  const tc = useT("common");

  const revoke = trpc.apiTokens.revoke.useMutation({
    onMutate: async ({ id }) => {
      await utils.apiTokens.list.cancel();
      const previous = utils.apiTokens.list.getData();
      // Revoked rather than removed — the row stays so the list can still say
      // this token existed and when it was turned off.
      utils.apiTokens.list.setData(undefined, (old) =>
        old?.map((item) =>
          item.id === id
            ? { ...item, revokedAt: new Date().toISOString() }
            : item,
        ),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        utils.apiTokens.list.setData(undefined, context.previous);
      }
      toast.error(
        userErrorMessage(error, translate("settings")("apiTokens.toasts.revokeFailed")),
      );
    },
    onSuccess: () => {
      toast.success(translate("settings")("apiTokens.toasts.revoked"));
    },
    onSettled: () => {
      void utils.apiTokens.list.invalidate();
    },
  });

  return (
    <Dialog open={token !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="revoke-api-token-dialog">
        <DialogHeader>
          <DialogTitle>
            {token?.name
              ? t("apiTokens.revoke.title", { name: token.name })
              : t("apiTokens.revoke.titleThisToken")}
          </DialogTitle>
          <DialogDescription>{t("apiTokens.revoke.description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="revoke-api-token-cancel"
          >
            {tc("actions.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => {
              if (!token) return;
              revoke.mutate({ id: token.id, originId: ORIGIN_ID });
              onOpenChange(false);
            }}
            data-testid="revoke-api-token-confirm"
          >
            {t("apiTokens.revoke.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── panel ────────────────────────────────────────────────────────────

/**
 * The credentials scripts and integrations use.
 *
 * Deliberately separate from Devices &amp; apps: those are the apps you signed
 * in from, this is a key you hand to something that cannot sign in at all.
 */
export function ApiTokensPanel(): React.JSX.Element {
  const tokensQuery = trpc.apiTokens.list.useQuery();
  const t = useT("settings");
  const f = useFormat();
  const [creating, setCreating] = React.useState(false);
  const [revoking, setRevoking] = React.useState<ApiTokenSummary | null>(null);

  const tokens = tokensQuery.data ?? [];

  return (
    <Card data-testid="settings-api-tokens">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("apiTokens.title")}</CardTitle>
          <CardDescription>{t("apiTokens.description")}</CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setCreating(true)}
          data-testid="create-api-token"
        >
          <Plus className="size-4" />
          {t("apiTokens.create")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {tokensQuery.isLoading ? (
          <div className="space-y-2" data-testid="api-tokens-loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : tokens.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title={t("apiTokens.empty.title")}
            description={t("apiTokens.empty.description")}
            testId="api-tokens-empty"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="api-tokens-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("apiTokens.columns.token")}</TableHead>
                  <TableHead>{t("apiTokens.columns.scopes")}</TableHead>
                  <TableHead>{t("apiTokens.columns.created")}</TableHead>
                  <TableHead>{t("apiTokens.columns.lastUsed")}</TableHead>
                  <TableHead>{t("apiTokens.columns.expires")}</TableHead>
                  <TableHead className="text-right">
                    {t("apiTokens.columns.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => {
                  const state = apiTokenState(token);
                  return (
                    <TableRow
                      key={token.id}
                      className={state === "active" ? undefined : "opacity-60"}
                      data-testid={`api-token-row-${token.id}`}
                    >
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-2">
                          <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                          {token.name}
                          {state === "revoked" ? (
                            <Badge
                              variant="secondary"
                              data-testid={`api-token-revoked-${token.id}`}
                            >
                              {t("apiTokens.states.revoked")}
                            </Badge>
                          ) : null}
                          {state === "expired" ? (
                            <Badge
                              variant="secondary"
                              data-testid={`api-token-expired-${token.id}`}
                            >
                              {t("apiTokens.states.expired")}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                          {apiTokenDisplayId(token.prefix)}
                        </span>
                      </TableCell>
                      <TableCell>
                        {token.scopes.length === 0 ? (
                          <Badge
                            variant="outline"
                            data-testid={`api-token-no-access-${token.id}`}
                          >
                            {t("apiTokens.noScopes")}
                          </Badge>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {token.scopes.map((scope) => (
                              <Badge
                                key={scope}
                                variant="outline"
                                className="font-mono"
                              >
                                {scope}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDay(token.createdAt, f.locale)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {token.lastUsedAt
                          ? formatDay(token.lastUsedAt, f.locale)
                          : t("apiTokens.never")}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {token.expiresAt
                          ? formatDay(token.expiresAt, f.locale)
                          : t("apiTokens.never")}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={state === "revoked"}
                          onClick={() => setRevoking(token)}
                          data-testid={`revoke-api-token-${token.id}`}
                        >
                          {t("apiTokens.revoke.action")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <UsingATokenHint />
      </CardContent>

      <CreateApiTokenDialog open={creating} onOpenChange={setCreating} />
      <RevokeApiTokenDialog
        token={revoking}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      />
    </Card>
  );
}

/** The half nobody can guess: how the token is actually presented. */
function UsingATokenHint(): React.JSX.Element {
  const t = useT("settings");
  return (
    <div
      className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
      data-testid="api-token-hint"
    >
      <p className="font-medium text-foreground">{t("apiTokens.hint.title")}</p>
      <p className="mt-1">
        {t.rich("apiTokens.hint.body", {
          header: AUTHORIZATION_HEADER,
          code: (chunks) => (
            <code className="font-mono text-foreground">{chunks}</code>
          ),
        })}
      </p>
    </div>
  );
}
