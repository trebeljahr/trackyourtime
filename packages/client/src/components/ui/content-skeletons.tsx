"use client";

import { useT } from "@/i18n/use-t";
import { Skeleton } from "@/components/ui/skeleton";

/** Layout-shaped placeholders with one translated loading status per region. */
export function ListSkeleton({ rows = 4, avatar = false }: { rows?: number; avatar?: boolean }) {
  const t = useT("common");
  return (
    <div role="status" aria-label={t("status.loading")} className="divide-y divide-border/60 rounded-lg border border-border/60">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-4">
          {avatar && <Skeleton className="size-9 shrink-0 rounded-full" />}
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 max-w-full" style={{ width: [144, 112, 176, 128][index % 4] }} />
            <Skeleton className="h-2.5 max-w-full opacity-60" style={{ width: [208, 168, 136, 192][index % 4] }} />
          </div>
          <Skeleton className="hidden h-3 w-20 sm:block" />
          <Skeleton className="h-6 w-14 shrink-0 rounded-full opacity-70" />
        </div>
      ))}
    </div>
  );
}

export function CalendarSkeleton() {
  const t = useT("common");
  return (
    <div role="status" aria-label={t("status.loading")} className="overflow-hidden rounded-lg border border-border/60">
      <div className="grid grid-cols-7 border-b border-border/60 bg-muted/20 py-4">
        {Array.from({ length: 7 }, (_, index) => <Skeleton key={index} className="mx-auto h-3 w-6 sm:w-10" />)}
      </div>
      <div className="grid grid-cols-7 divide-x divide-border/60">
        {Array.from({ length: 7 }, (_, index) => (
          <div key={index} className="relative h-80 bg-[repeating-linear-gradient(to_bottom,transparent,transparent_63px,var(--border)_64px)] p-1.5 sm:p-3">
            <Skeleton className="absolute inset-x-1.5 rounded-md sm:inset-x-3" style={{ top: [40, 104, 72, 168, 40, 136, 88][index], height: [76, 108, 52, 84, 124, 60, 92][index] }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TimesheetSkeleton() {
  const t = useT("common");
  return (
    <div role="status" aria-label={t("status.loading")} className="overflow-hidden rounded-lg border border-border/60">
      {Array.from({ length: 6 }, (_, row) => (
        <div key={row} className={`flex items-center gap-3 px-4 py-4 ${row === 0 ? "bg-muted/30" : "border-t border-border/60"}`}>
          <Skeleton className="h-3 w-20 shrink-0 sm:w-40" />
          <div className="grid flex-1 grid-cols-7 gap-2 sm:gap-6">
            {Array.from({ length: 7 }, (_, day) => <Skeleton key={day} className={`mx-auto h-3 w-full max-w-8 ${row > 0 && (row + day) % 3 === 0 ? "opacity-30" : ""}`} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
