import type { JSX } from "react";
import {
  isBrokenQuickStart,
  repairQuickStart,
  type QuickStart,
  type QuickStartItem,
} from "@starter/core";
import { useT } from "../i18n/use-t";
import { quickHint, quickLabel } from "./entry-format";

export type QuickStartListProps = {
  items: QuickStartItem[];
  disabled: boolean;
  onStart: (quick: QuickStart) => void;
  onPin: (quick: QuickStart) => void;
  onUnpin: (id: string) => void;
};

/**
 * The quick-start rail above the popup's start form.
 *
 * This is the surface the whole feature is for. At 380px, retyping a
 * description and re-picking a project is the most expensive thing the popup
 * asks of anyone — one row of "the things you actually track" removes it.
 *
 * Rows are full-width buttons rather than chips: the popup is too narrow for a
 * horizontal rail that would truncate every label to a few characters.
 */
export function QuickStartList({
  items,
  disabled,
  onStart,
  onPin,
  onUnpin,
}: QuickStartListProps): JSX.Element | null {
  const t = useT("popup");
  // Nothing tracked and nothing pinned. An empty rail explaining itself would
  // cost more of a 380px surface than it is worth.
  if (items.length === 0) return null;

  return (
    <div className="quick" data-testid="quick-start-list">
      <p className="field__label">{t("quickStart.title")}</p>
      {items.map((item) => {
        const label = quickLabel(item, t);
        const hint = quickHint(item, t);
        const broken = isBrokenQuickStart(item);
        const pinned = item.kind === "favorite";

        return (
          <div
            className="quick__row"
            key={pinned ? item.id : item.key}
            data-testid="quick-start-row"
            data-kind={item.kind}
          >
            <button
              className="quick__start"
              type="button"
              disabled={disabled}
              // A quick start whose project is gone still describes real work.
              // `repairQuickStart` drops the dangling reference so the server
              // is not sent an id it would reject — and so an offline replay
              // is not stuck retrying a mutation that can never succeed.
              onClick={() => onStart(repairQuickStart(item))}
              title={hint === null ? label : t("quickStart.rowTitle", { label, hint })}
            >
              <span
                className="quick__dot"
                style={
                  item.projectColor === null
                    ? undefined
                    : { backgroundColor: item.projectColor }
                }
              />
              <span className="quick__text">
                <span className="quick__label">{label}</span>
                {hint === null ? null : (
                  <span
                    className={
                      broken ? "quick__hint quick__hint--broken" : "quick__hint"
                    }
                  >
                    {hint}
                  </span>
                )}
              </span>
            </button>

            <button
              className="quick__pin"
              type="button"
              disabled={disabled}
              aria-pressed={pinned}
              title={
                pinned
                  ? t("quickStart.unpin", { label })
                  : t("quickStart.pin", { label })
              }
              aria-label={
                pinned
                  ? t("quickStart.unpin", { label })
                  : t("quickStart.pin", { label })
              }
              onClick={() => {
                if (pinned) onUnpin(item.id);
                else onPin(repairQuickStart(item));
              }}
              data-testid={pinned ? "quick-start-unpin" : "quick-start-pin"}
            >
              {pinned ? "★" : "☆"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
