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
import { trpc } from "@/lib/trpc";
import { CreateWebhookDialog } from "./create-webhook-dialog";

/** Deliveries are minutes old, so they read as a moment rather than a day. */
const formatMoment = (iso: string): string => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

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
 */
export function webhookHealth(
  subscription: WebhookSubscriptionWire,
): WebhookHealth {
  if (!subscription.enabled && subscription.disabledAt !== null) {
    return {
      label: "Turned off",
      variant: "destructive",
      detail: `Stopped after ${subscription.consecutiveFailures} failed deliveries in a row. Switch it back on once the endpoint answers again.`,
    };
  }
  if (!subscription.enabled) {
    return { label: "Paused", variant: "secondary", detail: null };
  }
  if (subscription.consecutiveFailures > 0) {
    return {
      label: "Failing",
      variant: "destructive",
      detail: `${subscription.consecutiveFailures} failed deliveries in a row. It is still retrying.`,
    };
  }
  return { label: "Active", variant: "secondary", detail: null };
}

export const DELIVERY_STATUS_LABELS: Record<
  WebhookDeliveryStatus,
  { label: string; variant: BadgeProps["variant"] }
> = {
  pending: { label: "Queued", variant: "outline" },
  delivered: { label: "Delivered", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  // Not a failure: the payload was about time the subscription's owner is not
  // allowed to see, so it was dropped rather than retried forever.
  skipped_visibility: { label: "Not sent", variant: "outline" },
};

/** The one line of detail a delivery row can offer beyond its status. */
export function deliveryDetail(delivery: WebhookDeliveryWire): string {
  if (delivery.status === "skipped_visibility") {
    return "You cannot see the entry this was about.";
  }
  if (delivery.error) return delivery.error;
  if (delivery.responseStatus !== null) {
    return `HTTP ${delivery.responseStatus}`;
  }
  if (delivery.status === "pending" && delivery.nextAttemptAt) {
    return `Next try ${formatMoment(delivery.nextAttemptAt)}`;
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

  const deliveries = deliveriesQuery.data?.deliveries ?? [];

  return (
    <Dialog open={subscription !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="webhook-deliveries-dialog">
        <DialogHeader>
          <DialogTitle>Recent deliveries</DialogTitle>
          <DialogDescription>
            The last attempts to reach{" "}
            <span className="font-mono">{subscription?.url ?? ""}</span>. Each
            failed delivery is retried on a widening schedule.
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
            title="Nothing delivered yet"
            description="Attempts appear here as soon as one of the chosen events happens."
            testId="webhook-deliveries-empty"
          />
        ) : (
          <div className="max-h-96 overflow-auto">
            <Table data-testid="webhook-deliveries-table">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempt</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((delivery) => {
                  const status = DELIVERY_STATUS_LABELS[delivery.status];
                  return (
                    <TableRow
                      key={delivery.id}
                      data-testid={`webhook-delivery-${delivery.id}`}
                    >
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatMoment(delivery.createdAt)}
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
                        {deliveryDetail(delivery)}
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
            Close
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
      toast.error(error.message || "Could not delete that webhook");
    },
    onSuccess: () => {
      toast.success("Webhook deleted.");
    },
    onSettled: () => {
      void utils.webhooks.invalidate();
    },
  });

  return (
    <Dialog open={subscription !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="delete-webhook-dialog">
        <DialogHeader>
          <DialogTitle>Delete this webhook?</DialogTitle>
          <DialogDescription>
            We stop calling{" "}
            <span className="font-mono">{subscription?.url ?? "it"}</span>{" "}
            immediately, and its delivery log goes with it. The signing secret
            cannot be recovered — a new webhook gets a new one.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="delete-webhook-cancel"
          >
            Cancel
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
            Delete
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
  const [creating, setCreating] = React.useState(false);
  const [inspecting, setInspecting] =
    React.useState<WebhookSubscriptionWire | null>(null);
  const [deleting, setDeleting] =
    React.useState<WebhookSubscriptionWire | null>(null);

  const subscriptions = webhooksQuery.data ?? [];

  const update = trpc.webhooks.update.useMutation({
    onError: (error) => {
      toast.error(error.message || "Could not change that webhook");
    },
    onSuccess: (subscription) => {
      toast.success(
        subscription.enabled ? "Webhook switched on." : "Webhook paused.",
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
          <CardTitle>Webhooks</CardTitle>
          <CardDescription>
            Push events to your own endpoint as they happen, instead of polling
            the API for them. Payloads are signed, and only carry what you are
            allowed to see. Webhooks you create are yours — nobody else in the
            workspace can see their URLs or change where they point.
          </CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setCreating(true)}
          data-testid="create-webhook"
        >
          <Plus className="size-4" />
          New webhook
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
            title="No webhooks"
            description="Add an endpoint to be told when a timer starts or an entry changes."
            testId="webhooks-empty"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="webhooks-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Last delivery</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.map((subscription) => {
                  const health = webhookHealth(subscription);
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
                          ? formatMoment(subscription.lastDeliveryAt)
                          : "Never"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <Switch
                            checked={subscription.enabled}
                            disabled={update.isPending}
                            aria-label={
                              subscription.enabled
                                ? "Pause this webhook"
                                : "Switch this webhook on"
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
                            Deliveries
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setDeleting(subscription)}
                            data-testid={`delete-webhook-${subscription.id}`}
                          >
                            Delete
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
  return (
    <div
      className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
      data-testid="webhook-hint"
    >
      <p className="font-medium text-foreground">Verifying a delivery</p>
      <p className="mt-1">
        Each request carries{" "}
        <code className="font-mono text-foreground">X-TrackYourTime-Timestamp</code>{" "}
        and{" "}
        <code className="font-mono text-foreground">X-TrackYourTime-Signature</code>
        . Recompute the HMAC-SHA256 of{" "}
        <code className="font-mono text-foreground">
          &lt;timestamp&gt;.&lt;raw body&gt;
        </code>{" "}
        with your signing secret and compare — anything that does not match did
        not come from us.
      </p>
    </div>
  );
}
