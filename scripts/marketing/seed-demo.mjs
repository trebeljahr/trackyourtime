#!/usr/bin/env node
/**
 * Seeds one plausible freelancer's month into a running tracktime server, for
 * screenshots of the marketing pages and the store listings.
 *
 *   node scripts/marketing/seed-demo.mjs http://127.0.0.1:52417 http://localhost:52419
 *
 * The second argument is the web app origin the server trusts: better-auth
 * refuses a sign-up that names no origin at all.
 *
 * Every client, project and description here is invented. Screenshots of real
 * client names are a privacy problem the moment they are public, and
 * screenshots of an empty app sell nothing. The data is deterministic (a fixed
 * seed), so a re-run on a fresh database draws the same month.
 *
 * Prints the demo account's email and password at the end. Never point this at
 * the production API: it signs up a real account on whatever server it is given.
 */

const baseUrl = (process.argv[2] ?? "").replace(/\/$/, "");
const webOrigin = (process.argv[3] ?? "").replace(/\/$/, "");
const local = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;
if (!local.test(baseUrl) || !local.test(webOrigin)) {
  console.error("Usage: seed-demo.mjs http://127.0.0.1:<api-port> http://localhost:<web-port>  (local servers only)");
  process.exit(1);
}

const EMAIL = process.env.DEMO_EMAIL ?? `maya.lindgren+${Date.now()}@example.com`;
const PASSWORD = "DemoPassword123!";
const NAME = "Maya Lindgren";
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

let seed = 20260913;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];
/** Picks by each item's `weight`, so admin does not get as many hours as client work. */
const pickWeighted = (list) => {
  let roll = random() * list.reduce((sum, item) => sum + item.weight, 0);
  for (const item of list) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return list[list.length - 1];
};

async function signUp() {
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: webOrigin },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: NAME }),
  });
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) {
    throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  }
  return token;
}

function trpc(token) {
  return async (path, input) => {
    const response = await fetch(`${baseUrl}/api/trpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body.error ?? body)}`);
    return body.result.data;
  };
}

const at = (day, hour, minute) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);

