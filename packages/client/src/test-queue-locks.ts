import { locks } from "node:worker_threads";

// jsdom has no Web Locks. Node's real manager exercises queue ownership.
if (typeof navigator !== "undefined" && !navigator.locks) {
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
}
