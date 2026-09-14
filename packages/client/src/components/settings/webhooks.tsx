"use client";

import * as React from "react";
import { Plus, Webhook } from "lucide-react";
import type {
  WebhookDeliveryStatus,
  WebhookDeliveryWire,
  WebhookSubscriptionWire,
} from "@starter/shared";

import { Badge, type BadgeProps } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
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
import type { Translator } from "@/i18n/translator";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { CreateWebhookDialog } from "./create-webhook-dialog";
import { userErrorMessage } from "@/lib/error-message";

/** Deliveries are minutes old, so they read as a moment rather than a day. */
const formatMoment = (iso: string, locale: ClientLocale): string =>
  formatDate(iso, locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }) || translate("common")("status.unknown");

export type WebhookHealth = {
  label: string;
  variant: BadgeProps["variant"];
  /** Why it is in that state, when the label alone cannot say. */
  detail: string | null;
};

/**
 * The state of one endpoint, and the reason for it.
 *
 * An endpoint that turned itself off after repeated failures is the failure
 * mode people find weeks later, when the data they thought was syncing is
 * already wrong — so the row says both that it is off and what turned it off.
 *
 * `t` defaults to the active locale for callers outside a component; a
 * component passes its own `useT("settings")`.
 */
export function webhookHealth(
  subscription: WebhookSubscriptionWire,
  t: Translator<"settings"> = translate("settings"),
): WebhookHealth {
  const count = subscription.consecutiveFailures;
  if (!subscription.enabled && subscription.disabledAt !== null) {
    return {
      label: t("webhooks.health.turnedOff"),
      variant: "destructive",
      detail: t("webhooks.health.turnedOffDetail", { count }),
    };
  }
  if (!subscription.enabled) {
    return { label: t("webhooks.health.paused"), variant: "secondary", detail: null };
  }
  if (count > 0) {
    return {
      label: t("webhooks.health.failing"),
      variant: "destructive",
      detail: t("webhooks.health.failingDetail", { count }),
    };
  }
  return { label: t("webhooks.health.active"), variant: "secondary", detail: null };
}

const DELIVERY_STATUS_VARIANTS: Record<WebhookDeliveryStatus, BadgeProps["variant"]> = {
  pending: "outline",
  delivered: "secondary",
  failed: "destructive",
  // Not a failure: the payload was about time the subscription's owner is not
  // allowed to see, so it was dropped rather than retried forever.
  skipped_visibility: "outline",
};

const DELIVERY_STATUS_KEYS = {
  pending: "webhooks.deliveryStatus.pending",
  delivered: "webhooks.deliveryStatus.delivered",
  failed: "webhooks.deliveryStatus.failed",
  skipped_visibility: "webhooks.deliveryStatus.skippedVisibility",
} as const satisfies Record<WebhookDeliveryStatus, string>;

/** The badge for one delivery status. */
export function deliveryStatusBadge(
  status: WebhookDeliveryStatus,
  t: Translator<"settings"> = translate("settings"),
): { label: string; variant: BadgeProps["variant"] } {
  return { label: t(DELIVERY_STATUS_KEYS[status]), variant: DELIVERY_STATUS_VARIANTS[status] };
}

/** The one line of detail a delivery row can offer beyond its status. */
export function deliveryDetail(
  delivery: WebhookDeliveryWire,
  t: Translator<"settings"> = translate("settings"),
  locale: ClientLocale = getActiveLocale(),
): string {
  if (delivery.status === "skipped_visibility") {
    return t("webhooks.deliveries.skippedDetail");
  }
  // The error is a machine code from the server, shown as it is.
  if (delivery.error) return delivery.error;
  if (delivery.responseStatus !== null) {
    return t("webhooks.deliveries.httpStatus", { status: String(delivery.responseStatus) });
  }
  if (delivery.status === "pending" && delivery.nextAttemptAt) {
    return t("webhooks.deliveries.nextTry", {
      when: formatMoment(delivery.nextAttemptAt, locale),
    });
  }
  return "—";
}

// ── deliveries ───────────────────────────────────────────────────────

type DeliveriesDialogProps = {
  subscription: WebhookSubscriptionWire | null;
  onOpenChange: (open: boolean) => void;
};