async function main() {
  const call = trpc(await signUp());

  await call("settings.update", { currency: "EUR", weekStartsOn: 1, timeFormat: "24h" });

  const clients = {};
  for (const [key, name, color] of [
    ["lindqvist", "Lindqvist Architects", "#4f46e5"],
    ["heron", "Blue Heron Press", "#0891b2"],
    ["okafor", "Okafor Bakery", "#d97706"],
  ]) {
    clients[key] = await call("clients.create", { name, color });
  }

  const projects = {};
  for (const [key, name, client, rate, color, estimate] of [
    ["site", "Website redesign", "lindqvist", 95, "#6366f1", 120],
    ["brand", "Brand refresh", "heron", 85, "#06b6d4", 60],
    ["ordering", "Online ordering", "okafor", 90, "#f59e0b", 80],
    ["admin", "Studio admin", null, null, "#64748b", null],
  ]) {
    projects[key] = await call("projects.create", {
      name,
      color,
      clientId: client ? clients[client].id : null,
      billableDefault: client !== null,
      hourlyRate: rate,
      ...(estimate ? { estimatedHours: estimate } : {}),
    });
  }

  const tasks = {};
  for (const name of ["Design review", "Development", "Client call", "Research", "Writing", "Invoicing"]) {
    tasks[name] = await call("tasks.create", { name });
  }

  const tags = {};
  for (const [name, color] of [
    ["deep work", "#7c3aed"],
    ["meeting", "#db2777"],
    ["on site", "#059669"],
  ]) {
    tags[name] = await call("tags.create", { name, color });
  }

  const work = [
    { weight: 4, project: "site", task: "Design review", tag: null, text: ["Homepage layout review", "Project pages — second round", "Navigation review with Anna"] },
    { weight: 6, project: "site", task: "Development", tag: "deep work", text: ["Project gallery component", "Contact form and validation", "Image loading for project pages"] },
    { weight: 2, project: "site", task: "Client call", tag: "meeting", text: ["Weekly check-in", "Sitemap walkthrough"] },
    { weight: 3, project: "brand", task: "Design review", tag: null, text: ["Logo options review", "Type pairing review"] },
    { weight: 2, project: "brand", task: "Research", tag: null, text: ["Competitor covers", "Print paper samples"] },
    { weight: 3, project: "brand", task: "Writing", tag: "deep work", text: ["Brand guidelines draft", "Tone of voice page"] },
    { weight: 6, project: "ordering", task: "Development", tag: "deep work", text: ["Checkout flow — payment step", "Order status emails", "Pickup time slots"] },
    { weight: 2, project: "ordering", task: "Client call", tag: "on site", text: ["Menu photos at the bakery", "Launch planning"] },
    { weight: 1, project: "admin", task: "Invoicing", tag: null, text: ["Monthly invoices"] },
  ];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // The timer that is running in every screenshot. Today's finished entries
  // stop before it starts, so nothing overlaps and nothing lies in the future.
  const running = new Date(Date.now() - 47 * 60 * 1000);
  const runningMinute = running.getHours() * 60 + running.getMinutes();
  let created = 0;

  for (let back = 34; back >= 0; back -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - back);
    const weekday = day.getDay();
    // Today is always a working day, whatever day the screenshots are taken
    // on: a tracker whose "Today" holds only a running timer looks unused.
    if (back > 0 && (weekday === 0 || weekday === 6)) continue;

    let minute = back === 0 ? 7 * 60 + 30 : 9 * 60 + Math.floor(random() * 4) * 15;
    const endOfDay = back === 0 ? runningMinute - 15 : 17 * 60 + 30;

    while (minute < endOfDay) {
      const job = pickWeighted(work);
      const length = pick([45, 60, 75, 90, 120, 150]);
      const end = Math.min(minute + length, endOfDay);
      if (end - minute < 30) break;
      await call("entries.create", {
        description: pick(job.text),
        projectId: projects[job.project].id,
        taskId: tasks[job.task].id,
        billable: job.project !== "admin",
        start: at(day, Math.floor(minute / 60), minute % 60).toISOString(),
        end: at(day, Math.floor(end / 60), end % 60).toISOString(),
        timeZone: TIME_ZONE,
        tagIds: job.tag ? [tags[job.tag].id] : [],
        source: "web",
      });
      created += 1;
      minute = end + pick([0, 15, 15, 30, 60]);
    }
  }

  await call("entries.start", {
    description: "Checkout flow — payment step",
    projectId: projects.ordering.id,
    taskId: tasks.Development.id,
    billable: true,
    start: running.toISOString(),
    timeZone: TIME_ZONE,
    tagIds: [tags["deep work"].id],
    source: "web",
  });

  for (const [project, task, description] of [
    ["site", "Client call", "Weekly check-in"],
    ["ordering", "Development", "Checkout flow — payment step"],
  ]) {
    await call("favorites.create", {
      description,
      projectId: projects[project].id,
      taskId: tasks[task].id,
      billable: true,
    });
  }

  // One invoice for last month's Lindqvist work, marked sent.
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const firstOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dueDate = new Date(firstOfMonth);
  dueDate.setDate(dueDate.getDate() + 14);
  const invoice = await call("invoices.create", {
    clientId: clients.lindqvist.id,
    from: ymd(firstOfLastMonth),
    to: ymd(new Date(firstOfMonth.getTime() - 86_400_000)),
    groupBy: "task",
    issueDate: ymd(firstOfMonth),
    dueDate: ymd(dueDate),
    notes: "Thank you. Payment by bank transfer within 14 days.",
  });
  await call("invoices.updateStatus", { id: invoice.id, status: "sent" }).catch((error) =>
    console.warn(`invoice status not set: ${error.message}`),
  );

  console.log(JSON.stringify({ email: EMAIL, password: PASSWORD, entries: created, invoice: invoice.number }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
