/**
 * Idle detection: the decision, not the detector.
 *
 * Every client detects idleness its own way — `chrome.idle` in the extension's
 * service worker, `powerMonitor.getSystemIdleTime()` in the Electron shell, DOM
 * input events in the web app — and they all feed the same machine here, which
 * decides what should happen to the running timer. Nothing in this file touches
 * a DOM, a clock or a network: the caller supplies `atMs`, the running entry
 * and the resolved settings, and gets back a plan to execute.
 *
 * ── The cross-device rule ───────────────────────────────────────────────
 *
 * The timer is one thing shared by every device; idleness is a property of one
 * device. A laptop closing its lid says nothing about whether the person is
 * working — they may well be at the desktop, which is the entire reason the
 * sync exists. So a device may act on its own idle signal only when it can
 * claim the running entry, which takes two things:
 *
 *  1. **It opened the entry.** `noteLocalStart(id)` records what this device
 *     started; a device that merely *sees* a running entry over sync never
 *     touches it. This alone kills the headline bug — a second machine falling
 *     asleep cannot pause a timer it did not start. A client that opens the
 *     entry optimistically claims the temp id and then calls `noteServerId`
 *     once the server names it, which renames the claim without disturbing
 *     anything decided in between.
 *
 *  2. **Nothing has proved the person alive since.** Any sync event from a
 *     different origin means some other device just did something, so the
 *     person was at a keyboard then. `noteRemoteActivity(atMs)` moves the idle
 *     floor forward to that instant rather than cancelling outright, so a
 *     person who works on the desktop for an hour and then genuinely stops is
 *     still measured — from their last sign of life, not from ours.
 *
 * The two rejected alternatives, for the record: *"act only on the device that
 * started it"* alone still pauses the timer when someone starts on the laptop
 * and moves to the desktop without touching the timer; *"require the idle
 * signal from every connected device"* is the most correct rule of all, but it
 * needs devices to broadcast presence, which means a new sync event and a
 * heartbeat on the wire for a case the two rules above already cover.
 *
 * ── Never destroy tracked time ─────────────────────────────────────────
 *
 * A truncation ends the entry where input stopped. It is clamped so the entry
 * always survives with at least a second on it: an entry that fell entirely
 * inside the idle span becomes a one-second row (which the existing sub-minute
 * discard toast then offers to clean up) rather than an impossible `end <=
 * start` or a delete. Deleting is never something detection does on its own.
 */

// `IdleSettings` and its friends reach consumers through this package's index,
// which already re-exports `@starter/shared`. Importing rather than
// re-exporting them here keeps that from becoming two `export *` sources
// naming one symbol, which TypeScript rejects as ambiguous.
import type { IdleSettings, TimeEntry } from "@starter/shared";

/** What a detector saw. `locked` is a much stronger signal than `idle`. */
export type IdleSignal = "active" | "idle" | "locked";

/** The running entry, reduced to what the decision and a resume need. */
export type IdleTimerRef = Pick<
  TimeEntry,
  "id" | "start" | "description" | "projectId" | "taskId" | "billable"
>;

/** The fields a resumed entry carries over from the one that was paused. */
export type IdleResumeSeed = Pick<
  TimeEntry,
  "description" | "projectId" | "taskId" | "billable"
>;

/** When a truncation should reopen the work it closed. */
export type IdleResumeMode =
  /** Reopen immediately — the person is here, answering the prompt. */
  | "now"
  /** Reopen on the next sign of input. */
  | "on-return"
  /** Leave the timer stopped. */
  | "never";

/** An idle span waiting for the user to say what it was. */
export type PendingIdle = {
  entryId: string;
  /** ISO instant input stopped. Where "discard the idle time" truncates to. */
  idleStartedAt: string;
  /** ISO instant the threshold was crossed and this was raised. */
  detectedAt: string;
  /** Whole seconds between the two. */
  idleSec: number;
  signal: "idle" | "locked";
  /**
   * Where a truncation would actually end — `idleStartedAt`, clamped to stay
   * strictly after the entry's start so truncating can never destroy it.
   */
  truncateAt: string;
  seed: IdleResumeSeed;
};

/** What the caller should do about what the detector just reported. */
export type IdlePlan =
  | { kind: "none" }
  /** Show the prompt. The timer keeps running until an answer arrives. */
  | { kind: "prompt"; pending: PendingIdle }
  /** End `entryId` at `endAt`, then resume per `resume`. */
  | {
      kind: "truncate";
      entryId: string;
      endAt: string;
      idleStartedAt: string;
      idleSec: number;
      resume: IdleResumeMode;
      seed: IdleResumeSeed;
    }
  /** Open a new entry carrying `seed`, starting at `startAt`. */
  | { kind: "resume"; seed: IdleResumeSeed; startAt: string };

