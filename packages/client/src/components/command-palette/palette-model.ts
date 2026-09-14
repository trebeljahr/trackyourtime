import {
  BarChart3,
  Play,
  RotateCcw,
  Square,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  quickStartHint,
  quickStartLabel,
  repairQuickStart,
  type QuickStart,
  type QuickStartItem,
} from "@starter/core";

import type { DateRange } from "@/components/date-range-picker";
import type { StartTimerArgs } from "@/components/tracker/use-entry-mutations";
import { entriesHref, type EntryFilterDimension } from "@/lib/entry-links";
import type { NavItem } from "@/lib/nav";
import type { Translator } from "@/i18n/translator";

type ShellT = Translator<"shell">;

/**
 * What the command palette offers, as plain data.
 *
 * Built here rather than inside the component so the grouping — which rows
 * exist in which state, and what each one does — is testable without cmdk,
 * Radix or a query client. The component renders these rows and hands the
 * chosen `action` to a runner that owns the mutation hooks; nothing in this
 * file writes anything.
 *
 * Every string comes from the `shell` catalog through the translator the
 * caller passes in, so the model stays pure and a test picks its language.
 */

export type PaletteAction =
  | { kind: "stop" }
  /** Opens the confirmation page. Discarding tracked time is never one key. */
  | { kind: "discard-confirm" }
  | { kind: "discard" }
  | { kind: "back" }
  | { kind: "start"; fields: StartTimerArgs }
  | { kind: "quick-start"; quick: QuickStart }
  | { kind: "navigate"; href: string };

export type PaletteItem = {
  /** cmdk identity. Unique across the whole palette. */
  id: string;
  label: string;
  hint: string | null;
  /**
   * What the search matches against. The first entry is always the label; the
   * rest are the bare names, so typing a project's name scores both of its
   * rows equally and the one rendered first — Start — is the one Enter runs.
   */
  keywords: string[];
  icon: LucideIcon;
  /** A catalog colour dot in place of the icon. */
  color: string | null;
  destructive: boolean;
  action: PaletteAction;
};

export type PaletteGroupId =
  | "timer"
  | "navigate"
  | "projects"
  | "clients"
  | "tasks"
  | "tags"
  | "discard";

export type PaletteGroup = {
  id: PaletteGroupId;
  heading: string;
  items: PaletteItem[];
};

export type PaletteSection = {
  heading: string | null;
  items: NavItem[];
};

export type PaletteProject = {
  id: string;
  name: string;
  color: string;
  clientName: string | null;
  billableDefault: boolean;
  archived: boolean;
};

export type PaletteNamedRow = {
  id: string;
  name: string;
  archived: boolean;
  color?: string;
};

export type PaletteRunning = {
  description: string;
  /** Already formatted for display, e.g. "1:02:03". */
  elapsed: string;
};

export type PaletteInput = {
  running: PaletteRunning | null;
  quickStarts: readonly QuickStartItem[];
  sections: readonly PaletteSection[];
  projects: readonly PaletteProject[];
  clients: readonly PaletteNamedRow[];
  tasks: readonly PaletteNamedRow[];
  tags: readonly PaletteNamedRow[];
  /** The range a "filtered report" link opens over. */
  reportRange: DateRange;
  /**
   * True once something is typed. The catalog groups appear only then: with
   * an empty query they would be two rows per project before the palette has
   * been asked anything, burying Timer and Go to under the catalog.
   */
  searching: boolean;
  t: ShellT;
};

/** A comma-separated keyword message as a list, so each word scores alone. */
const words = (message: string): string[] =>
  message
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");

const row = (
  item: Omit<PaletteItem, "hint" | "color" | "destructive" | "keywords"> & {
    hint?: string | null;
    color?: string | null;
    destructive?: boolean;
    keywords?: (string | null | undefined)[];
  },
): PaletteItem => ({
  ...item,
  hint: item.hint ?? null,
  color: item.color ?? null,
  destructive: item.destructive ?? false,
  keywords: [
    item.label,
    ...(item.keywords ?? []).filter(
      (keyword): keyword is string =>
        typeof keyword === "string" && keyword.trim() !== "",
    ),
  ],
});

const runningLabel = (running: PaletteRunning, t: ShellT): string =>
  running.description.trim() === ""
    ? t("palette.actions.noDescription")
    : running.description;

const reportRow = (
  t: ShellT,
  dimension: EntryFilterDimension,
  target: { id: string; name: string; color?: string | null },
  range: DateRange,
  hint: string | null = null,
): PaletteItem =>
  row({
    id: `report-${dimension}-${target.id}`,
    label: t("palette.actions.openReport", { name: target.name }),
    hint,
    keywords: [target.name, hint],
    icon: BarChart3,
    action: {
      kind: "navigate",
      href: entriesHref({ dimension, id: target.id }, range),
    },
  });

