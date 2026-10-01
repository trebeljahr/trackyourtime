import { useEffect, useRef, type JSX } from "react";
import { History, Star, Play, X } from "lucide-react";
import {
  repairQuickStart,
  type QuickStart,
  type QuickStartItem,
} from "@starter/core";
import { useT } from "../i18n/use-t";
import { quickLabel, quickHint } from "./entry-format";

export function QuickStartDrawer({
  kind,
  items,
  busy,
  onClose,
  onStart,
  onPin,
  onUnpin,
}: {
  kind: "recents" | "favorites";
  items: QuickStartItem[];
  busy: boolean;
  onClose: () => void;
  onStart: (quick: QuickStart) => void;
  onPin: (quick: QuickStart) => void;
  onUnpin: (id: string) => void;
}): JSX.Element {
  const t = useT("popup");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      className="timer-drawer"
      ref={dialog}
      aria-labelledby="drawer-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="timer-drawer__header">
        {kind === "recents" ? (
          <History size={23} aria-hidden="true" />
        ) : (
          <Star size={23} aria-hidden="true" />
        )}
        <h2 id="drawer-title">{t(`quickStart.${kind}`)}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label={t("quickStart.close")}
        >
          <X size={23} />
        </button>
      </div>
      <p className="popup__hint">{t("quickStart.startHint")}</p>
      <div className="timer-drawer__list">
        {items.length === 0 && (
          <p className="timer-drawer__empty">
            {t(
              kind === "recents"
                ? "quickStart.emptyRecents"
                : "quickStart.emptyFavorites",
            )}
          </p>
        )}
        {items.map((item) => {
          const label = quickLabel(item, t);
          const hint = quickHint(item, t);
          return (
            <div
              className="quick__row"
              key={item.kind === "favorite" ? item.id : item.key}
            >
              <button
                type="button"
                className="quick__start"
                disabled={busy}
                onClick={() => onStart(repairQuickStart(item))}
                aria-label={t("quickStart.startEntry", { label })}
              >
                <Play size={18} className="quick__play" aria-hidden="true" />
                <span className="quick__text">
                  <span className="quick__label">{label}</span>
                  {hint && <span className="quick__hint">{hint}</span>}
                </span>
              </button>
              <button
                type="button"
                className="quick__pin"
                disabled={busy}
                aria-label={t(
                  item.kind === "favorite"
                    ? "quickStart.unpin"
                    : "quickStart.pin",
                  { label },
                )}
                onClick={() =>
                  item.kind === "favorite"
                    ? onUnpin(item.id)
                    : onPin(repairQuickStart(item))
                }
              >
                <Star
                  size={19}
                  fill={item.kind === "favorite" ? "currentColor" : "none"}
                />
              </button>
            </div>
          );
        })}
      </div>
    </dialog>
  );
}
