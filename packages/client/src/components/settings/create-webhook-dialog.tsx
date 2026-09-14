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
import { translate } from "@/i18n/translate";
import type { Translator } from "@/i18n/translator";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { OneTimeSecret } from "./create-api-token-dialog";
import { userErrorMessage } from "@/lib/error-message";

/**
 * What each event means, in the words the app itself uses. Event names are
 * dotted wire names, so each maps to a key under `settings.webhooks.events`.
 */
const EVENT_KEYS = {
  "entry.started": "entryStarted",
  "entry.stopped": "entryStopped",
  "entry.created": "entryCreated",
  "entry.updated": "entryUpdated",
  "entry.deleted": "entryDeleted",
  "invoice.created": "invoiceCreated",
  "invoice.status_changed": "invoiceStatusChanged",
} as const satisfies Record<WebhookEvent, string>;

/** A header name a receiver reads — never translated. */
const SIGNATURE_HEADER = "X-TrackYourTime-Signature";

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
export function webhookUrlError(
  raw: string,
  t: Translator<"settings"> = translate("settings"),
): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return t("webhooks.form.urlRequired");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return t("webhooks.form.urlInvalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return t("webhooks.form.urlScheme");
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
  const t = useT("settings");
  const tc = useT("common");
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState<WebhookEvent[]>([]);
  const [urlError, setUrlError] = React.useState<string | null>(null);
  const [eventsError, setEventsError] = React.useState(false);

  const toggleEvent = (event: WebhookEvent): void => {
    setEvents((current) =>
      current.includes(event)
        ? current.filter((item) => item !== event)
        : [...current, event],
    );
    if (eventsError) setEventsError(false);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const problem = webhookUrlError(url, t);
    setUrlError(problem);
    // Unlike a token's scopes, an empty list here is not a closed position —
    // it is a subscription that exists to do nothing, which nobody means.
    const missingEvents = events.length === 0;
    setEventsError(missingEvents);
    if (problem !== null || missingEvents) return;

    onCreate({ url: url.trim(), events });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t("webhooks.form.title")}</DialogTitle>
        <DialogDescription>{t("webhooks.form.description")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="webhook-url">{t("webhooks.form.url")}</Label>
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
            {t("webhooks.form.urlHint")}
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("webhooks.form.events")}</legend>
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
                <span className="font-medium">
                  {t(`webhooks.events.${EVENT_KEYS[event]}`)}
                </span>
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
            {t("webhooks.form.eventsRequired")}
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
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" disabled={isPending} data-testid="webhook-submit">
          {t("webhooks.form.submit")}
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
  const t = useT("settings");
  /** Same rule as the token: the secret is state here, and nowhere else. */
  const [created, setCreated] =
    React.useState<CreatedWebhookSubscription | null>(null);

  const create = trpc.webhooks.create.useMutation({
    onError: (error) => {
      toast.error(
        userErrorMessage(error, translate("settings")("webhooks.toasts.createFailed")),
      );
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
        toast.success(translate("settings")("webhooks.toasts.created"));
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
              <DialogTitle>{t("webhooks.reveal.title")}</DialogTitle>
              <DialogDescription>
                {t.rich("webhooks.reveal.description", {
                  header: SIGNATURE_HEADER,
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </DialogDescription>
            </DialogHeader>

            <OneTimeSecret
              value={created.secret}
              label={t("webhooks.reveal.label")}
              hint={t("webhooks.reveal.hint")}
              testId="webhook-reveal"
            />

            <DialogFooter>
              <Button
                type="button"
                onClick={() => handleOpenChange(false)}
                data-testid="webhook-reveal-done"
              >
                {t("secret.stored")}
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
