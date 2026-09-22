"use client";

// The invoice logo, above the business profile form: a preview of what the
// next invoice prints top right, an upload (PNG or JPEG) and a remove button.
//
// Its own mutations, not a field of the profile form: the form is one
// statement of identity saved with one button, and 300 KB of image re-sent
// on every Save is the wrong shape for it. A saved logo is merged into the
// cached profile without touching `updatedAt`, so the form beside it keeps
// whatever is half typed. The byte checks proper are the server's; what is
// checked here is what a browser knows before reading the file — its type
// and its size — with the same cap.
import * as React from "react";
import { ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import {
  BUSINESS_LOGO_MAX_BYTES,
  BUSINESS_LOGO_MAX_DIMENSION,
  BUSINESS_LOGO_REFUSALS,
  businessLogoMimeOf,
  businessLogoRefusalOf,
  parseImageDataUrl,
  type BusinessLogoRefusal,
  type BusinessLogoUpload,
  type BusinessProfile,
} from "@starter/shared";

import { errorCode } from "@/components/catalog/types";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";

type RefusalKey = keyof typeof BUSINESS_LOGO_REFUSALS;

/** Refusal code → key under `businessProfile.logo.errors`. */
const REFUSAL_KEYS = Object.fromEntries(
  (Object.entries(BUSINESS_LOGO_REFUSALS) as [RefusalKey, BusinessLogoRefusal][]).map(([key, code]) => [
    code,
    key,
  ]),
) as Record<BusinessLogoRefusal, RefusalKey>;

/** The cap in KB, as the copy states it. */
export const LOGO_MAX_KB = String(Math.round(BUSINESS_LOGO_MAX_BYTES / 1024));

/** Why a picked file is refused before it is even read, or null. Pure. */
export function checkLogoFile(file: { type: string; size: number }): BusinessLogoRefusal | null {
  if (businessLogoMimeOf(file.type) === null) return BUSINESS_LOGO_REFUSALS.unsupportedFormat;
  if (file.size > BUSINESS_LOGO_MAX_BYTES) return BUSINESS_LOGO_REFUSALS.tooLarge;
  return null;
}

/** The file as the upload body, or null when the browser could not read it. */
export function readLogoFile(file: Blob): Promise<BusinessLogoUpload | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onabort = () => resolve(null);
    reader.onload = () => resolve(parseImageDataUrl(reader.result));
    reader.readAsDataURL(file);
  });
}

export function BusinessLogoControl({ profile }: { profile: BusinessProfile }): React.JSX.Element {
  const t = useT("settings");
  const utils = trpc.useUtils();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState(false);

  const refusalMessage = (code: BusinessLogoRefusal): string => {
    const key = REFUSAL_KEYS[code];
    switch (key) {
      case "tooLarge":
        return t("businessProfile.logo.errors.tooLarge", { max: LOGO_MAX_KB });
      case "tooBig":
        return t("businessProfile.logo.errors.tooBig", { max: String(BUSINESS_LOGO_MAX_DIMENSION) });
      default:
        return t(`businessProfile.logo.errors.${key}`);
    }
  };

  // Only the logo moves in the cache: the form is keyed on `updatedAt` and
  // must not re-seed over a draft because a picture changed beside it.
  const merge = (saved: BusinessProfile): void =>
    utils.settings.businessProfile.setData(undefined, (current) =>
      current ? { ...current, logo: saved.logo } : saved,
    );

  const set = trpc.settings.setBusinessLogo.useMutation({
    onSuccess: (saved) => {
      merge(saved);
      setError(null);
      toast.success(t("businessProfile.logo.saved"));
    },
    onError: (failure) => {
      const refusal = businessLogoRefusalOf(failure.message);
      if (refusal) {
        setError(refusalMessage(refusal));
        return;
      }
      toast.error(
        errorCode(failure) === "FORBIDDEN"
          ? t("businessProfile.forbidden")
          : t("businessProfile.logo.saveFailed"),
      );
    },
  });
  const clear = trpc.settings.clearBusinessLogo.useMutation({
    onSuccess: (saved) => {
      merge(saved);
      setError(null);
      toast.success(t("businessProfile.logo.removed"));
    },
    onError: (failure) => {
      toast.error(
        errorCode(failure) === "FORBIDDEN"
          ? t("businessProfile.forbidden")
          : t("businessProfile.logo.removeFailed"),
      );
    },
  });

  const busy = reading || set.isPending || clear.isPending;

  const onPick = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    // Cleared so picking the same file again after a refusal fires onChange.
    event.target.value = "";
    if (!file) return;
    const refusal = checkLogoFile(file);
    if (refusal) {
      setError(refusalMessage(refusal));
      return;
    }
    setReading(true);
    const upload = await readLogoFile(file);
    setReading(false);
    if (!upload) {
      setError(t("businessProfile.logo.readFailed"));
      return;
    }
    setError(null);
    set.mutate({ ...upload, originId: ORIGIN_ID });
  };

  const logo = profile.logo;

  return (
    <div className="space-y-2" data-testid="business-logo">
      <p className="text-sm font-semibold">{t("businessProfile.logo.title")}</p>
      <div className="flex flex-wrap items-center gap-4">
        {logo ? (
          // A data URL of the stored bytes: nothing to optimise, nothing to fetch.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo.dataUrl}
            alt={t("businessProfile.logo.alt")}
            width={logo.width}
            height={logo.height}
            className="h-16 w-auto max-w-40 rounded-md border border-border bg-white object-contain p-1"
            data-testid="business-logo-preview"
          />
        ) : (
          <div
            className="flex h-16 w-40 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground"
            data-testid="business-logo-empty"
          >
            <ImageIcon className="size-5" aria-hidden="true" />
          </div>
        )}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground" data-testid="business-logo-size">
            {logo
              ? t("businessProfile.logo.size", { width: String(logo.width), height: String(logo.height) })
              : t("businessProfile.logo.none")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              data-testid="business-logo-upload"
            >
              {busy ? <Loader2 className="animate-spin" /> : <Upload />}
              {logo ? t("businessProfile.logo.replace") : t("businessProfile.logo.upload")}
            </Button>
            {logo ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => clear.mutate({ originId: ORIGIN_ID })}
                data-testid="business-logo-remove"
              >
                <Trash2 />
                {t("businessProfile.logo.remove")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="sr-only"
        tabIndex={-1}
        aria-label={t("businessProfile.logo.upload")}
        onChange={(event) => void onPick(event)}
        data-testid="business-logo-file"
      />
      {error ? (
        <p className="text-sm text-destructive" data-testid="business-logo-error">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("businessProfile.logo.hint", { max: LOGO_MAX_KB })}
        </p>
      )}
    </div>
  );
}