/** The answers the prompt offers. */
export type IdleAnswer =
  /** "I was working" — the idle span is real time, keep it. */
  | "keep"
  /** "I was away" — cut the entry back to the idle start and stay stopped. */
  | "discard"
  /** "I was away and I'm back" — cut it back and start a fresh entry now. */
  | "discard-and-resume";

export type IdleObservation = {
  signal: IdleSignal;
  /** Wall clock at the moment of observation. */
  atMs: number;
  /**
   * When input actually stopped, if the detector knows. `chrome.idle` fires
   * after its detection interval, so the idle began that long ago; a poller
   * reading a system idle counter knows it exactly. Defaults to `atMs`, which
   * makes the machine wait out the whole threshold itself.
   */
  idleSinceMs?: number;
  /** The running entry as this device currently understands it. */
  timer: IdleTimerRef | null;
  /** Workspace settings with the project override already applied. */
  settings: IdleSettings;
};

/**
 * Everything the watcher remembers between readings.
 *
 * It is separated out because one of its hosts cannot keep memory: Chrome
 * evicts an MV3 service worker after about 30 seconds and re-evaluates the
 * module to revive it, so an extension that kept ownership in a closure would
 * wake up believing it had never started anything and would therefore never
 * act. The worker persists this to `chrome.storage.local` instead.
 */
export type IdleWatcherState = {
  /** The entry this device opened — the only one it may act on. */
  ownedEntryId: string | null;
  /** No idle span may be considered to have begun before this instant. */
  idleFloorMs: number;
  pending: PendingIdle | null;
  /** Already prompted or acted on; stops a repeating detector re-firing. */
  settledEntryId: string | null;
  awaitingResume: IdleResumeSeed | null;
  /**
   * The entry a held resume was paused out of, so a caller's cache still
   * showing it open does not read as somebody starting something else.
   */
  pausedEntryId: string | null;
};

export type IdleWatcher = {
  /** Feed one detector reading. Returns what to do about it. */
  observe(observation: IdleObservation): IdlePlan;
  /** This device just opened `entryId`. Claims it for the ownership rule. */
  noteLocalStart(entryId: string, atMs: number): void;
  /**
   * The server named an entry this device had opened optimistically.
   *
   * A rename, not a second claim: everything the watcher decided while the
   * start was in flight — a prompt on screen, a resume waiting for the person
   * to come back — refers to the temp id and has to survive being renamed.
   * Calling `noteLocalStart` again instead would reset all of it, which is
   * exactly how a pause-and-resume lost its resume.
   *
   * A no-op once ownership has been released, so an entry this device has
   * already paused or stopped is not silently re-claimed.
   */
  noteServerId(tempId: string, entryId: string): void;
  /** This device just closed the timer; nothing is owned any more. */
  noteLocalStop(atMs: number): void;
  /** A sync event arrived from another origin — the person is alive elsewhere. */
  noteRemoteActivity(atMs: number): void;
  /** The idle span awaiting an answer, or null. */
  pending(): PendingIdle | null;
  /** Resolve a pending prompt. Returns the plan for the chosen answer. */
  answer(choice: IdleAnswer, atMs: number): IdlePlan;
  /** Forget everything — used when the session or the owner changes. */
  reset(): void;
  /** Everything worth persisting across a process that does not survive. */
  state(): IdleWatcherState;
  /** Adopt a previously persisted state. */
  restore(state: IdleWatcherState): void;
};

const NONE: IdlePlan = { kind: "none" };

/**
 * The smallest entry a truncation may leave behind. The server enforces
 * `end > start`, and an entry cut to nothing would have to be deleted instead —
 * which detection is never allowed to do on its own.
 */
const MIN_KEPT_MS = 1000;

const MS_PER_MINUTE = 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();

const seedFrom = (timer: IdleTimerRef): IdleResumeSeed => ({
  description: timer.description,
  projectId: timer.projectId,
  taskId: timer.taskId,
  billable: timer.billable,
});

/**
 * Build the pending record for an idle span, with the truncation point already
 * clamped. Exported so a caller can describe a span without owning a watcher —
 * which is what the tests do, and what a client that renders a prompt from a
 * span it was handed across a process boundary would do.
 */
export const describeIdleSpan = (args: {
  timer: IdleTimerRef;
  idleStartedAtMs: number;
  detectedAtMs: number;
  signal: "idle" | "locked";
}): PendingIdle => {
  const startMs = Date.parse(args.timer.start);
  const floor = Number.isNaN(startMs)
    ? args.idleStartedAtMs
    : startMs + MIN_KEPT_MS;

  return {
    entryId: args.timer.id,
    idleStartedAt: iso(args.idleStartedAtMs),
    detectedAt: iso(args.detectedAtMs),
    idleSec: Math.max(
      0,
      Math.floor((args.detectedAtMs - args.idleStartedAtMs) / 1000),
    ),
    signal: args.signal,
    truncateAt: iso(Math.max(args.idleStartedAtMs, floor)),
    seed: seedFrom(args.timer),
  };
};

