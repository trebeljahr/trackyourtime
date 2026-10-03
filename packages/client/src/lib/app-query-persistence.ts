import { memoryStorage, webStorage, type KeyValueStorage } from "@starter/core";
import type { QueryClient } from "@tanstack/react-query";
import { preferencesStorage, shouldUseNativeStorage } from "@/mobile/preferences-storage";
import { createQueryPersistence, type QueryPersistence } from "./query-persistence";

const controllers = new WeakMap<QueryClient, QueryPersistence>();
const storage = (): KeyValueStorage => {
  if (typeof window === "undefined") return memoryStorage();
  if (shouldUseNativeStorage()) return preferencesStorage();
  try { return webStorage(window.localStorage); }
  catch { return memoryStorage(); }
};

export const getQueryPersistence = (client: QueryClient): QueryPersistence => {
  let controller = controllers.get(client);
  if (!controller) {
    controller = createQueryPersistence(client, storage());
    controllers.set(client, controller);
  }
  return controller;
};