const timerGroup = (input: PaletteInput): PaletteGroup => {
  const { t } = input;
  const items: PaletteItem[] = [];

  if (input.running === null) {
    items.push(
      row({
        id: "timer-start",
        label: t("palette.actions.startTimer"),
        icon: Play,
        keywords: words(t("palette.keywords.start")),
        action: {
          kind: "start",
          fields: {
            description: "",
            projectId: null,
            taskId: null,
            billable: false,
            tagIds: [],
          },
        },
      }),
    );
  } else {
    const label = runningLabel(input.running, t);
    items.push(
      row({
        id: "timer-stop",
        label: t("palette.actions.stopTimer"),
        hint: `${label} · ${input.running.elapsed}`,
        icon: Square,
        keywords: [label, ...words(t("palette.keywords.stop"))],
        action: { kind: "stop" },
      }),
      row({
        id: "timer-discard",
        label: t("palette.actions.discardRunning"),
        hint: label,
        icon: Trash2,
        keywords: [label, ...words(t("palette.keywords.discard"))],
        destructive: true,
        action: { kind: "discard-confirm" },
      }),
    );
  }

  // Favorites before recents, in the order the quick-start menu shows them —
  // `useQuickStarts` has already merged and deduplicated the two tiers.
  for (const item of input.quickStarts) {
    const label = quickStartLabel(item);
    const hint = quickStartHint(item);
    const favorite = item.kind === "favorite";
    items.push(
      row({
        id: favorite ? `favorite-${item.id}` : `recent-${item.key}`,
        label: favorite
          ? t("palette.actions.startFavorite", { label })
          : t("palette.actions.continueRecent", { label }),
        hint,
        icon: favorite ? Star : RotateCcw,
        color: item.projectColor,
        keywords: [
          label,
          hint,
          ...words(
            favorite
              ? t("palette.keywords.favorite")
              : t("palette.keywords.recent"),
          ),
        ],
        action: { kind: "quick-start", quick: repairQuickStart(item) },
      }),
    );
  }

  return { id: "timer", heading: t("palette.groups.timer"), items };
};

const navigateGroup = (input: PaletteInput): PaletteGroup => ({
  id: "navigate",
  heading: input.t("palette.groups.navigate"),
  items: input.sections.flatMap((section) =>
    section.items.map((item) =>
      row({
        id: `nav-${item.href.replace(/^\/+/, "").replace(/\//g, "-")}`,
        label: item.label,
        hint: section.heading,
        icon: item.icon,
        keywords: [
          section.heading,
          ...words(input.t("palette.keywords.navigate")),
        ],
        action: { kind: "navigate", href: item.href },
      }),
    ),
  ),
});

const catalogGroups = (input: PaletteInput): PaletteGroup[] => {
  const { t } = input;
  const range = input.reportRange;
  const live = <T extends { archived: boolean }>(rows: readonly T[]): T[] =>
    rows.filter((candidate) => !candidate.archived);

  const projects: PaletteItem[] = live(input.projects).flatMap((project) => [
    row({
      id: `start-project-${project.id}`,
      label: t("palette.actions.startOn", { name: project.name }),
      hint: project.clientName,
      icon: Play,
      color: project.color,
      keywords: [project.name, project.clientName],
      action: {
        kind: "start",
        fields: {
          description: "",
          projectId: project.id,
          taskId: null,
          // The composer adopts a project's billable default when one is
          // picked; a start from here is the same decision made faster.
          billable: project.billableDefault,
          tagIds: [],
        },
      },
    }),
    reportRow(t, "project", project, range, project.clientName),
  ]);

  const clients: PaletteItem[] = live(input.clients).map((client) =>
    reportRow(t, "client", client, range),
  );

  const tasks: PaletteItem[] = live(input.tasks).flatMap((task) => [
    row({
      id: `start-task-${task.id}`,
      label: t("palette.actions.startOn", { name: task.name }),
      icon: Play,
      keywords: [task.name],
      action: {
        kind: "start",
        fields: {
          description: "",
          projectId: null,
          taskId: task.id,
          billable: false,
          tagIds: [],
        },
      },
    }),
    reportRow(t, "task", task, range),
  ]);

  const tags: PaletteItem[] = live(input.tags).map((tag) =>
    reportRow(t, "tag", tag, range),
  );

  const groups: PaletteGroup[] = [
    { id: "projects", heading: t("palette.groups.projects"), items: projects },
    { id: "clients", heading: t("palette.groups.clients"), items: clients },
    { id: "tasks", heading: t("palette.groups.tasks"), items: tasks },
    { id: "tags", heading: t("palette.groups.tags"), items: tags },
  ];
  return groups.filter((group) => group.items.length > 0);
};

/** Every group on the palette's first page, in render order. */
export const buildPaletteGroups = (input: PaletteInput): PaletteGroup[] => {
  const groups = [timerGroup(input), navigateGroup(input)];
  if (input.searching) groups.push(...catalogGroups(input));
  return groups.filter((group) => group.items.length > 0);
};

/**
 * The confirmation page for discarding the running timer: the destructive row
 * names what goes, and the other one goes back rather than closing, so a
 * mistaken Enter on the first page costs nothing.
 */
export const buildDiscardGroups = (
  running: PaletteRunning,
  t: ShellT,
): PaletteGroup[] => {
  const label = runningLabel(running, t);
  return [
    {
      id: "discard",
      heading: t("palette.groups.discard"),
      items: [
        row({
          id: "discard-keep",
          label: t("palette.actions.keepRunning"),
          icon: Play,
          keywords: words(t("palette.keywords.keep")),
          action: { kind: "back" },
        }),
        row({
          id: "discard-confirm",
          label: t("palette.actions.confirmDiscard", {
            elapsed: running.elapsed,
            label,
          }),
          hint: t("palette.actions.confirmDiscardHint"),
          icon: Trash2,
          keywords: words(t("palette.keywords.confirmDiscard")),
          destructive: true,
          action: { kind: "discard" },
        }),
      ],
    },
  ];
};

/**
 * cmdk's filter over `keywords` instead of the item's `value`.
 *
 * The value is an identity (`start-project-<id>`), and scoring it would let a
 * run of digits in a search match an id nobody can see. The best keyword wins,
 * so a row is found by its label and by each bare name it carries.
 */
export const scorePaletteItem = (
  score: (text: string, search: string) => number,
  search: string,
  keywords: readonly string[] | undefined,
): number => {
  if (search.trim() === "") return 1;
  let best = 0;
  for (const keyword of keywords ?? []) {
    best = Math.max(best, score(keyword, search));
  }
  return best;
};