const truncatePlan = (
  pending: PendingIdle,
  resume: IdleResumeMode,
): IdlePlan => ({
  kind: "truncate",
  entryId: pending.entryId,
  endAt: pending.truncateAt,
  idleStartedAt: pending.idleStartedAt,
  idleSec: pending.idleSec,
  resume,
  seed: pending.seed,
});

/**
 * A device's view of whether the person at it has stopped working.
 *
 * One per client. Drive it with `observe()` from whatever detector the platform
 * offers, keep it honest with `noteLocalStart`/`noteRemoteActivity`, and
 * execute whatever plan comes back.
 */
export const createIdleWatcher = (
  initial?: Partial<IdleWatcherState>,
): IdleWatcher => {
  /** The entry this device opened — the only one it may act on. */
  let ownedEntryId: string | null = initial?.ownedEntryId ?? null;

  /**
   * No idle span may be considered to have started before this instant. Moved
   * forward by proof of life (another device acting) and by the user answering
   * "keep", so the next window is measured from the last thing we actually
   * know about rather than from a stale input timestamp.
   */
  let idleFloorMs = initial?.idleFloorMs ?? 0;

  /** The prompt currently on screen, if the behaviour is `ask`. */
  let pendingIdle: PendingIdle | null = initial?.pending ?? null;

  /**
   * The entry this watcher has already acted on. Detectors repeat themselves —
   * a poller reports `idle` every tick, and the caller's cached running entry
   * lags the mutation — so without this the same span fires over and over.
   */
  let settledEntryId: string | null = initial?.settledEntryId ?? null;

  /** Set by a truncation with `resume: "on-return"`, spent on the next input. */
  let awaitingResume: IdleResumeSeed | null = initial?.awaitingResume ?? null;

  /**
   * The entry the held resume was paused out of.
   *
   * A caller's view of the running timer is a cache, and for a moment after a
   * pause it still holds the entry the pause just closed. Without this, that
   * lag read as "somebody started something else" and threw the resume away —
   * so a person who stepped away came back to a stopped timer, which is the
   * one thing pause-and-resume exists to prevent. Seeing our own just-closed
   * entry is a cache catching up, not news.
   */
  let pausedEntryId: string | null = initial?.pausedEntryId ?? null;

  const reset = (): void => {
    ownedEntryId = null;
    idleFloorMs = 0;
    pendingIdle = null;
    settledEntryId = null;
    awaitingResume = null;
    pausedEntryId = null;
  };

  const onActive = (atMs: number, timer: IdleTimerRef | null): IdlePlan => {
    if (awaitingResume === null) return NONE;

    // Something *else* is running again — another device started it, or the
    // user did it by hand. Reopening a second entry on top would be a
    // duplicate, and the one-running-timer invariant would stop the first one
    // to make room. The entry this pause just closed is the exception: a
    // caller still showing it has a cache that has not caught up with our own
    // write, and dropping the resume for that is how the timer stayed stopped.
    if (timer !== null && timer.id !== pausedEntryId) {
      awaitingResume = null;
      pausedEntryId = null;
      return NONE;
    }

    const seed = awaitingResume;
    awaitingResume = null;
    pausedEntryId = null;
    idleFloorMs = atMs;
    return { kind: "resume", seed, startAt: iso(atMs) };
  };

  const onIdle = (
    signal: "idle" | "locked",
    observation: IdleObservation,
    thresholdMs: number,
    reportedSince: number,
  ): IdlePlan => {
    const { atMs, timer, settings } = observation;

    if (timer === null) {
      // Nothing to act on. A prompt about an entry that no longer runs is
      // worse than no prompt: answering it would edit whatever runs next.
      pendingIdle = null;
      return NONE;
    }

    // Ownership rule 1: only the device that opened this entry may touch it.
    if (ownedEntryId !== timer.id) return NONE;
    // Already prompted or already acted on this entry's idle span.
    if (settledEntryId === timer.id || pendingIdle !== null) return NONE;

    const entryStartMs = Date.parse(timer.start);
    // Ownership rule 2 lives in `idleFloorMs`: proof of life from another
    // device restarts the clock rather than cancelling detection outright.
    const idleSinceMs = Math.max(
      reportedSince,
      idleFloorMs,
      Number.isNaN(entryStartMs) ? reportedSince : entryStartMs,
    );

    // Re-checked after clamping: another device's activity, or an entry that
    // began mid-span, can push the start forward past the threshold. NONE
    // rather than a sign of life — somebody else being at a keyboard says
    // nothing about whether the person at *this* one has come back.
    if (atMs - idleSinceMs < thresholdMs) return NONE;

    const pending = describeIdleSpan({
      timer,
      idleStartedAtMs: idleSinceMs,
      detectedAtMs: atMs,
      signal,
    });

    switch (settings.behavior) {
      case "keep-running":
        // Nothing is remembered: this behaviour has no state to settle, and
        // recording one would suppress a later change of behaviour.
        return NONE;

      case "ask":
        pendingIdle = pending;
        settledEntryId = timer.id;
        return { kind: "prompt", pending };

      case "pause-and-resume":
        settledEntryId = timer.id;
        awaitingResume = pending.seed;
        pausedEntryId = timer.id;
        ownedEntryId = null;
        return truncatePlan(pending, "on-return");

      case "stop":
        settledEntryId = timer.id;
        ownedEntryId = null;
        return truncatePlan(pending, "never");

      default:
        // A behaviour a newer server added. Doing nothing never loses time;
        // guessing at a truncation could.
        return NONE;
    }
  };

  return {
    observe: (observation) => {
      const { signal, atMs, timer, settings } = observation;
      if (signal === "active") return onActive(atMs, timer);
      if (!settings.enabled) return NONE;

      // A locked screen is someone deliberately walking away, so it does not
      // have to earn the threshold the way "no keys pressed" does.
      const thresholdMs =
        signal === "locked" && settings.lockIsImmediate
          ? 0
          : Math.max(0, settings.thresholdMinutes) * MS_PER_MINUTE;
      const reportedSince = Math.min(observation.idleSinceMs ?? atMs, atMs);

      // A span shorter than the threshold IS a sign of life, whatever the
      // detector chose to call it. Deciding that here rather than trusting the
      // label matters: a poller that reports its raw idle counter says "idle,
      // 3 seconds" for someone actively typing, and a resume waiting for them
      // to come back would never be spent.
      if (atMs - reportedSince < thresholdMs) return onActive(atMs, timer);

      return onIdle(signal, observation, thresholdMs, reportedSince);
    },

    noteLocalStart: (entryId, atMs) => {
      ownedEntryId = entryId;
      idleFloorMs = atMs;
      pendingIdle = null;
      settledEntryId = null;
      awaitingResume = null;
      pausedEntryId = null;
    },

    noteServerId: (tempId, entryId) => {
      if (ownedEntryId === tempId) ownedEntryId = entryId;
      if (settledEntryId === tempId) settledEntryId = entryId;
      if (pausedEntryId === tempId) pausedEntryId = entryId;
      if (pendingIdle !== null && pendingIdle.entryId === tempId) {
        pendingIdle = { ...pendingIdle, entryId };
      }
    },

    noteLocalStop: (atMs) => {
      ownedEntryId = null;
      idleFloorMs = atMs;
      pendingIdle = null;
      awaitingResume = null;
      pausedEntryId = null;
    },

    noteRemoteActivity: (atMs) => {
      if (atMs > idleFloorMs) idleFloorMs = atMs;
    },

    pending: () => pendingIdle,

    answer: (choice, atMs) => {
      const pending = pendingIdle;
      if (pending === null) return NONE;
      pendingIdle = null;

      if (choice === "keep") {
        // The idle span was work. Measure the next window from now, and let
        // this entry raise a prompt again if the person goes away for real.
        idleFloorMs = atMs;
        settledEntryId = null;
        return NONE;
      }

      ownedEntryId = null;
      idleFloorMs = atMs;
      return truncatePlan(
        pending,
        choice === "discard-and-resume" ? "now" : "never",
      );
    },

    reset,

    state: () => ({
      ownedEntryId,
      idleFloorMs,
      pending: pendingIdle,
      settledEntryId,
      awaitingResume,
      pausedEntryId,
    }),

    restore: (next) => {
      ownedEntryId = next.ownedEntryId;
      idleFloorMs = next.idleFloorMs;
      pendingIdle = next.pending;
      settledEntryId = next.settledEntryId;
      awaitingResume = next.awaitingResume;
      pausedEntryId = next.pausedEntryId;
    },
  };
};

/**
 * How the idle span reads in a prompt: "You have been idle for 42m."
 *
 * Deliberately not `formatDurationShort`, which drops to seconds — an idle
 * threshold is minutes at the shortest, and "0m" is a clearer statement of a
 * rounding artefact than "37s" is of an idle period.
 */
export const formatIdleSpan = (idleSec: number): string => {
  const minutes = Math.max(0, Math.round(idleSec / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
};
