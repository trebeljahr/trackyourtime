"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import {
  IDLE_BEHAVIORS,
  projectBillableByDefault,
  type IdleBehavior,
} from "@starter/shared";

import { ColorPicker, COLOR_PALETTE } from "@/components/color-picker";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import type { Translator } from "@/i18n/translator";
import { translate, useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useApplyToEntriesPrompt } from "./apply-to-entries-prompt";
import {
  useClientMutations,
  useProjectMutations,
} from "./use-catalog-mutations";
import type { ClientRow, ProjectRow } from "./types";

export type ProjectFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omitted/null creates; otherwise the dialog edits this project. */
  project?: ProjectRow | null;
  clients: ClientRow[];
  /**
   * Called with the newly created project. Lets a caller act on the result —
   * the tracker's project picker selects it immediately, so "New project…"
   * leaves you ready to start the timer.
   */
  onCreated?: (project: { id: string; name: string }) => void;
};

const FALLBACK_COLOR = COLOR_PALETTE[0] ?? "#4f46e5";

/** Sentinel for a field that was filled in with something unusable. */
const INVALID = Symbol("invalid");

/**
 * An optional numeric target: empty means "no target" (null), anything else
 * must parse to a number of 0 or more. Zero is a legitimate target and must
 * survive the round trip as 0, never as null.
 */
