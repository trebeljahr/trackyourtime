"use client";

import * as React from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import {
  API_TOKEN_SCOPES,
  type ApiTokenScope,
  type CreatedApiToken,
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
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { userErrorMessage } from "@/lib/error-message";

/**
 * What each scope actually lets a token do, in the terms of this app.
 *
 * Spelled out rather than showing the raw scope string alone: `catalog:write`
 * reads as harmless until somebody realises it deletes projects. The values
 * are keys under `settings.apiTokens.scopes`.
 */
const SCOPE_KEYS = {
  "entries:read": "entriesRead",
  "entries:write": "entriesWrite",
  "catalog:read": "catalogRead",
  "catalog:write": "catalogWrite",
  "reports:read": "reportsRead",
} as const satisfies Record<ApiTokenScope, string>;

/** A literal the reader types into their own tool — never translated. */
const AUTHORIZATION_HEADER = "Authorization: Bearer <token>";

// ── one-time reveal ──────────────────────────────────────────────────

export type OneTimeSecretProps = {
  /** The plaintext. Held by the caller's state only — never a query cache. */
  value: string;
  label: string;
  /** What to do with it, in the caller's own words. */
  hint: React.ReactNode;
  testId: string;
};

/**
 * The single moment a secret is readable.
 *
 * Shared by the token and the webhook secret so the two cannot drift into
 * differently-worded warnings — both are stored as a hash or read only by the
 * server, and neither can be shown a second time by anything.
 */
export function OneTimeSecret({
  value,
  label,
  hint,
  testId,
}: OneTimeSecretProps): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const t = useT("settings");
  const tc = useT("common");

  const copy = (): void => {
    // Clipboard access is unavailable over plain http and in some embedded
    // browsers. Saying so beats a button that silently does nothing while the
    // one chance to keep the value is on screen.
    if (!navigator.clipboard) {
      toast.error(translate("settings")("secret.toasts.copyUnavailable"));
      return;
    }
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        toast.success(translate("settings")("secret.toasts.copied"));
      })
      .catch(() => {
        toast.error(translate("settings")("secret.toasts.copyFailed"));
      });
  };

  return (
    <div className="space-y-3" data-testid={testId}>
      <div className="space-y-2">
        <Label htmlFor={`${testId}-value`}>{label}</Label>
        <div className="flex items-start gap-2">
          <code
            id={`${testId}-value`}
            className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm"
            data-testid={`${testId}-plaintext`}
          >
            {value}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copy}
            data-testid={`${testId}-copy`}
          >
            {copied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
            {copied ? tc("actions.copied") : tc("actions.copy")}
          </Button>
        </div>
      </div>

      <div
        className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        data-testid={`${testId}-warning`}
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="space-y-1">
          <p className="font-medium">{t("secret.warning")}</p>
          <p className="text-muted-foreground">{hint}</p>
        </div>
      </div>
    </div>
  );
}

// ── create form ──────────────────────────────────────────────────────

export type ApiTokenFormValues = {
  name: string;
  scopes: ApiTokenScope[];
  /** ISO-8601 with an offset, or null for "never expires". */
  expiresAt: string | null;
};

export type ApiTokenFormProps = {
  onCreate: (values: ApiTokenFormValues) => void;
  onCancel: () => void;
  isPending: boolean;
};

/**
 * The end of the chosen day in the reader's own zone.
 *
 * Midnight would expire a token picked for "the 31st" as the 31st begins,
 * which reads as off-by-one to everyone who set it.
 */
