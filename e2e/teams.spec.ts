import { readFile } from "node:fs/promises";

import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { TRACK_URL, logManualEntry, signUpViaUI } from "./helpers";
import { cleanDatabase, closeDbConnection } from "./db-utils";

/*
 * Teams, end to end, with two people in two browser contexts.
 *
 * One story rather than independent tests: every step needs the state the
 * previous one left (an invitation, a membership, entries by two authors), and
 * rebuilding that per test would be most of the runtime. `serial` mode skips
 * the rest of the story after the first failure instead of reporting a cascade
 * of consequences as separate bugs.
 *
 * The server runs with no SMTP configured, which is exactly the self-hosted
 * case the copyable invitation link exists for.
 */

const PASSWORD = "SecurePassword123!";

const OWNER_NAME = "Olga Owner";
const MEMBER_NAME = "Mia Member";
const SHARED_WORKSPACE = `${OWNER_NAME}'s workspace`;
const MEMBER_PERSONAL_WORKSPACE = `${MEMBER_NAME}'s workspace`;

const PROJECT_NAME = "Shared retainer";
/** A round rate, so the owner's hour is worth exactly 100. */
const PROJECT_RATE = "100";

const OWNER_ENTRY = "Owner planning";
const OWNER_DURATION = "1:00:00";
const MEMBER_ENTRY = "Member review";
const MEMBER_DURATION = "0:30:00";
const MEMBER_TIMER = "Member shared timer";
const MEMBER_PERSONAL_TIMER = "Member personal timer";
const MEMBER_OFFLINE_ENTRY = "Member offline notes";

const stamp = Date.now();
const OWNER_EMAIL = `teams-owner-${stamp}@example.com`;
const MEMBER_EMAIL = `teams-member-${stamp}@example.com`;
const CANCELED_EMAIL = `teams-canceled-${stamp}@example.com`;

/** What a report shows in place of withheld money (`MONEY_WITHHELD`). */
const WITHHELD = "—";
const MONEY_HEADERS = ["Rate", "Amount", "Currency"];

/** Local "YYYY-MM-DD", `offsetDays` away from today. */
function dayKey(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const RANGE_QUERY = `?from=${dayKey(-7)}&to=${dayKey(1)}`;

test.describe.configure({ mode: "serial" });

let ownerContext: BrowserContext;
let memberContext: BrowserContext;
let owner: Page;
let member: Page;
let inviteUrl = "";

async function newPage(browser: Browser): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  return [context, page];
}

test.beforeAll(async ({ browser }) => {
  await cleanDatabase();
  [ownerContext, owner] = await newPage(browser);
  [memberContext, member] = await newPage(browser);
});

test.afterAll(async () => {
  await ownerContext?.close();
  await memberContext?.close();
  await closeDbConnection();
});

// ── helpers ──────────────────────────────────────────────────────────

async function pickProject(page: Page, name: string): Promise<void> {
  await page.getByTestId("tracker-project").click();
  await page.getByTestId("combobox-search").fill(name);
  await page
    .locator('[data-testid^="combobox-option-"]')
    .filter({ hasText: name })
    .first()
    .click();
  await expect(page.getByTestId("tracker-project")).toContainText(name);
}

function entryRow(page: Page, description: string): Locator {
  return page.locator('[data-testid="entry-row"]').filter({ hasText: description });
}

async function openMembers(page: Page): Promise<void> {
  await page.goto("/app/track");
  await expect(page.getByTestId("track-page")).toBeVisible();
  // Reached from the nav, not typed: the destination has to be in NAV_SECTIONS.
  await page.getByTestId("nav-members").click();
  await expect(page.getByTestId("members-screen")).toBeVisible();
}

/** The Members-screen row for `email`, and the member id it is keyed by. */
async function memberRow(page: Page, email: string): Promise<[Locator, string]> {
  const row = page.locator('[data-testid^="member-row-"]').filter({ hasText: email });
  await expect(row).toHaveCount(1);
  const testId = (await row.getAttribute("data-testid")) ?? "";
  return [row, testId.slice("member-row-".length)];
}