function parseTarget(raw: string): number | null | typeof INVALID {
  if (raw.trim() === "") return null;
  const parsed = Number(raw.trim().replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return INVALID;
  return parsed;
}

/** An idle behaviour's option label, in the rendered language. */
function idleBehaviorLabel(
  t: Translator<"catalog">,
  behavior: IdleBehavior,
): string {
  switch (behavior) {
    case "ask":
      return t("projects.form.idle.behaviors.ask");
    case "pause-and-resume":
      return t("projects.form.idle.behaviors.pauseAndResume");
    case "keep-running":
      return t("projects.form.idle.behaviors.keepRunning");
    case "stop":
      return t("projects.form.idle.behaviors.stop");
    default:
      // A behaviour a newer server added: its id beats a crash or a key path.
      return String(behavior);
  }
}

/**
 * Create/edit dialog. The body is only mounted while `open`, so every field
 * re-initialises from props on each open without an effect syncing state.
 */
export function ProjectFormDialog({
  open,
  onOpenChange,
  project,
  clients,
  onCreated,
}: ProjectFormDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="project-dialog">
        {open ? (
          <ProjectForm
            key={project?.id ?? "new"}
            project={project ?? null}
            clients={clients}
            onDone={(created) => {
              onOpenChange(false);
              if (created) onCreated?.(created);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type ProjectFormProps = {
  project: ProjectRow | null;
  clients: ClientRow[];
  /** Receives the created project on create; nothing on edit. */
  onDone: (created?: { id: string; name: string }) => void;
};

function ProjectForm({
  project,
  clients,
  onDone,
}: ProjectFormProps): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  const { currency, money, settings } = useFormatSettings();

  const [name, setName] = React.useState(project?.name ?? "");
  const [color, setColor] = React.useState(project?.color ?? FALLBACK_COLOR);
  const [clientId, setClientId] = React.useState<string | null>(
    project?.clientId ?? null
  );
  const [billableDefault, setBillableDefault] = React.useState(
    project?.billableDefault ?? true
  );
  const [rate, setRate] = React.useState(
    project?.hourlyRate === null || project?.hourlyRate === undefined
      ? ""
      : String(project.hourlyRate)
  );
  const [estimate, setEstimate] = React.useState(
    project?.estimatedHours === null || project?.estimatedHours === undefined
      ? ""
      : String(project.estimatedHours)
  );
  const [budget, setBudget] = React.useState(
    project?.budgetAmount === null || project?.budgetAmount === undefined
      ? ""
      : String(project.budgetAmount)
  );
  const [idleBehavior, setIdleBehavior] = React.useState<IdleBehavior | "">(
    project?.idleBehavior ?? ""
  );
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [rateError, setRateError] = React.useState<string | null>(null);
  const [estimateError, setEstimateError] = React.useState<string | null>(null);
  const [budgetError, setBudgetError] = React.useState<string | null>(null);

  // Only a name is needed to make a project. Billing and limits open on their
  // own for a project that already carries one, so editing never hides a value
  // that is in force.
  const [showAdvanced, setShowAdvanced] = React.useState(
    !billableDefault ||
      rate !== "" ||
      estimate !== "" ||
      budget !== "" ||
      idleBehavior !== ""
  );

  // A budget keeps the currency it was agreed in. Only a project without one
  // yet picks up today's workspace currency.
  const budgetCurrency = project?.budgetCurrency ?? currency;

  const { createProject, updateProject, isSaving } = useProjectMutations({
    onConflict: setNameError,
  });
  const { createClient, updateClient } = useClientMutations();
  const applyPrompt = useApplyToEntriesPrompt();

  const clientOptions = React.useMemo<ComboboxOption[]>(
    () =>
      clients
        .filter((client) => !client.archived || client.id === project?.clientId)
        .map((client) => ({
          value: client.id,
          label: client.archived
            ? t("row.archivedName", { name: client.name })
            : client.name,
          color: client.color,
        })),
    [clients, project?.clientId, t]
  );

  const selectedClient = React.useMemo(
    () => clients.find((client) => client.id === clientId) ?? null,
    [clients, clientId]
  );

  const handleCreateClient = (rawName: string): void => {
    void createClient({ name: rawName.trim() }).then((created) => {
      if (created) setClientId(created.id);
    });
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setNameError(null);
    setRateError(null);
    setEstimateError(null);
    setBudgetError(null);

    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError(t("form.nameRequired"));
      return;
    }

    let hourlyRate: number | null = null;
    if (rate.trim() !== "") {
      const parsed = Number(rate.trim().replace(",", "."));
      if (!Number.isFinite(parsed) || parsed < 0) {
        setRateError(t("projects.billing.rateInvalid"));
        setShowAdvanced(true);
        return;
      }
      hourlyRate = parsed;
    }

    // An empty field means "no target" and is sent as null; 0 is a target the
    // project is already over. The two must never collapse into each other.
    const estimatedHours = parseTarget(estimate);
    if (estimatedHours === INVALID) {
      setEstimateError(t("projects.form.targets.estimateInvalid"));
      setShowAdvanced(true);
      return;
    }
    const budgetAmount = parseTarget(budget);
    if (budgetAmount === INVALID) {
      setBudgetError(t("projects.form.targets.budgetInvalid"));
      setShowAdvanced(true);
      return;
    }
    // "" is the inherit option, and has to reach the server as null rather
    // than being dropped — otherwise clearing an override would be a no-op.
    const idle: IdleBehavior | null = idleBehavior === "" ? null : idleBehavior;

    if (project) {
      // A billing change asks first whether it reaches the time already
      // booked here; backing out of that question leaves the form open.
      void applyPrompt
        .ask(project, { billableDefault, hourlyRate })
        .then(async (choice) => {
          if (choice === null) return;
          const saved = await updateProject({
            id: project.id,
            name: trimmed,
            color,
            clientId,
            billableDefault,
            hourlyRate,
            estimatedHours,
            budgetAmount,
            ...(budgetAmount === null ? {} : { budgetCurrency }),
            idleBehavior: idle,
            applyToEntries: choice === "entries",
          });
          if (!saved) return;
          const rewritten = saved.entriesRewritten?.entries ?? 0;
          const messages = translate("catalog");
          toast.success(
            rewritten > 0
              ? messages("projects.form.savedWithEntries", { count: rewritten })
              : messages("projects.form.saved"),
          );
          onDone();
        });
      return;
    }

    void createProject({
      name: trimmed,
      color,
      clientId,
      billableDefault,
      hourlyRate,
      estimatedHours,
      budgetAmount,
      ...(budgetAmount === null ? {} : { budgetCurrency }),
      idleBehavior: idle,
    }).then((created) => {
      if (!created) return;
      toast.success(
        translate("catalog")("projects.form.created", { name: created.name }),
      );
      onDone(created);
    });
  };

  // The switch is on but the rate the form would save resolves to 0: the
  // server answers `billableDefault: false` for that, so say so before Save.
  const rateTarget = parseTarget(rate);
  const billsNothing =
    billableDefault &&
    rateTarget !== INVALID &&
    !projectBillableByDefault(
      { billableDefault: true, hourlyRate: rateTarget },
      settings.defaultHourlyRate,
    );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>
          {project ? t("projects.form.titleEdit") : t("projects.form.titleNew")}
        </DialogTitle>
        <DialogDescription>{t("projects.form.description")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="project-name">{tc("fields.name")}</Label>
        <div className="flex items-center gap-2">
          <ColorPicker
            value={color}
            onChange={setColor}
            testId="project-color"
          />
          <Input
            id="project-name"
            value={name}
            autoFocus
            maxLength={120}
            placeholder={t("projects.form.namePlaceholder")}
            aria-invalid={nameError !== null}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError(null);
            }}
            data-testid="project-name-input"
          />
        </div>
        {nameError ? (
          <p
            className="text-sm text-destructive"
            data-testid="project-name-error"
          >
            {nameError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="project-client">{tc("fields.client")}</Label>
        {/* The swatch is only rendered once a client is chosen: with none
            selected there is no colour to show, and a picker standing in for
            one would edit nothing. Typing a name and taking the "Create"
            row is the single way to coin a client from here — it lands
            selected, and its colour is then editable in place rather than
            being whatever the server happened to assign. */}
        <div className="flex items-center gap-2">
          {selectedClient ? (
            <ColorPicker
              value={selectedClient.color}
              onChange={(next) => {
                void updateClient({ id: selectedClient.id, color: next });
              }}
              testId="project-client-color"
            />
          ) : null}
          <Combobox
            id="project-client"
            className="min-w-0 flex-1"
            options={clientOptions}
            value={clientId}
            onChange={setClientId}
            placeholder={tc("empty.noClient")}
            searchPlaceholder={t("projects.form.client.search")}
            emptyText={t("projects.form.client.empty")}
            allowClear
            clearLabel={tc("empty.noClient")}
            onCreate={handleCreateClient}
            data-testid="project-client-combobox"
          />
        </div>
      </div>

      {/* Everything below is optional and inherits a workspace default when
          left alone, so it is folded away on create — a new project needs a
          name and nothing else. It opens by itself whenever a value is
          actually set, so an edit never hides one that is in force, and a
          validation error in here forces it open rather than reporting a
          problem the user cannot see. */}
      <div className="rounded-md border border-border">
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start gap-1 px-3 font-normal"
          aria-expanded={showAdvanced}
          aria-controls="project-advanced"
          onClick={() => setShowAdvanced((shown) => !shown)}
          data-testid="project-advanced-toggle"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 transition-transform",
              showAdvanced && "rotate-90"
            )}
          />
          {t("projects.form.advanced.toggle")}
          <span className="ml-auto text-xs text-muted-foreground">
            {t("projects.form.advanced.summary")}
          </span>
        </Button>

        {showAdvanced ? (
          <div
            id="project-advanced"
            className="space-y-4 border-t border-border p-3"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="project-billable">
                  {t("projects.billing.billableByDefault")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("projects.form.billableHint")}
                </p>
              </div>
              <Switch
                id="project-billable"
                checked={billableDefault}
                onCheckedChange={setBillableDefault}
                data-testid="project-billable-switch"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-rate">
                {t("projects.billing.hourlyRate", { currency })}
              </Label>
              <NumberInput
                id="project-rate"
                value={rate}
                min={0}
                placeholder={t("projects.billing.ratePlaceholder", {
                  amount: money(settings.defaultHourlyRate),
                })}
                aria-invalid={rateError !== null}
                onValueChange={(next) => {
                  setRate(next);
                  if (rateError) setRateError(null);
                }}
                data-testid="project-rate-input"
              />
              <p
                className="text-xs text-muted-foreground"
                data-testid="project-rate-hint"
              >
                {billsNothing
                  ? t("projects.billing.zeroRateHint")
                  : t("projects.form.rateHint")}
              </p>
              {rateError ? (
                <p
                  className="text-sm text-destructive"
                  data-testid="project-rate-error"
                >
                  {rateError}
                </p>
              ) : null}
            </div>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">
                {t("projects.form.targets.legend")}
              </legend>
              <p className="text-xs text-muted-foreground">
                {t("projects.form.targets.hint")}
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="project-estimate">
                    {t("projects.form.targets.estimate")}
                  </Label>
                  <NumberInput
                    id="project-estimate"
                    value={estimate}
                    min={0}
                    placeholder={t("projects.form.targets.estimatePlaceholder")}
                    aria-invalid={estimateError !== null}
                    onValueChange={(next) => {
                      setEstimate(next);
                      if (estimateError) setEstimateError(null);
                    }}
                    data-testid="project-estimate-input"
                  />
                  {estimateError ? (
                    <p
                      className="text-sm text-destructive"
                      data-testid="project-estimate-error"
                    >
                      {estimateError}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="project-budget">
                    {t("projects.form.targets.budget", {
                      currency: budgetCurrency,
                    })}
                  </Label>
                  <NumberInput
                    id="project-budget"
                    value={budget}
                    min={0}
                    placeholder={t("projects.noBudget")}
                    aria-invalid={budgetError !== null}
                    onValueChange={(next) => {
                      setBudget(next);
                      if (budgetError) setBudgetError(null);
                    }}
                    data-testid="project-budget-input"
                  />
                  {budgetError ? (
                    <p
                      className="text-sm text-destructive"
                      data-testid="project-budget-error"
                    >
                      {budgetError}
                    </p>
                  ) : null}
                </div>
              </div>

              {project?.budgetCurrency !== null &&
              project?.budgetCurrency !== undefined &&
              project.budgetCurrency !== currency ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="project-budget-currency-note"
                >
                  {t("projects.form.targets.currencyNote", {
                    budgetCurrency: project.budgetCurrency,
                    currency,
                  })}
                </p>
              ) : null}
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor="project-idle">
                {t("projects.form.idle.label")}
              </Label>
              <select
                id="project-idle"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={idleBehavior}
                onChange={(event) =>
                  setIdleBehavior(event.target.value as IdleBehavior | "")
                }
                data-testid="project-idle-behavior"
              >
                <option value="">{t("projects.form.idle.inherit")}</option>
                {IDLE_BEHAVIORS.map((behavior) => (
                  <option key={behavior} value={behavior}>
                    {idleBehaviorLabel(t, behavior)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t("projects.form.idle.hint", {
                  keepRunning: idleBehaviorLabel(t, "keep-running"),
                })}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          // Wrapped: onDone takes an optional created project, and passing it
          // straight to onClick would hand it the mouse event instead.
          onClick={() => onDone()}
          data-testid="project-cancel"
        >
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" disabled={isSaving} data-testid="project-submit">
          {project ? t("form.saveChanges") : t("projects.form.create")}
        </Button>
      </DialogFooter>
      {applyPrompt.dialog}
    </form>
  );
}
