"use client";

import * as React from "react";
import {
  WEBHOOK_EVENTS,
  type CreatedWebhookSubscription,
  type WebhookEvent,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { trpc } from "@/lib/trpc";
import { OneTimeSecret } from "./create-api-token-dialog";

/** What each event means, in the words the app itself uses. */
export const EVENT_LABELS: Record<WebhookEvent, string> = {
  "entry.started": "A timer started",
  "entry.stopped": "A running timer stopped",
  "entry.created": "An entry was added",
  "entry.updated": "An entry changed",
  "entry.deleted": "An entry was deleted",
  "invoice.created": "An invoice was created",
  "invoice.status_changed": "An invoice changed status",
};

export type WebhookFormValues = {
  url: string;
  events: WebhookEvent[];
};

/**
 * A destination this browser can describe as deliverable.
 *
 * Only a shape check: the server resolves the host and refuses anything on its
 * own network, which is the check that actually matters and which no browser
 * can make. Catching the typo here just saves a round trip.
 */
export function webhookUrlError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "Endpoint URL is required";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a full URL, starting with https://";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Only http and https endpoints can be called";
  }
  return null;
}

export type WebhookFormProps = {
  onCreate: (values: WebhookFormValues) => void;
  onCancel: () => void;
  isPending: boolean;
};

export function WebhookForm({
  onCreate,
  onCancel,
  isPending,
}: WebhookFormProps): React.JSX.Element {
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState<WebhookEvent[]>([]);
  const [urlError, setUrlError] = React.useState<string | null>(null);
  const [eventsError, setEventsError] = React.useState<string | null>(null);

  const toggleEvent = (event: WebhookEvent): void => {
    setEvents((current) =>
      current.includes(event)
        ? current.filter((item) => item !== event)
        : [...current, event],
    );
    if (eventsError) setEventsError(null);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const problem = webhookUrlError(url);
    setUrlError(problem);
    // Unlike a token's scopes, an empty list here is not a closed position —
    // it is a subscription that exists to do nothing, which nobody means.
    const missingEvents = events.length === 0 ? "Pick at least one event" : null;
    setEventsError(missingEvents);
    if (problem !== null || missingEvents !== null) return;

    onCreate({ url: url.trim(), events });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>New webhook</DialogTitle>
        <DialogDescription>
          We POST a signed JSON payload to your endpoint whenever one of the
          events below happens in this workspace.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="webhook-url">Endpoint URL</Label>
        <Input
          id="webhook-url"
          value={url}
          autoFocus
          maxLength={2000}
          inputMode="url"
          placeholder="https://example.com/hooks/trackyourtime"
          aria-invalid={urlError !== null}
          onChange={(field) => {
            setUrl(field.target.value);
            if (urlError) setUrlError(null);
          }}
          data-testid="webhook-url-input"
        />
        {urlError ? (
          <p className="text-sm text-destructive" data-testid="webhook-url-error">
            {urlError}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Must be reachable from the internet over https. Addresses inside the
            server&apos;s own network are refused.
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">When to call it</legend>
        <div className="space-y-2 rounded-md border border-border p-3">
          {WEBHOOK_EVENTS.map((event) => (
            <label
              key={event}
              className="flex cursor-pointer items-start gap-3 text-sm"
            >
              <Checkbox
                checked={events.includes(event)}
                className="mt-0.5"
                onCheckedChange={() => toggleEvent(event)}
                data-testid={`webhook-event-${event}`}
              />
              <span>
                <span className="font-medium">{EVENT_LABELS[event]}</span>
                <span className="block font-mono text-xs text-muted-foreground">
                  {event}
                </span>
              </span>
            </label>
          ))}
        </div>
        {eventsError ? (
          <p
            className="text-sm text-destructive"
            data-testid="webhook-events-error"
          >
            {eventsError}
          </p>
        ) : null}
      </fieldset>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          data-testid="webhook-cancel"
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isPending} data-testid="webhook-submit">
          Create webhook
        </Button>
      </DialogFooter>
    </form>
  );
}

// ── dialog ───────────────────────────────────────────────────────────

export type CreateWebhookDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CreateWebhookDialog({
  open,
  onOpenChange,
}: CreateWebhookDialogProps): React.JSX.Element {
  const utils = trpc.useUtils();
  /** Same rule as the token: the secret is state here, and nowhere else. */
  const [created, setCreated] =
    React.useState<CreatedWebhookSubscription | null>(null);

  const create = trpc.webhooks.create.useMutation({
    onError: (error) => {
      toast.error(error.message || "Could not create that webhook");
    },
    onSettled: () => {
      void utils.webhooks.list.invalidate();
    },
  });

  const handleCreate = (values: WebhookFormValues): void => {
    void create
      .mutateAsync({
        url: values.url,
        events: values.events,
        originId: ORIGIN_ID,
      })
      .then((result) => {
        setCreated(result);
        // Drop react-query's copy of the secret; the reveal below owns the
        // only one, and it dies with the dialog.
        create.reset();
        toast.success("Webhook created.");
      })
      .catch(() => {
        // Reported by onError. Keeping the dialog open leaves the typed URL in
        // place, which matters when the server refused the host.
      });
  };

  const handleOpenChange = (next: boolean): void => {
    if (!next) setCreated(null);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="webhook-dialog">
        {!open ? null : created ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>Webhook created</DialogTitle>
              <DialogDescription>
                Every delivery carries an{" "}
                <code>X-TrackYourTime-Signature</code> header. Verify it with this
                secret before trusting the payload.
              </DialogDescription>
            </DialogHeader>

            <OneTimeSecret
              value={created.secret}
              label="Signing secret"
              hint="The server never reads it back out, so nothing can show it again. If you lose it, delete this webhook and create another."
              testId="webhook-reveal"
            />

            <DialogFooter>
              <Button
                type="button"
                onClick={() => handleOpenChange(false)}
                data-testid="webhook-reveal-done"
              >
                I have stored it
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <WebhookForm
            onCreate={handleCreate}
            onCancel={() => handleOpenChange(false)}
            isPending={create.isPending}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
