import { createEntryOperationId } from "@starter/core";
import { entryOperationId } from "@starter/shared";
export type PrivateTimerAction = Readonly<{ operationId: string; now: number }>;
export function capturePrivateTimerAction(input: unknown): PrivateTimerAction {
  const explicit = input && typeof input === "object" ? (input as { operationId?: unknown }).operationId : undefined;
  const operationId = entryOperationId.parse(explicit);
  return Object.freeze({ operationId: operationId ?? createEntryOperationId(), now: Date.now() });
}
