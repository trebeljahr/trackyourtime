"use client";

import * as React from "react";
import { FileJson, FileSpreadsheet, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { canDownloadFiles } from "@/components/reports/export-menu";
import { downloadBlob } from "@/lib/download";
import { trpc } from "@/lib/trpc";

const stamp = (): string => new Date().toISOString().slice(0, 10);

const count = (value: number): string => value.toLocaleString("en-US");

/**
 * Everything out, in one click.
 *
 * Two formats because they answer different questions. The JSON carries the
 * whole workspace — archived catalog entries, colors, project rates and
 * budgets, workspace settings, the caller's own pinned quick starts, and the
 * issued invoices for reference — and is what this app's own importer reads
 * back. The CSV carries what a spreadsheet can hold, in the exact column
 * shape the importer recognises, so editing history in a spreadsheet and
 * importing it back is a supported round trip rather than a lucky one.
 *
 * The panel asks the server what the download WOULD be before building it
 * (`data.exportInfo`), because both things worth saying are things the file
 * itself says too late: that it is above the cap the export refuses at, and
 * that its rates were blanked because this member may not see other members'
 * money. A backup nobody was told was partial is indistinguishable from a
 * complete one until the day it is restored.
 */
export function ExportPanel(): React.JSX.Element {
  const [pending, setPending] = React.useState<"json" | "csv" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");

  // Empty means "everything ever tracked", which is what the schema's absent
  // `from`/`to` already mean — so the blank field is passed as absence rather
  // than as an empty string the date parser would have to reject.
  const range = React.useMemo(
    () => ({ from: from || undefined, to: to || undefined }),
    [from, to],
  );

  const info = trpc.data.exportInfo.useQuery(range);
  const overCap = info.data ? info.data.entries > info.data.maxEntries : false;

  // Mutations, not queries, because the server serves both doors as mutations:
  // a GET would put the whole workspace — every entry, rate and invoice — in
  // a URL-keyed response that any cache between here and the browser may keep.
  const buildJson = trpc.data.exportJson.useMutation();
  const buildCsv = trpc.data.exportCsv.useMutation();

  const run = React.useCallback(
    (kind: "json" | "csv", task: () => Promise<void>): void => {
      if (!canDownloadFiles()) {
        toast.error(
          "This app can't save files yet — open Track Your Time in a browser to export.",
        );
        return;
      }
      setPending(kind);
      setError(null);
      void (async () => {
        try {
          await task();
        } catch (caught) {
          const message =
            caught instanceof Error ? caught.message : "Could not export";
          // Both, deliberately. The toast is what the user sees at the moment
          // of the click; the inline region is what is still on screen when
          // they look back at the panel wondering where their file went — a
          // refusal that has faded is indistinguishable from a download that
          // silently produced nothing.
          setError(message);
          toast.error(message);
        } finally {
          setPending(null);
        }
      })();
    },
    [],
  );

  const exportJson = React.useCallback((): void => {
    run("json", async () => {
      const data = await buildJson.mutateAsync(range);
      const filename = `trackyourtime-export-${stamp()}.json`;
      downloadBlob(
        filename,
        new Blob([JSON.stringify(data, null, 2)], {
          type: "application/json",
        }),
      );
      toast.success(`Exported ${count(data.entries.length)} entries.`);
    });
  }, [buildJson, range, run]);

  const exportCsv = React.useCallback((): void => {
    run("csv", async () => {
      const result = await buildCsv.mutateAsync(range);
      downloadBlob(
        result.filename,
        // The server already writes the BOM Excel needs.
        new Blob([result.csv], { type: "text/csv;charset=utf-8;" }),
      );
      toast.success(`Exported ${result.filename}`);
    });
  }, [buildCsv, range, run]);

  return (
    <Card data-testid="export-panel">
      <CardHeader>
        <CardTitle>Export everything</CardTitle>
        <CardDescription>
          Your whole workspace, in a file you keep. The JSON holds entries,
          clients, projects, tasks, tags, workspace settings and your pinned
          quick starts, and imports back; issued invoices ride along as a
          record and are not re-created on import. The CSV holds the entries,
          in a shape any spreadsheet opens and this importer reads back.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="export-from">From</Label>
            <Input
              id="export-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              data-testid="export-from"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="export-to">To</Label>
            <Input
              id="export-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              data-testid="export-to"
            />
          </div>
          <p className="text-xs text-muted-foreground" data-testid="export-count">
            {info.data
              ? `${count(info.data.entries)} ${info.data.entries === 1 ? "entry" : "entries"} in this range.`
              : "Leave both dates empty to export everything ever tracked."}
          </p>
        </div>

        {overCap && info.data ? (
          <p className="text-sm text-destructive" data-testid="export-too-large">
            That is more than {count(info.data.maxEntries)} entries — more than
            one file carries. Narrow the dates and export it in parts, so no
            part is quietly missing.
          </p>
        ) : null}

        {info.data?.moneyRedacted ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="export-redacted"
          >
            Every rate is left out of your download — the rate on each entry
            as well as project rates, budgets and invoice amounts, because an
            entry&rsquo;s rate is a copy of the project&rsquo;s. Your role does
            not include other members&rsquo; money. Times, catalog and
            everything else are complete.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={exportJson}
            disabled={pending !== null || overCap}
            data-testid="export-json"
          >
            {pending === "json" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileJson className="size-4" />
            )}
            Download JSON backup
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={exportCsv}
            disabled={pending !== null || overCap}
            data-testid="export-csv"
          >
            {pending === "csv" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileSpreadsheet className="size-4" />
            )}
            Download CSV
          </Button>
        </div>

        {error ? (
          <p className="text-sm text-destructive" data-testid="export-error">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