async function switchTo(page: Page, workspaceName: string): Promise<void> {
  const switcher = page.getByTestId("workspace-switcher");
  await expect(switcher).toBeVisible();
  await switcher.click();
  const dialog = page.getByTestId("workspace-switcher-dialog");
  await expect(dialog).toBeVisible();
  const option = dialog.getByTestId("workspace-option").filter({ hasText: workspaceName });
  await expect(option).toHaveCount(1);
  const id = (await option.getAttribute("data-workspace-id")) ?? "";
  await option.click();
  await expect(dialog).toHaveCount(0);
  await expect(switcher).toHaveAttribute("data-workspace-id", id);
  await expect(switcher).toContainText(workspaceName);
}

/** Download the report on screen as CSV: its header names and its raw text. */
async function downloadReportCsv(page: Page): Promise<{ headers: string[]; text: string }> {
  await expect(page.getByTestId("report-export")).toBeEnabled();
  await page.getByTestId("report-export").click();
  await expect(page.getByTestId("report-export-menu")).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    page.getByTestId("report-export-csv").click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const text = (await readFile(path as string, "utf8")).replace(/^﻿+/, "");
  const headers = (text.split(/\r?\n/)[0] ?? "")
    .split(",")
    .map((header) => header.replace(/^"|"$/g, ""));
  return { headers, text };
}

async function openEntriesReport(page: Page): Promise<void> {
  await page.goto(`/app/reports${RANGE_QUERY}&view=entries`);
  await expect(page.getByTestId("detailed-report")).toBeVisible();
  await expect(page.getByTestId("detailed-table")).toBeVisible();
}

// ── the story ────────────────────────────────────────────────────────