export function endOfDayIso(day: string): string | null {
  const parsed = new Date(`${day}T23:59:59`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function ApiTokenForm({
  onCreate,
  onCancel,
  isPending,
}: ApiTokenFormProps): React.JSX.Element {
  const t = useT("settings");
  const tc = useT("common");
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<ApiTokenScope[]>([]);
  const [expiryDay, setExpiryDay] = React.useState("");
  const [nameError, setNameError] = React.useState<boolean>(false);
  const [expiryError, setExpiryError] = React.useState<
    "invalid" | "past" | null
  >(null);

  const toggleScope = (scope: ApiTokenScope): void => {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setNameError(false);
    setExpiryError(null);

    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError(true);
      return;
    }

    let expiresAt: string | null = null;
    if (expiryDay !== "") {
      expiresAt = endOfDayIso(expiryDay);
      if (expiresAt === null) {
        setExpiryError("invalid");
        return;
      }
      if (Date.parse(expiresAt) <= Date.now()) {
        // A token that expired before it was minted is never a request the
        // user meant to make, and the server would happily accept it.
        setExpiryError("past");
        return;
      }
    }

    onCreate({ name: trimmed, scopes, expiresAt });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t("apiTokens.form.title")}</DialogTitle>
        <DialogDescription>{t("apiTokens.form.description")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="api-token-name">{tc("fields.name")}</Label>
        <Input
          id="api-token-name"
          value={name}
          autoFocus
          maxLength={120}
          placeholder={t("apiTokens.form.namePlaceholder")}
          aria-invalid={nameError}
          onChange={(event) => {
            setName(event.target.value);
            if (nameError) setNameError(false);
          }}
          data-testid="api-token-name-input"
        />
        {nameError ? (
          <p className="text-sm text-destructive" data-testid="api-token-name-error">
            {t("apiTokens.form.nameRequired")}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("apiTokens.form.nameHint")}
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("apiTokens.form.scopes")}</legend>
        <div className="space-y-2 rounded-md border border-border p-3">
          {API_TOKEN_SCOPES.map((scope) => {
            const key = SCOPE_KEYS[scope];
            const checked = scopes.includes(scope);
            return (
              <label
                key={scope}
                className="flex cursor-pointer items-start gap-3 text-sm"
              >
                <Checkbox
                  checked={checked}
                  className="mt-0.5"
                  onCheckedChange={() => toggleScope(scope)}
                  data-testid={`api-token-scope-${scope}`}
                />
                <span>
                  <span className="font-medium">
                    {t(`apiTokens.scopes.${key}.title`)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`apiTokens.scopes.${key}.description`)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {scopes.length === 0 ? (
          // A zero-scope token is legal — the server denies by asking whether a
          // scope is present, never by defaulting one in. Saying nothing here
          // would ship a token that answers 403 to everything and looks broken.
          <p
            className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
            data-testid="api-token-no-scopes"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              {t.rich("apiTokens.form.noScopes", {
                b: (chunks) => (
                  <span className="font-medium text-foreground">{chunks}</span>
                ),
              })}
            </span>
          </p>
        ) : null}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="api-token-expiry">{t("apiTokens.form.expiry")}</Label>
        <Input
          id="api-token-expiry"
          type="date"
          value={expiryDay}
          aria-invalid={expiryError !== null}
          onChange={(event) => {
            setExpiryDay(event.target.value);
            if (expiryError) setExpiryError(null);
          }}
          data-testid="api-token-expiry-input"
        />
        {expiryError ? (
          <p
            className="text-sm text-destructive"
            data-testid="api-token-expiry-error"
          >
            {expiryError === "past"
              ? t("apiTokens.form.expiryPast")
              : t("apiTokens.form.expiryInvalid")}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("apiTokens.form.expiryHint")}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          data-testid="api-token-cancel"
        >
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" disabled={isPending} data-testid="api-token-submit">
          {t("apiTokens.form.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ── dialog ───────────────────────────────────────────────────────────

export type CreateApiTokenDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CreateApiTokenDialog({
  open,
  onOpenChange,
}: CreateApiTokenDialogProps): React.JSX.Element {
  const utils = trpc.useUtils();
  const t = useT("settings");
  /**
   * The plaintext lives here and nowhere else — not in the query cache, not in
   * storage. Closing the dialog unmounts this state, which is the whole
   * lifetime of the only copy the browser ever had.
   */
  const [minted, setMinted] = React.useState<CreatedApiToken | null>(null);

  const create = trpc.apiTokens.create.useMutation({
    onError: (error) => {
      toast.error(
        userErrorMessage(error, translate("settings")("apiTokens.toasts.createFailed")),
      );
    },
    onSettled: () => {
      void utils.apiTokens.list.invalidate();
    },
  });

  const handleCreate = (values: ApiTokenFormValues): void => {
    void create
      .mutateAsync({
        name: values.name,
        scopes: values.scopes,
        expiresAt: values.expiresAt,
        originId: ORIGIN_ID,
      })
      .then((created) => {
        setMinted(created);
        // A mutation's result stays readable on the hook until it is reset, so
        // "shown once" would otherwise mean "held by react-query for the rest
        // of the session".
        create.reset();
        toast.success(
          translate("settings")("apiTokens.toasts.created", {
            name: created.token.name,
          }),
        );
      })
      .catch(() => {
        // onError already reported it; swallowing keeps the dialog open with
        // the typed values still in place.
      });
  };

  const handleOpenChange = (next: boolean): void => {
    if (!next) setMinted(null);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="api-token-dialog">
        {!open ? null : minted ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("apiTokens.reveal.title")}</DialogTitle>
              <DialogDescription>
                {t.rich("apiTokens.reveal.description", {
                  header: AUTHORIZATION_HEADER,
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </DialogDescription>
            </DialogHeader>

            <OneTimeSecret
              value={minted.plaintext}
              label={minted.token.name}
              hint={t("apiTokens.reveal.hint")}
              testId="api-token-reveal"
            />

            <DialogFooter>
              <Button
                type="button"
                onClick={() => handleOpenChange(false)}
                data-testid="api-token-reveal-done"
              >
                {t("secret.stored")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <ApiTokenForm
            onCreate={handleCreate}
            onCancel={() => handleOpenChange(false)}
            isPending={create.isPending}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
