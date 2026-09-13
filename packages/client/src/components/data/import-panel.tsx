"use client";

import * as React from "react";
import { FileUp, Loader2, Upload } from "lucide-react";
import {
  MAX_IMPORT_BYTES,
  formatDurationShort,
  type ImportColumnOverride,
  type ImportColumnRole,
  type ImportDateOrder,
  type ImportPreview,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { trpc } from "@/lib/trpc";
import { ImportPreviewView, pluralEntries } from "./import-preview";

/** File types the picker offers. Anything text-shaped is attempted anyway. */
const ACCEPT = ".csv,.tsv,.txt,.json,text/csv,text/plain,application/json";

const megabytes = (bytes: number): string =>
  `${(bytes / 1_000_000).toFixed(1)} MB`;

type Options = {
  timeZone: string;
  dateOrder: ImportDateOrder | undefined;
  skipDuplicates: boolean;
  createMissing: boolean;
  defaultBillable: boolean;
};

const defaultOptions = (): Options => ({
  // The file's wall-clock readings mean what they meant where the person was
  // working, and that is overwhelmingly where they are now.
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  dateOrder: undefined,
  skipDuplicates: true,
  createMissing: true,
  defaultBillable: false,
});

/**
 * Drop a file in, see what it would do, then let it do it.
 *
 * The file's text is kept in this component for the whole flow, because the
 * commit sends it again rather than referring back to a preview: the server
 * re-parses instead of trusting anything the client hands back, so the only
 * way the import can differ from what was approved is if the file itself
 * changed.
 */
export function ImportPanel(): React.JSX.Element {
  const utils = trpc.useUtils();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [filename, setFilename] = React.useState<string | null>(null);
  const [text, setText] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [overrides, setOverrides] = React.useState<ImportColumnOverride[]>([]);
  const [options, setOptions] = React.useState<Options>(defaultOptions);
  const [dragging, setDragging] = React.useState(false);

  const analyze = trpc.data.analyze.useMutation();
  const commit = trpc.data.commit.useMutation();

  const reset = React.useCallback((): void => {
    setFilename(null);
    setText(null);
    setPreview(null);
    setOverrides([]);
    setOptions(defaultOptions());
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  /** One place that talks to `analyze`, so every re-read uses the same input. */
  const runAnalyze = React.useCallback(
    async (
      body: string,
      name: string | null,
      nextOverrides: ImportColumnOverride[],
      nextOptions: Options,
    ): Promise<void> => {
      try {
        const result = await analyze.mutateAsync({
          text: body,
          filename: name ?? undefined,
          timeZone: nextOptions.timeZone,
          dateOrder: nextOptions.dateOrder,
          columns: nextOverrides,
          skipDuplicates: nextOptions.skipDuplicates,
          createMissing: nextOptions.createMissing,
          defaultBillable: nextOptions.defaultBillable,
        });
        setPreview(result);
      } catch (error) {
        setPreview(null);
        toast.error(
          error instanceof Error ? error.message : "Could not read that file",
        );
      }
    },
    [analyze],
  );

  const acceptFile = React.useCallback(
    async (file: File): Promise<void> => {
      if (file.size > MAX_IMPORT_BYTES) {
        toast.error(
          `That file is ${megabytes(file.size)}; the limit is ${megabytes(MAX_IMPORT_BYTES)}. Export it in date ranges and import the parts.`,
        );
        return;
      }
      const body = await file.text();
      const fresh = defaultOptions();
      setFilename(file.name);
      setText(body);
      setOverrides([]);
      setOptions(fresh);
      await runAnalyze(body, file.name, [], fresh);
    },
    [runAnalyze],
  );

  const handleRoleChange = React.useCallback(
    (index: number, role: ImportColumnRole): void => {
      if (!text) return;
      const next = [
        ...overrides.filter((column) => column.index !== index),
        { index, role },
      ];
      setOverrides(next);
      void runAnalyze(text, filename, next, options);
    },
    [filename, options, overrides, runAnalyze, text],
  );

  const handleDateOrderChange = React.useCallback(
    (dateOrder: ImportDateOrder): void => {
      if (!text) return;
      const next = { ...options, dateOrder };
      setOptions(next);
      void runAnalyze(text, filename, overrides, next);
    },
    [filename, options, overrides, runAnalyze, text],
  );

  const setOption = React.useCallback(
    <Key extends keyof Options>(key: Key, value: Options[Key]): void => {
      const next = { ...options, [key]: value };
      setOptions(next);
      // Only the two options that change what the preview COUNTS are worth a
      // round trip; the rest only matter at commit time.
      if (text && (key === "skipDuplicates" || key === "createMissing")) {
        void runAnalyze(text, filename, overrides, next);
      }
    },
    [filename, options, overrides, runAnalyze, text],
  );

  const handleImport = React.useCallback((): void => {
    if (!text) return;
    void (async () => {
      try {
        const result = await commit.mutateAsync({
          text,
          filename: filename ?? undefined,
          timeZone: options.timeZone,
          dateOrder: options.dateOrder,
          columns: overrides,
          skipDuplicates: options.skipDuplicates,
          createMissing: options.createMissing,
          defaultBillable: options.defaultBillable,
          originId: ORIGIN_ID,
        });
        toast.success(
          `Imported ${result.entriesCreated} ${result.entriesCreated === 1 ? "entry" : "entries"} — ${formatDurationShort(result.totalSec)} of tracked time.`,
        );
        reset();
        await Promise.all([
          utils.entries.invalidate(),
          utils.reports.invalidate(),
          utils.clients.invalidate(),
          utils.projects.invalidate(),
          utils.tasks.invalidate(),
          utils.tags.invalidate(),
          utils.data.history.invalidate(),
        ]);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not import that file",
        );
      }
    })();
  }, [commit, filename, options, overrides, reset, text, utils]);

  const busy = analyze.isPending || commit.isPending;

  return (
    <Card data-testid="import-panel">
      <CardHeader>
        <CardTitle>Import your history</CardTitle>
        <CardDescription>
          Bring in the time you tracked somewhere else. Export it from the
          other tool as CSV, drop the file here, and check what it would create
          before anything is written. A Track Your Time export (CSV or JSON) works
          too.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void acceptFile(file);
          }}
          className={
            dragging
              ? "flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-primary bg-primary/5 p-8 text-center"
              : "flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center"
          }
          data-testid="import-dropzone"
        >
          <FileUp className="size-6 text-muted-foreground" />
          <p className="text-sm">
            {filename ? (
              <span className="font-medium">{filename}</span>
            ) : (
              "Drop a CSV or JSON export here"
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            data-testid="import-choose-file"
          >
            {analyze.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {filename ? "Choose a different file" : "Choose a file"}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void acceptFile(file);
            }}
            data-testid="import-file-input"
          />
        </div>

        {preview ? (
          <>
            <div className="space-y-3 rounded-md border p-3">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  Skip entries already here
                  <span className="block text-xs text-muted-foreground">
                    Lets you re-import an overlapping export without doubling
                    anything.
                  </span>
                </span>
                <Switch
                  checked={options.skipDuplicates}
                  onCheckedChange={(value) =>
                    setOption("skipDuplicates", value)
                  }
                  disabled={busy}
                  data-testid="import-skip-duplicates"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  Create missing projects, clients, tasks and tags
                  <span className="block text-xs text-muted-foreground">
                    Off, entries land with only the catalog you already have.
                  </span>
                </span>
                <Switch
                  checked={options.createMissing}
                  onCheckedChange={(value) => setOption("createMissing", value)}
                  disabled={busy}
                  data-testid="import-create-missing"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  Treat unmarked entries as billable
                  <span className="block text-xs text-muted-foreground">
                    Only used for rows whose file says nothing either way.
                  </span>
                </span>
                <Switch
                  checked={options.defaultBillable}
                  onCheckedChange={(value) =>
                    setOption("defaultBillable", value)
                  }
                  disabled={busy}
                  data-testid="import-default-billable"
                />
              </label>
            </div>

            <ImportPreviewView
              preview={preview}
              onRoleChange={handleRoleChange}
              onDateOrderChange={handleDateOrderChange}
              busy={busy}
            />
          </>
        ) : null}
      </CardContent>

      {preview ? (
        <CardFooter className="justify-end gap-2">
          <Button type="button" variant="ghost" onClick={reset} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleImport}
            disabled={busy || preview.readyRows === 0}
            data-testid="import-commit"
          >
            {commit.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Import {preview.readyRows} {pluralEntries(preview.readyRows)}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
