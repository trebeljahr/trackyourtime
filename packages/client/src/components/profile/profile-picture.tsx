"use client";

import * as React from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { AVATAR_REFUSALS } from "@starter/shared";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/hooks/use-auth";
import { useT } from "@/i18n/use-t";
import { translate } from "@/i18n/translate";
import { refreshSession } from "@/lib/auth-client";
import { PrepareAvatarError, prepareAvatar } from "@/lib/avatar-image";
import { userErrorMessage } from "@/lib/error-message";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/** "Ada Lovelace" → "AL", "ada@example.com" → "A". */
export const initialsOf = (name?: string | null, email?: string | null): string =>
  (name?.trim() || email || "?")
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** The translated reason an upload was refused, on the client or the server. */
export const avatarFailureMessage = (error: unknown): string => {
  const t = translate("settings");
  if (error instanceof PrepareAvatarError) {
    switch (error.reason) {
      case "not-an-image":
      case "unreadable":
        return t("account.picture.errors.unsupported");
      case "source-too-large":
      case "too-large":
        return t("account.picture.errors.tooLarge");
    }
  }
  const message = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : null;
  if (message === AVATAR_REFUSALS.UNSUPPORTED_IMAGE || message === AVATAR_REFUSALS.INVALID_DATA) {
    return t("account.picture.errors.unsupported");
  }
  if (message === AVATAR_REFUSALS.TOO_LARGE) return t("account.picture.errors.tooLarge");
  return userErrorMessage(error, t("account.picture.errors.failed"));
};

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/*";

export type ProfilePictureProps = {
  /** Avatar diameter class, e.g. `size-16`. */
  avatarClassName?: string;
  className?: string;
};

/**
 * The signed-in person's picture, with the way to add, replace or remove it.
 *
 * Rendered from `useAuth().user.image` — the same value the header avatar
 * shows — so what is on screen is what every other client will show once the
 * session is re-read. The chosen file is squared and shrunk in the browser
 * (`lib/avatar-image.ts`) and sent as base64 to `profile.setAvatar`.
 */
export function ProfilePicture({
  avatarClassName = "size-16",
  className,
}: ProfilePictureProps): React.JSX.Element {
  const t = useT("settings");
  const { user } = useAuth();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = React.useState(false);

  const setAvatar = trpc.profile.setAvatar.useMutation();
  const removeAvatar = trpc.profile.removeAvatar.useMutation();
  const busy = preparing || setAvatar.isPending || removeAvatar.isPending;
  const hasImage = Boolean(user?.image);

  const upload = async (file: File): Promise<void> => {
    setPreparing(true);
    try {
      const prepared = await prepareAvatar(file);
      setPreparing(false);
      await setAvatar.mutateAsync({ data: prepared.base64 });
      await refreshSession();
      toast.success(translate("settings")("account.picture.toasts.saved"));
    } catch (error) {
      toast.error(avatarFailureMessage(error));
    } finally {
      setPreparing(false);
    }
  };

  const remove = async (): Promise<void> => {
    try {
      await removeAvatar.mutateAsync();
      await refreshSession();
      toast.success(translate("settings")("account.picture.toasts.removed"));
    } catch (error) {
      toast.error(userErrorMessage(error, translate("settings")("account.picture.errors.failed")));
    }
  };

  return (
    <div className={cn("flex items-center gap-4", className)} data-testid="profile-picture">
      <Avatar className={avatarClassName}>
        {user?.image ? <AvatarImage src={user.image} alt="" data-testid="profile-picture-image" /> : null}
        <AvatarFallback className="text-base">{initialsOf(user?.name, user?.email)}</AvatarFallback>
      </Avatar>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !user}
          onClick={() => inputRef.current?.click()}
          data-testid="profile-picture-upload"
        >
          {busy && !removeAvatar.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ImagePlus className="size-4" />
          )}
          {hasImage ? t("account.picture.change") : t("account.picture.upload")}
        </Button>
        {hasImage ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void remove()}
            data-testid="profile-picture-remove"
          >
            {removeAvatar.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {t("account.picture.remove")}
          </Button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          aria-label={t("account.picture.title")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Reset so choosing the same file again fires `change` again.
            event.target.value = "";
            if (file) void upload(file);
          }}
          data-testid="profile-picture-input"
        />
      </div>
    </div>
  );
}
