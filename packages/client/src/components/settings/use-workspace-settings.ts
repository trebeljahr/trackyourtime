"use client";

import * as React from "react";
import type { UpdateSettingsInput, ResolvedSettings } from "@starter/shared";

import { FALLBACK_SETTINGS } from "@/lib/format";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { toast } from "@/components/ui/sonner";
import { translate } from "@/i18n/translate";
import { trpc } from "@/lib/trpc";
import { userErrorMessage } from "@/lib/error-message";

/** Everything `settings.update` accepts, minus the tab-identity plumbing. */
export type SettingsPatch = Omit<UpdateSettingsInput, "originId">;

/** Drives the "Saved" affordance next to auto-saving controls. */
export type SaveState = "idle" | "saving" | "saved" | "error";

/** How long the "Saved" flash stays on screen after a successful write. */
const SAVED_FLASH_MS = 1600;

const isDefined = <T,>(value: T | undefined): value is T => value !== undefined;

/**
 * Applies a partial update the same way the server does, so the optimistic
 * cache entry and the eventual server response agree.
 */
export const applySettingsPatch = (
  current: ResolvedSettings,
  patch: SettingsPatch
): ResolvedSettings => {
  // Keys are constrained by the settings types; the cast is the narrowest way
  // to write through an `Object.entries` loop without reaching for `any`.
  const mergeBlock = <T extends object>(
    block: T,
    incoming: Partial<Record<keyof T, unknown>> | undefined,
  ): T => {
    if (!incoming) return block;
    const next: T = { ...block };
    for (const [key, value] of Object.entries(incoming)) {
      if (value === undefined) continue;
      (next as Record<string, unknown>)[key] = value;
    }
    return next;
  };

  const idle = mergeBlock(current.idle, patch.idle);
  const maxDuration = mergeBlock(current.maxDuration, patch.maxDuration);

  return {
    ...current,
    defaultHourlyRate: isDefined(patch.defaultHourlyRate)
      ? patch.defaultHourlyRate
      : current.defaultHourlyRate,
    currency: isDefined(patch.currency) ? patch.currency : current.currency,
    weekStartsOn: isDefined(patch.weekStartsOn)
      ? patch.weekStartsOn
      : current.weekStartsOn,
    timeFormat: isDefined(patch.timeFormat)
      ? patch.timeFormat
      : current.timeFormat,
    durationFormat: isDefined(patch.durationFormat)
      ? patch.durationFormat
      : current.durationFormat,
    theme: isDefined(patch.theme) ? patch.theme : current.theme,
    locale: isDefined(patch.locale) ? patch.locale : current.locale,
    idle,
    maxDuration,
  };
};

export type WorkspaceSettingsController = {
  settings: ResolvedSettings;
  /** False while `settings.get` is still in flight (fallbacks are in use). */
  isLoaded: boolean;
  saveState: SaveState;
  /** Fire-and-forget partial save; the cache updates before the round trip. */
  save: (patch: SettingsPatch) => void;
};

/**
 * One optimistic writer for the whole settings screen. Every tab mutates
 * through this so the "Saved" indicator, rollback and invalidation behave
 * identically no matter which control the user touched.
 */
export const useWorkspaceSettings = (): WorkspaceSettingsController => {
  const utils = trpc.useUtils();
  const query = trpc.settings.get.useQuery();
  const [saveState, setSaveState] = React.useState<SaveState>("idle");

  const flashTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    []
  );

  const mutation = trpc.settings.update.useMutation({
    onMutate: async (input) => {
      await utils.settings.get.cancel();
      const previous = utils.settings.get.getData();
      if (previous) {
        utils.settings.get.setData(
          undefined,
          applySettingsPatch(previous, input)
        );
      }
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        utils.settings.get.setData(undefined, context.previous);
      }
      setSaveState("error");
      toast.error(userErrorMessage(error, translate("settings")("toasts.saveFailed")));
    },
    onSuccess: (updated) => {
      utils.settings.get.setData(undefined, updated);
      setSaveState("saved");
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => {
        setSaveState("idle");
      }, SAVED_FLASH_MS);
    },
    onSettled: () => {
      void utils.settings.get.invalidate();
    },
  });

  const { mutate } = mutation;

  const save = React.useCallback(
    (patch: SettingsPatch): void => {
      setSaveState("saving");
      mutate({ ...patch, originId: ORIGIN_ID });
    },
    [mutate]
  );

  return {
    settings: query.data ?? FALLBACK_SETTINGS,
    isLoaded: query.data !== undefined,
    saveState,
    save,
  };
};