test.describe("Teams", () => {
  test("owner invites by email and gets a copyable link with no SMTP", async () => {
    await signUpViaUI(owner, { name: OWNER_NAME, email: OWNER_EMAIL, password: PASSWORD });

    // A billable project with a rate, so money has something to hide.
    await owner.goto("/app/projects");
    await expect(owner.getByTestId("projects-page")).toBeVisible();
    await owner.getByTestId("new-project").click();
    await owner.getByTestId("project-name-input").fill(PROJECT_NAME);
    await owner.getByTestId("project-advanced-toggle").click();
    await owner.getByTestId("project-rate-input").fill(PROJECT_RATE);
    await owner.getByTestId("project-submit").click();
    await expect(owner.getByTestId("project-dialog")).toBeHidden();

    await owner.goto("/app/track");
    await expect(owner.getByTestId("entries-empty")).toBeVisible();
    await pickProject(owner, PROJECT_NAME);
    await expect(owner.getByTestId("tracker-billable")).toHaveAttribute("data-billable", "true");
    await logManualEntry(owner, OWNER_ENTRY, OWNER_DURATION);

    await openMembers(owner);
    await expect(owner.getByTestId("members-description")).toContainText(SHARED_WORKSPACE);
    await expect(owner.locator('[data-testid^="member-row-"]')).toHaveCount(1);
    // Alone in it: nobody to leave it to.
    await expect(owner.getByTestId("leave-workspace-blocked")).toBeVisible();

    await owner.getByTestId("invite-email").fill(MEMBER_EMAIL);
    await expect(owner.getByTestId("invite-role")).toHaveValue("member");
    await owner.getByTestId("invite-submit").click();

    await expect(owner.getByTestId("invite-link-panel")).toBeVisible();
    await expect(owner.getByTestId("invite-sent")).toHaveCount(0);
    const link = owner.getByTestId("invite-link");
    await expect(link).toHaveValue(/\/invite\/\?id=[^&]+$/);
    inviteUrl = await link.inputValue();
    // The link opens this web app's query-param page, never a dynamic segment.
    expect(new URL(inviteUrl).pathname).toBe("/invite/");
    expect(new URL(inviteUrl).origin).toBe(new URL(owner.url()).origin);

    const pending = owner.locator('[data-testid^="invitation-row-"]');
    await expect(pending).toHaveCount(1);
    await expect(pending).toContainText(MEMBER_EMAIL);
  });

  test("invitee creates an account from the link and accepts", async () => {
    expect(inviteUrl).not.toBe("");
    await member.goto(inviteUrl);
    await expect(member.getByTestId("invite-signed-out")).toBeVisible();
    await expect(member.getByTestId("invite-headline")).toContainText(SHARED_WORKSPACE);

    await member.getByTestId("invite-create-account").click();
    await expect(member.getByTestId("signup-email")).toHaveValue(MEMBER_EMAIL);
    await member.getByTestId("signup-name").fill(MEMBER_NAME);
    await member.getByTestId("signup-password").fill(PASSWORD);
    await member.getByTestId("signup-confirm-password").fill(PASSWORD);
    await member.getByTestId("signup-submit").click();

    // Signup returns to the invitation rather than dropping it.
    await member.waitForURL(/\/invite\/\?id=/, { timeout: 15_000 });
    await expect(member.getByTestId("invite-ready")).toBeVisible();
    await member.getByTestId("invite-accept").click();

    // Accepting lands in the joined workspace, with a switcher to leave it by.
    await member.waitForURL(TRACK_URL, { timeout: 15_000 });
    const switcher = member.getByTestId("workspace-switcher");
    await expect(switcher).toBeVisible();
    await expect(switcher).toContainText(SHARED_WORKSPACE);

    // Owner's side: the invitation turned into a membership with closed flags.
    await openMembers(owner);
    await expect(owner.locator('[data-testid^="member-row-"]')).toHaveCount(2);
    const [row, memberId] = await memberRow(owner, MEMBER_EMAIL);
    await expect(row).toHaveAttribute("data-role", "member");
    await expect(owner.locator('[data-testid^="invitation-row-"]')).toHaveCount(0);
    await expect(owner.getByTestId(`member-time-toggle-${memberId}`)).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    await expect(owner.getByTestId(`member-money-toggle-${memberId}`)).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    // The last owner of a shared workspace has to hand it over first.
    await expect(owner.getByTestId("leave-workspace-blocked")).toBeVisible();
  });

  test("member switches workspaces, and a timer started in one stops the other", async () => {
    await member.goto("/app/track");
    await switchTo(member, MEMBER_PERSONAL_WORKSPACE);
    await expect(member.getByTestId("entries-empty")).toBeVisible();

    await member.getByTestId("tracker-description").fill(MEMBER_PERSONAL_TIMER);
    await member.getByTestId("tracker-toggle").click();
    await expect(member.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "running");
    await expect(member.getByTestId("tracker-running-elsewhere")).toHaveCount(0);

    // In the shared workspace, the personal timer is named, not edited.
    await switchTo(member, SHARED_WORKSPACE);
    await expect(member.getByTestId("tracker-running-elsewhere")).toBeVisible();
    await expect(member.getByTestId("tracker-running-elsewhere")).toContainText(
      MEMBER_PERSONAL_WORKSPACE,
    );
    // The owner's entry is not the member's to see.
    await expect(entryRow(member, OWNER_ENTRY)).toHaveCount(0);

    // While another workspace's timer runs the bar offers Stop; stopping it
    // and starting here is the one-timer-per-person rule, visibly.
    if ((await member.getByTestId("tracker-toggle").getAttribute("data-state")) === "running") {
      // Wait for the server's answer, not only the optimistic idle state: a
      // stop that settles after the next start has been clicked refetches the
      // list from before that start and briefly drops its optimistic row.
      await Promise.all([
        member.waitForResponse((response) => response.url().includes("entries.stop")),
        member.getByTestId("tracker-toggle").click(),
      ]);
      await expect(member.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "idle");
      await expect(member.getByTestId("tracker-running-elsewhere")).toHaveCount(0);
    }
    await member.getByTestId("tracker-description").fill(MEMBER_TIMER);
    await member.getByTestId("tracker-toggle").click();
    await expect(member.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "running");
    await expect(member.getByTestId("tracker-running-elsewhere")).toHaveCount(0);
    const running = member.locator('[data-testid="entry-row"][data-running="true"]');
    await expect(running).toHaveCount(1);
    await expect(running).toContainText(MEMBER_TIMER);
    await expect(member.getByTestId("tracker-elapsed")).toHaveText(/^0:00:(?:0[1-9]|[1-5]\d)$/, {
      timeout: 15_000,
    });
    await member.getByTestId("tracker-toggle").click();
    await expect(member.getByTestId("tracker-toggle")).toHaveAttribute("data-state", "idle");
    await expect(running).toHaveCount(0);
    await expect
      .poll(async () => (await entryRow(member, MEMBER_TIMER).getAttribute("data-entry-id")) ?? "")
      .not.toMatch(/^temp-|^$/);

    // A billable half hour on the owner's project, for the money checks.
    await pickProject(member, PROJECT_NAME);
    await logManualEntry(member, MEMBER_ENTRY, MEMBER_DURATION);

    // Back in the personal workspace, the first timer is stopped.
    await switchTo(member, MEMBER_PERSONAL_WORKSPACE);
    const personal = entryRow(member, MEMBER_PERSONAL_TIMER);
    await expect(personal).toHaveCount(1);
    await expect(personal).toHaveAttribute("data-running", "false");
    await expect(entryRow(member, MEMBER_ENTRY)).toHaveCount(0);

    await switchTo(member, SHARED_WORKSPACE);
    await expect(entryRow(member, MEMBER_ENTRY)).toHaveCount(1);
  });

  test("owner's report shows every member's time and money, CSV included", async () => {
    await owner.goto(`/app/reports${RANGE_QUERY}&group=member`);
    await expect(owner.getByTestId("summary-report")).toBeVisible();
    await expect(owner.getByTestId("groupby-member")).toHaveAttribute("aria-pressed", "true");
    await expect(owner.locator('[data-testid^="summary-row-"]')).toHaveCount(2);
    await expect(owner.getByTestId("summary-table")).toContainText(OWNER_NAME);
    await expect(owner.getByTestId("summary-table")).toContainText(MEMBER_NAME);
    await expect(owner.getByTestId("kpi-amount")).toContainText("150");
    await expect(owner.getByTestId("report-money-hidden")).toHaveCount(0);

    const summary = await downloadReportCsv(owner);
    expect(summary.headers).toContain("Amount");
    expect(summary.text).toContain(OWNER_NAME);
    expect(summary.text).toContain(MEMBER_NAME);

    await openEntriesReport(owner);
    const table = owner.getByTestId("detailed-table");
    await expect(table).toContainText(OWNER_ENTRY);
    await expect(table).toContainText(MEMBER_ENTRY);
    await expect(table).toContainText(MEMBER_TIMER);
    await expect(table).not.toContainText(MEMBER_PERSONAL_TIMER);
    const detailed = await downloadReportCsv(owner);
    for (const header of MONEY_HEADERS) expect(detailed.headers).toContain(header);
    expect(detailed.text).toContain(MEMBER_ENTRY);
    expect(detailed.text).not.toContain(MEMBER_PERSONAL_TIMER);
  });

  test("a member with closed flags sees only their own time", async () => {
    await openEntriesReport(member);
    await expect(member.getByTestId("detailed-table")).toContainText(MEMBER_ENTRY);
    await expect(member.getByTestId("detailed-table")).not.toContainText(OWNER_ENTRY);
    // Their own money is theirs to see.
    await expect(member.getByTestId("kpi-amount")).toContainText("50");
    await expect(member.getByTestId("report-money-hidden")).toHaveCount(0);

    const csv = await downloadReportCsv(member);
    expect(csv.text).toContain(MEMBER_ENTRY);
    expect(csv.text).not.toContain(OWNER_ENTRY);
    expect(csv.headers).toContain("Amount");

    // No member grouping for somebody who can only see themselves, even from
    // a shared link that asks for it.
    await member.goto(`/app/reports${RANGE_QUERY}&group=member`);
    await expect(member.getByTestId("summary-report")).toBeVisible();
    await expect(member.getByTestId("groupby-member")).toHaveCount(0);
    await expect(member.getByTestId("groupby-project")).toHaveAttribute("aria-pressed", "true");
    await expect(member.getByTestId("summary-total-duration")).not.toHaveText(/^1:/);

    // A member does not manage people.
    await openMembers(member);
    await expect(member.getByTestId("invite-card")).toHaveCount(0);
    await expect(member.locator('[data-testid^="member-remove-"]')).toHaveCount(0);
    await expect(member.locator('[data-testid^="member-role-select-"]')).toHaveCount(0);
  });

  test("time opened, money closed: colleagues' hours without their rates", async () => {
    await openMembers(owner);
    const [, memberId] = await memberRow(owner, MEMBER_EMAIL);
    const timeToggle = owner.getByTestId(`member-time-toggle-${memberId}`);
    await timeToggle.click();
    await expect(timeToggle).toHaveAttribute("data-state", "checked");
    await owner.reload();
    await expect(owner.getByTestId(`member-time-toggle-${memberId}`)).toHaveAttribute(
      "data-state",
      "checked",
    );
    await expect(owner.getByTestId(`member-money-toggle-${memberId}`)).toHaveAttribute(
      "data-state",
      "unchecked",
    );

    await openEntriesReport(member);
    await expect(member.getByTestId("detailed-table")).toContainText(OWNER_ENTRY);
    await expect(member.getByTestId("detailed-table")).toContainText(MEMBER_ENTRY);
    await expect(member.getByTestId("report-money-hidden")).toBeVisible();
    await expect(member.getByTestId("kpi-amount")).toHaveText(WITHHELD);
    const ownerRow = member.locator('[data-testid^="detailed-row-"]').filter({ hasText: OWNER_ENTRY });
    await expect(ownerRow).toHaveCount(1);
    await expect(ownerRow).toContainText(WITHHELD);
    await expect(ownerRow).not.toContainText("100");

    const csv = await downloadReportCsv(member);
    expect(csv.text).toContain(OWNER_ENTRY);
    for (const header of MONEY_HEADERS) expect(csv.headers).not.toContain(header);
    expect(csv.text).not.toMatch(/\b100(?:\.00)?\b/);

    // The member now sees colleagues, so the member dimension is offered.
    await member.goto(`/app/reports${RANGE_QUERY}&group=member`);
    await expect(member.getByTestId("groupby-member")).toHaveAttribute("aria-pressed", "true");
    await expect(member.locator('[data-testid^="summary-row-"]')).toHaveCount(2);
    await expect(member.getByTestId("summary-total-amount")).toHaveText(WITHHELD);
    const summary = await downloadReportCsv(member);
    expect(summary.headers).not.toContain("Amount");

    // The whole-workspace export says its rates are withheld.
    await member.goto("/app/settings?tab=data");
    await expect(member.getByTestId("export-panel")).toBeVisible();
    await expect(member.getByTestId("export-redacted")).toBeVisible();
  });

  test("money opened: amounts reach the member", async () => {
    await openMembers(owner);
    const [, memberId] = await memberRow(owner, MEMBER_EMAIL);
    const moneyToggle = owner.getByTestId(`member-money-toggle-${memberId}`);
    await moneyToggle.click();
    await expect(moneyToggle).toHaveAttribute("data-state", "checked");

    await openEntriesReport(member);
    await expect(member.getByTestId("report-money-hidden")).toHaveCount(0);
    await expect(member.getByTestId("kpi-amount")).toContainText("150");
    const csv = await downloadReportCsv(member);
    expect(csv.text).toContain(OWNER_ENTRY);
    for (const header of MONEY_HEADERS) expect(csv.headers).toContain(header);

    await member.goto("/app/settings?tab=data");
    await expect(member.getByTestId("export-panel")).toBeVisible();
    await expect(member.getByTestId("export-count")).toContainText("in this range");
    await expect(member.getByTestId("export-redacted")).toHaveCount(0);
  });

  test("owner changes the member's role", async () => {
    await openMembers(owner);
    const [, memberId] = await memberRow(owner, MEMBER_EMAIL);
    await owner.getByTestId(`member-role-select-${memberId}`).selectOption("admin");
    await expect((await memberRow(owner, MEMBER_EMAIL))[0]).toHaveAttribute("data-role", "admin");
    await owner.reload();
    await expect((await memberRow(owner, MEMBER_EMAIL))[0]).toHaveAttribute("data-role", "admin");

    // An admin manages invitations, but may only invite members, and never
    // touches the owner.
    await openMembers(member);
    await expect(member.getByTestId("invite-card")).toBeVisible();
    await expect(member.getByTestId("invite-role-admin")).toHaveCount(0);
    const [ownerRow, ownerMemberId] = await memberRow(member, OWNER_EMAIL);
    await expect(ownerRow).toHaveAttribute("data-role", "owner");
    await expect(member.getByTestId(`member-remove-${ownerMemberId}`)).toHaveCount(0);
    await expect(member.getByTestId(`member-transfer-${ownerMemberId}`)).toHaveCount(0);

    // And back.
    await owner.getByTestId(`member-role-select-${memberId}`).selectOption("member");
    await expect((await memberRow(owner, MEMBER_EMAIL))[0]).toHaveAttribute("data-role", "member");
  });

  test("owner removes the member while their offline entry is queued; it is held, not replayed elsewhere", async () => {
    // The member tracks with no network, into the shared workspace.
    await member.goto("/app/track");
    await expect(member.getByTestId("workspace-switcher")).toContainText(SHARED_WORKSPACE);
    await expect(entryRow(member, MEMBER_ENTRY)).toHaveCount(1);
    await memberContext.setOffline(true);
    await expect(member.getByTestId("offline-indicator")).toBeVisible();

    await member.getByTestId("tracker-manual-open").click();
    await member.getByTestId("manual-entry-description").fill(MEMBER_OFFLINE_ENTRY);
    await member.getByTestId("manual-entry-duration").fill("0:15:00");
    await member.getByTestId("manual-entry-duration").press("Enter");
    await member.getByTestId("manual-entry-add").click();
    await expect(member.getByTestId("manual-entry-dialog")).toHaveCount(0);
    await expect(member.getByTestId("offline-pending")).toHaveAttribute("data-pending", "1");

    // Meanwhile, on the owner's device.
    await openMembers(owner);
    const [, memberId] = await memberRow(owner, MEMBER_EMAIL);
    await owner.getByTestId(`member-remove-${memberId}`).click();
    const dialog = owner.getByTestId("member-remove-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("confirm-accept").click();
    await expect(owner.locator('[data-testid^="member-row-"]')).toHaveCount(1);

    // Back online: the queued row names a workspace the member has left. It
    // is neither sent there, nor sent to the personal workspace, nor dropped.
    await memberContext.setOffline(false);
    await expect(member.getByTestId("offline-indicator")).toHaveCount(0);
    await expect(member.getByTestId("offline-foreign")).toHaveAttribute("data-foreign", "1", {
      timeout: 20_000,
    });
    await expect(member.getByTestId("offline-pending")).toHaveCount(0);

    // The workspace keeps the removed member's tracked time, and only that.
    await openEntriesReport(owner);
    await expect(owner.getByTestId("detailed-table")).toContainText(MEMBER_ENTRY);
    await expect(owner.getByTestId("detailed-table")).not.toContainText(MEMBER_OFFLINE_ENTRY);

    // A fresh load of the member's device: the stored active workspace is
    // gone, so it lands in the personal one, with the held row still counted.
    await member.goto("/app/track");
    await expect(member.getByTestId("track-page")).toBeVisible();
    await expect(entryRow(member, MEMBER_PERSONAL_TIMER)).toHaveCount(1, { timeout: 15_000 });
    await expect(member.getByTestId("workspace-switcher")).toHaveCount(0);
    await expect(entryRow(member, MEMBER_ENTRY)).toHaveCount(0);
    await expect(entryRow(member, MEMBER_OFFLINE_ENTRY)).toHaveCount(0);
    await expect(member.getByTestId("offline-foreign")).toHaveAttribute("data-foreign", "1");

    await openMembers(member);
    await expect(member.getByTestId("members-description")).toContainText(
      MEMBER_PERSONAL_WORKSPACE,
    );

    // Settings → Devices names the work and the workspace it was meant for.
    await member.goto("/app/settings?tab=devices");
    const group = member.getByTestId("foreign-queue-group");
    await expect(group).toHaveCount(1);
    await expect(group).toContainText(MEMBER_OFFLINE_ENTRY);

    // The old invitation link cannot be replayed to get back in.
    await member.goto(inviteUrl);
    await expect(member.getByTestId("invite-accepted")).toBeVisible();
    await expect(member.getByTestId("invite-accept")).toHaveCount(0);
  });

  test("a removed member can be invited again; another account sees a mismatch", async () => {
    await openMembers(owner);
    await owner.getByTestId("invite-email").fill(MEMBER_EMAIL);
    await owner.getByTestId("invite-submit").click();
    const link = owner.getByTestId("invite-link");
    await expect(link).toHaveValue(/\/invite\/\?id=/);
    const secondUrl = await link.inputValue();
    expect(secondUrl).not.toBe(inviteUrl);

    // Opened by the wrong signed-in account, the page says so and offers no Accept.
    await owner.goto(secondUrl);
    await expect(owner.getByTestId("invite-mismatch")).toBeVisible();
    await expect(owner.getByTestId("invite-accept")).toHaveCount(0);

    await member.goto(secondUrl);
    await expect(member.getByTestId("invite-ready")).toBeVisible();
    await member.getByTestId("invite-accept").click();
    await member.waitForURL(TRACK_URL, { timeout: 15_000 });
    await expect(member.getByTestId("workspace-switcher")).toContainText(SHARED_WORKSPACE);

    // Rejoining starts from closed defaults, not the flags held before removal.
    await openMembers(owner);
    const [row, memberId] = await memberRow(owner, MEMBER_EMAIL);
    await expect(row).toHaveAttribute("data-role", "member");
    await expect(owner.getByTestId(`member-time-toggle-${memberId}`)).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    await expect(owner.getByTestId(`member-money-toggle-${memberId}`)).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  test("owner cancels a pending invitation and its link stops working", async () => {
    await openMembers(owner);
    await owner.getByTestId("invite-email").fill(CANCELED_EMAIL);
    await owner.getByTestId("invite-submit").click();
    const link = owner.getByTestId("invite-link");
    await expect(link).toHaveValue(/\/invite\/\?id=/);
    const canceledUrl = await link.inputValue();

    const pending = owner.locator('[data-testid^="invitation-row-"]').filter({ hasText: CANCELED_EMAIL });
    await expect(pending).toHaveCount(1);
    const invitationId = ((await pending.getAttribute("data-testid")) ?? "").slice(
      "invitation-row-".length,
    );
    await owner.getByTestId(`invitation-cancel-${invitationId}`).click();
    await expect(pending).toHaveCount(0);

    await member.goto(canceledUrl);
    await expect(member.getByTestId("invite-canceled")).toBeVisible();
    await expect(member.getByTestId("invite-accept")).toHaveCount(0);
  });

  test("owner transfers ownership, then leaves; the workspace keeps an owner", async () => {
    await openMembers(owner);
    const [, memberId] = await memberRow(owner, MEMBER_EMAIL);
    await owner.getByTestId(`member-transfer-${memberId}`).click();
    const dialog = owner.getByTestId("member-transfer-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("confirm-accept").click();

    await expect((await memberRow(owner, MEMBER_EMAIL))[0]).toHaveAttribute("data-role", "owner");
    await expect((await memberRow(owner, OWNER_EMAIL))[0]).toHaveAttribute("data-role", "admin");
    // No longer the last owner, so leaving is allowed.
    await expect(owner.getByTestId("leave-workspace-blocked")).toHaveCount(0);
    await expect(owner.getByTestId("leave-workspace-button")).toBeEnabled();

    await owner.getByTestId("leave-workspace-button").click();
    const leave = owner.getByTestId("leave-workspace-dialog");
    await expect(leave).toBeVisible();
    await leave.getByTestId("confirm-accept").click();
    await owner.waitForURL(TRACK_URL, { timeout: 15_000 });

    // This was the former owner's only workspace: they land in a fresh one.
    // It carries the same generated name ("<name>'s workspace"), so it is
    // told apart by what is in it, not by what it is called.
    await expect(owner.getByTestId("track-page")).toBeVisible();
    await expect(owner.getByTestId("entries-empty")).toBeVisible({ timeout: 15_000 });
    await expect(owner.getByTestId("workspace-switcher")).toHaveCount(0);
    await openMembers(owner);
    await expect(owner.locator('[data-testid^="member-row-"]')).toHaveCount(1);
    await expect((await memberRow(owner, OWNER_EMAIL))[0]).toHaveAttribute("data-role", "owner");
    await owner.goto(`/app/reports${RANGE_QUERY}&view=entries`);
    await expect(owner.getByTestId("detailed-empty")).toBeVisible();

    // The new owner is alone in the shared workspace, with its history.
    await openMembers(member);
    await expect(member.getByTestId("members-description")).toContainText(SHARED_WORKSPACE);
    await expect(member.locator('[data-testid^="member-row-"]')).toHaveCount(1);
    await expect((await memberRow(member, MEMBER_EMAIL))[0]).toHaveAttribute("data-role", "owner");
    await expect(member.getByTestId("leave-workspace-blocked")).toBeVisible();
    await openEntriesReport(member);
    await expect(member.getByTestId("detailed-table")).toContainText(OWNER_ENTRY);
    await expect(member.getByTestId("kpi-amount")).toContainText("150");
  });
});
