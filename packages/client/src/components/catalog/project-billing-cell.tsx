"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { useFormatSettings } from "@/lib/format";
import {
  billingChanged,
  type ApplyToEntriesPrompt,
} from "./apply-to-entries-prompt";
import type { ProjectRow } from "./types";
import type { ProjectMutations } from "./use-catalog-mutations";

export type ProjectBillingCellProps = {
  project: ProjectRow;
  /** Shared by every row, so the table renders one prompt dialog. */
  prompt: ApplyToEntriesPrompt;
  /** Passed in rather than hooked per row: a table of rows, one set of mutations. */
  updateProject: ProjectMutations["updateProject"];
};

/** Empty is "use the workspace default"; anything else must be 0 or more. */
function parseRate(raw: string): number | null | "invalid" {
  if (raw.trim() === "") return null;
  const parsed = Number(raw.trim().replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : "invalid";
}

/**
 * Billable default and hourly rate in one cell, editable in place.
 *
 * One column rather than two because the rate only means something for
 * billable time. A project with no rate of its own shows the workspace default
 * it falls back to, marked as such, so the number that new entries will
 * actually be billed at is on screen without opening Settings.
 */
export function ProjectBillingCell({
  project,
  prompt,
  updateProject,
}: ProjectBillingCellProps): React.JSX.Element {
  const format = useFormatSettings();
  const defaultRate = format.settings.defaultHourlyRate;

  const [open, setOpen] = React.useState(false);
  const [billable, setBillable] = React.useState(project.billableDefault);
  const [rate, setRate] = React.useState("");
  const [rateError, setRateError] = React.useState<string | null>(null);

  const openEditor = (next: boolean): void => {
    if (next) {
      // Re-read on every open: the row may have changed since the last one.
      setBillable(project.billableDefault);
      setRate(project.hourlyRate === null ? "" : String(project.hourlyRate));
      setRateError(null);
    }
    setOpen(next);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const hourlyRate = parseRate(rate);
    if (hourlyRate === "invalid") {
      setRateError("Enter a rate of 0 or more, or leave it empty");
      return;
    }
    const next = { billableDefault: billable, hourlyRate };
    // Close first: the prompt is a dialog of its own, and a popover left open
    // underneath it would hold focus the dialog needs.
    setOpen(false);
    if (!billingChanged(project, next)) return;

    void prompt.ask(project, next).then(async (choice) => {
      if (choice === null) return;
      const saved = await updateProject({
        id: project.id,
        ...next,
        applyToEntries: choice === "entries",
      });
      if (!saved) return;
      const rewritten = saved.entriesRewritten;
      toast.success(
        rewritten && rewritten.entries > 0
          ? `Billing saved and ${rewritten.entries} ${
              rewritten.entries === 1 ? "entry" : "entries"
            } updated.`
          : "Billing saved for new entries.",
      );
    });
  };

  const effectiveRate = project.hourlyRate ?? defaultRate;

  return (
    <Popover open={open} onOpenChange={openEditor}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-mx-2 h-auto min-h-8 gap-2 px-2 py-1 text-sm font-normal"
          aria-label={`Edit billing for ${project.name}`}
          data-testid={`project-billing-${project.id}`}
          data-billable={project.billableDefault ? "true" : "false"}
        >
          {project.billableDefault ? (
            <>
              <Badge variant="secondary">Billable</Badge>
              <span
                className="tabular-nums"
                data-testid={`project-rate-${project.id}`}
              >
                {format.money(effectiveRate)}/h
                {project.hourlyRate === null ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    default
                  </span>
                ) : null}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground/70">Non-billable</span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-72"
        data-testid={`project-billing-editor-${project.id}`}
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`project-billing-billable-${project.id}`}>
              Billable by default
            </Label>
            <Switch
              id={`project-billing-billable-${project.id}`}
              checked={billable}
              onCheckedChange={setBillable}
              data-testid="project-billing-billable"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`project-billing-rate-${project.id}`}>
              Hourly rate ({format.currency})
            </Label>
            <Input
              id={`project-billing-rate-${project.id}`}
              inputMode="decimal"
              value={rate}
              disabled={!billable}
              placeholder={`Default: ${format.money(defaultRate)}`}
              aria-invalid={rateError !== null}
              onChange={(event) => {
                setRate(event.target.value);
                if (rateError) setRateError(null);
              }}
              data-testid="project-billing-rate"
            />
            {rateError ? (
              <p
                className="text-sm text-destructive"
                data-testid="project-billing-rate-error"
              >
                {rateError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {billable
                  ? "Leave empty to use the workspace default."
                  : "Non-billable time carries no rate."}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              data-testid="project-billing-save"
            >
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
