import type { JSX } from "react";

type LoadingSkeletonProps = {
  label: string;
  variant?: "entries" | "suggestions" | "detail" | "settings" | "devices";
  testId?: string;
};

/** Keep the coming content recognizable without exposing fake controls. */
export function LoadingSkeleton({
  label,
  variant = "entries",
  testId,
}: LoadingSkeletonProps): JSX.Element {
  const form = variant === "detail";
  const settings = variant === "settings";
  return (
    <div className={`loading-skeleton loading-skeleton--${variant}`} role="status" aria-label={label} data-testid={testId}>
      <div aria-hidden="true">
        {variant === "entries" && <div className="loading-skeleton__heading"><span className="skeleton-block" /></div>}
        {Array.from({ length: form ? 4 : 3 }, (_, index) => (
          <div className="loading-skeleton__row" key={index}>
            {(variant === "devices" || variant === "suggestions") && <span className="skeleton-block loading-skeleton__icon" />}
            <div className="loading-skeleton__text">
              <span className="skeleton-block loading-skeleton__title" style={{ width: `${[62, 46, 72, 54][index]}%` }} />
              <span className={`skeleton-block ${form ? "loading-skeleton__input" : "loading-skeleton__hint"}`} />
            </div>
            {!form && <span className={`skeleton-block ${settings ? "loading-skeleton__control" : "loading-skeleton__value"}`} />}
          </div>
        ))}
      </div>
    </div>
  );
}
