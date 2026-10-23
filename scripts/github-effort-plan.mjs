#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { planGithubEffort } from "./lib/github-effort.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output || resolve(input) === resolve(output)) {
  console.error("Usage: node scripts/github-effort-plan.mjs /absolute/private-input.json /absolute/private-plan.json");
  process.exit(1);
}
const plan = planGithubEffort(JSON.parse(readFileSync(input, "utf8")));
writeFileSync(output, JSON.stringify(plan, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ repositories: new Set(plan.projectDays.map((d) => d.repository)).size,
  commits: plan.projectDays.reduce((sum, d) => sum + d.commits.length, 0),
  additionalEntries: plan.newEntries.length,
  additionalHours: plan.newEntries.reduce((sum, e) => sum + e.durationSec, 0) / 3600,
  projects: plan.projectEstimates.length }));
