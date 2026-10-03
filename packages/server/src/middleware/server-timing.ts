import type { RequestHandler } from "express";
import type { ServerResponse } from "node:http";

// Fixed names only. No paths, identifiers, descriptions, or telemetry sinks.
type Phase = "auth" | "workspace" | "data";
const timings = new WeakMap<ServerResponse, Map<Phase, number>>();

export function startServerTiming(res: ServerResponse, phase: Phase): () => void {
  const started = performance.now();
  let stopped = false;
  return () => {
    if (stopped || res.headersSent) return;
    stopped = true;
    const totals = timings.get(res) ?? new Map<Phase, number>();
    totals.set(phase, (totals.get(phase) ?? 0) + performance.now() - started);
    timings.set(res, totals);
    res.setHeader("Server-Timing", [...totals].map(([name, duration]) =>
      `${name};dur=${duration.toFixed(1)}`).join(", "));
  };
}

export async function timeServerWork<T>(res: ServerResponse, phase: Phase, work: () => Promise<T>): Promise<T> {
  const stop = startServerTiming(res, phase);
  try { return await work(); } finally { stop(); }
}

// Run after CORS: reuse its actual decision, including cookie-free extensions.
// No wildcard: rejected origins cannot read Resource Timing details.
export const allowServerTiming: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && res.getHeader("Access-Control-Allow-Origin") === origin) {
    res.setHeader("Timing-Allow-Origin", origin);
    res.vary("Origin");
  }
  next();
};