function DeliveriesDialog({
  subscription,
  onOpenChange,
}: DeliveriesDialogProps): React.JSX.Element {
  const deliveriesQuery = trpc.webhooks.deliveries.useQuery(
    { subscriptionId: subscription?.id ?? "" },
    { enabled: subscription !== null },
  );
  const t = useT("settings");
  const tc = useT("common");
  const f = useFormat();

  const deliveries = deliveriesQuery.data?.deliveries ?? [];

  return (
    <Dialog open={subscription !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="webhook-deliveries-dialog">
        <DialogHeader>
          <DialogTitle>{t("webhooks.deliveries.title")}</DialogTitle>
          <DialogDescription>
            {t.rich("webhooks.deliveries.description", {
              url: subscription?.url ?? "",
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </DialogDescription>
        </DialogHeader>

        {deliveriesQuery.isLoading ? (
          <div className="space-y-2" data-testid="webhook-deliveries-loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : deliveries.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title={t("webhooks.deliveries.empty.title")}
            description={t("webhooks.deliveries.empty.description")}
            testId="webhook-deliveries-empty"
          />
        ) : (
          <div className="max-h-96 overflow-auto">
            <Table data-testid="webhook-deliveries-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("webhooks.deliveries.columns.when")}</TableHead>
                  <TableHead>{t("webhooks.deliveries.columns.event")}</TableHead>
                  <TableHead>{t("webhooks.deliveries.columns.status")}</TableHead>
                  <TableHead className="text-right">
                    {t("webhooks.deliveries.columns.attempt")}
                  </TableHead>
                  <TableHead>{t("webhooks.deliveries.columns.detail")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((delivery) => {
                  const status = deliveryStatusBadge(delivery.status, t);
                  return (
                    <TableRow
                      key={delivery.id}
                      data-testid={`webhook-delivery-${delivery.id}`}
                    >
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatMoment(delivery.createdAt, f.locale)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {delivery.event}
                      </TableCell>
                      <TableCell>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {delivery.attempt}
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-muted-foreground">
                        {deliveryDetail(delivery, t, f.locale)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="webhook-deliveries-close"
          >
            {tc("actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── delete ───────────────────────────────────────────────────────────

type DeleteWebhookDialogProps = {
  subscription: WebhookSubscriptionWire | null;
  onOpenChange: (open: boolean) => void;
};

function DeleteWebhookDialog({
  subscription,
  onOpenChange,
}: DeleteWebhookDialogProps): React.JSX.Element {
  const utils = trpc.useUtils();
  const t = useT("settings");
  const tc = useT("common");

  const remove = trpc.webhooks.remove.useMutation({
    onMutate: async ({ id }) => {
      await utils.webhooks.list.cancel();
      const previous = utils.webhooks.list.getData();
      utils.webhooks.list.setData(undefined, (old) =>
        old?.filter((item) => item.id !== id),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        utils.webhooks.list.setData(undefined, context.previous);
      }
      toast.error(
        userErrorMessage(error, translate("settings")("webhooks.toasts.deleteFailed")),
      );
    },
    onSuccess: () => {
      toast.success(translate("settings")("webhooks.toasts.deleted"));
    },
    onSettled: () => {
      void utils.webhooks.invalidate();
    },
  });

  return (
    <Dialog open={subscription !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="delete-webhook-dialog">
        <DialogHeader>
          <DialogTitle>{t("webhooks.delete.title")}</DialogTitle>
          <DialogDescription>
            {t.rich("webhooks.delete.description", {
              url: subscription?.url ?? "",
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="delete-webhook-cancel"
          >
            {tc("actions.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (!subscription) return;
              remove.mutate({ id: subscription.id, originId: ORIGIN_ID });
              onOpenChange(false);
            }}
            data-testid="delete-webhook-confirm"
          >
            {tc("actions.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── panel ────────────────────────────────────────────────────────────

/** Where this workspace pushes events, and how those pushes are going. */
export function WebhooksPanel(): React.JSX.Element {
  const webhooksQuery = trpc.webhooks.list.useQuery();
  const utils = trpc.useUtils();
  const t = useT("settings");
  const tc = useT("common");
  const f = useFormat();
  const [creating, setCreating] = React.useState(false);
  const [inspecting, setInspecting] =
    React.useState<WebhookSubscriptionWire | null>(null);
  const [deleting, setDeleting] =
    React.useState<WebhookSubscriptionWire | null>(null);

  const subscriptions = webhooksQuery.data ?? [];

  const update = trpc.webhooks.update.useMutation({
    onError: (error) => {
      toast.error(
        userErrorMessage(error, translate("settings")("webhooks.toasts.updateFailed")),
      );
    },
    onSuccess: (subscription) => {
      toast.success(
        translate("settings")(
          subscription.enabled ? "webhooks.toasts.enabled" : "webhooks.toasts.paused",
        ),
      );
    },
    onSettled: () => {
      void utils.webhooks.list.invalidate();
    },
  });

  return (
    <Card data-testid="settings-webhooks">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("webhooks.title")}</CardTitle>
          <CardDescription>{t("webhooks.description")}</CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setCreating(true)}
          data-testid="create-webhook"
        >
          <Plus className="size-4" />
          {t("webhooks.create")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {webhooksQuery.isLoading ? (
          <div className="space-y-2" data-testid="webhooks-loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : subscriptions.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title={t("webhooks.empty.title")}
            description={t("webhooks.empty.description")}
            testId="webhooks-empty"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="webhooks-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("webhooks.columns.endpoint")}</TableHead>
                  <TableHead>{t("webhooks.columns.events")}</TableHead>
                  <TableHead>{t("webhooks.columns.state")}</TableHead>
                  <TableHead>{t("webhooks.columns.lastDelivery")}</TableHead>
                  <TableHead className="text-right">
                    {t("webhooks.columns.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.map((subscription) => {
                  const health = webhookHealth(subscription, t);
                  return (
                    <TableRow
                      key={subscription.id}
                      data-testid={`webhook-row-${subscription.id}`}
                    >
                      <TableCell className="max-w-72 font-medium">
                        <span className="flex items-center gap-2">
                          <Webhook className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate font-mono text-xs">
                            {subscription.url}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          {subscription.events.map((event) => (
                            <Badge
                              key={event}
                              variant="outline"
                              className="font-mono"
                            >
                              {event}
                            </Badge>
                          ))}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={health.variant}
                          data-testid={`webhook-state-${subscription.id}`}
                        >
                          {health.label}
                        </Badge>
                        {health.detail ? (
                          <span className="mt-0.5 block max-w-64 text-xs text-muted-foreground">
                            {health.detail}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {subscription.lastDeliveryAt
                          ? formatMoment(subscription.lastDeliveryAt, f.locale)
                          : t("webhooks.never")}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <Switch
                            checked={subscription.enabled}
                            disabled={update.isPending}
                            aria-label={
                              subscription.enabled
                                ? t("webhooks.toggle.pause")
                                : t("webhooks.toggle.enable")
                            }
                            onCheckedChange={(enabled) =>
                              update.mutate({
                                id: subscription.id,
                                enabled,
                                originId: ORIGIN_ID,
                              })
                            }
                            data-testid={`webhook-toggle-${subscription.id}`}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setInspecting(subscription)}
                            data-testid={`webhook-deliveries-${subscription.id}`}
                          >
                            {t("webhooks.deliveriesAction")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setDeleting(subscription)}
                            data-testid={`delete-webhook-${subscription.id}`}
                          >
                            {tc("actions.delete")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <VerifyingDeliveriesHint />
      </CardContent>

      <CreateWebhookDialog open={creating} onOpenChange={setCreating} />
      <DeliveriesDialog
        subscription={inspecting}
        onOpenChange={(open) => {
          if (!open) setInspecting(null);
        }}
      />
      <DeleteWebhookDialog
        subscription={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </Card>
  );
}

/** The part a receiver has to get right, and can only get right on purpose. */
function VerifyingDeliveriesHint(): React.JSX.Element {
  const t = useT("settings");
  const code = (chunks: React.ReactNode): React.JSX.Element => (
    <code className="font-mono text-foreground">{chunks}</code>
  );
  return (
    <div
      className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
      data-testid="webhook-hint"
    >
      <p className="font-medium text-foreground">{t("webhooks.hint.title")}</p>
      <p className="mt-1">
        {t.rich("webhooks.hint.body", {
          timestampHeader: "X-TrackYourTime-Timestamp",
          signatureHeader: "X-TrackYourTime-Signature",
          signedPayload: "<timestamp>.<raw body>",
          code,
        })}
      </p>
    </div>
  );
}
