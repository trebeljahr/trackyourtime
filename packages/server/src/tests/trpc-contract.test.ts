// Is the committed tRPC contract the one this code produces — and when it is
// not, does the failure name the versioning rule the change falls under?
//
// `packages/server/contract/trpc-contract.json` is a committed artifact, like
// the OpenAPI document. A self-hosted server lags the store clients by months,
// so a procedure's input narrowing is a refusal on somebody's phone that no
// test of this repo would ever see. The snapshot makes it a diff, and the
// classifier makes the diff say "raise the floor" or "bump the level".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { appRouter } from "../trpc/router.js";
import {
  TRPC_CONTRACT_PATH,
  buildTrpcContract,
  classifyContractDiff,
  contractVerdict,
  trpcContractJson,
  type JsonSchema,
  type TrpcContract,
} from "../contract/trpc-contract.js";

describe("committed tRPC contract", () => {
  it("matches the router, the sync events and the API level", () => {
    const generated = buildTrpcContract(appRouter);
    const committed = JSON.parse(readFileSync(TRPC_CONTRACT_PATH, "utf8")) as TrpcContract;
    const verdict = contractVerdict(committed, generated);
    assert.equal(verdict, null, verdict ?? undefined);
    // Byte-for-byte too, so key order and formatting cannot drift.
    assert.equal(readFileSync(TRPC_CONTRACT_PATH, "utf8"), trpcContractJson(generated));
  });

  it("covers every procedure and every sync event kind", () => {
    const generated = buildTrpcContract(appRouter);
    assert.ok(Object.keys(generated.procedures).length > 50);
    assert.ok("entries.start" in generated.procedures);
    assert.equal(generated.procedures["entries.start"]?.type, "mutation");
    assert.ok("membership.changed" in generated.syncEvents);
  });

  it("classifies the real contract against itself as no change", () => {
    const generated = buildTrpcContract(appRouter);
    assert.deepEqual(classifyContractDiff(generated, structuredClone(generated)), []);
  });
});

// ── Classifier fixtures ──────────────────────────────────────────────

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
});
const str: JsonSchema = { type: "string" };
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });

const contract = (overrides: Partial<TrpcContract> = {}): TrpcContract => ({
  apiLevel: 3,
  minClientApiLevel: 2,
  procedures: {
    "entries.start": { type: "mutation", input: object({ description: str }) },
    "entries.list": { type: "query", input: null },
  },
  syncEvents: {
    "catalog.changed": object(
      { kind: { type: "string", const: "catalog.changed" }, scope: { type: "string", enum: ["client", "tag"] } },
      ["kind", "scope"],
    ),
  },
  ...overrides,
});

const withStartInput = (input: JsonSchema): TrpcContract =>
  contract({
    procedures: { ...contract().procedures, "entries.start": { type: "mutation", input } },
  });

const kinds = (before: TrpcContract, after: TrpcContract): string[] =>
  [...new Set(classifyContractDiff(before, after).map((change) => change.kind))].sort();

describe("classifyContractDiff: breaking", () => {
  it("a removed or renamed procedure", () => {
    const after = contract({ procedures: { "entries.start": contract().procedures["entries.start"]! } });
    assert.deepEqual(kinds(contract(), after), ["breaking"]);
  });

  it("a procedure whose type changed", () => {
    const after = contract({
      procedures: { ...contract().procedures, "entries.list": { type: "mutation", input: null } },
    });
    assert.deepEqual(kinds(contract(), after), ["breaking"]);
  });

  it("a required input property added", () => {
    assert.deepEqual(
      kinds(contract(), withStartInput(object({ description: str, projectId: str }, ["projectId"]))),
      ["breaking"],
    );
  });

  it("an optional input property made required", () => {
    assert.deepEqual(
      kinds(contract(), withStartInput(object({ description: str }, ["description"]))),
      ["breaking"],
    );
  });

  it("an enum value removed from an input", () => {
    const before = withStartInput(object({ source: { type: "string", enum: ["web", "api"] } }));
    const after = withStartInput(object({ source: { type: "string", enum: ["web"] } }));
    assert.deepEqual(kinds(before, after), ["breaking"]);
  });

  it("an input type narrowed: nullable to non-null, or a tighter bound", () => {
    const before = withStartInput(object({ projectId: nullable(str) }));
    assert.deepEqual(kinds(before, withStartInput(object({ projectId: str }))), ["breaking"]);
    const long = withStartInput(object({ description: { type: "string", maxLength: 500 } }));
    const short = withStartInput(object({ description: { type: "string", maxLength: 100 } }));
    assert.deepEqual(kinds(long, short), ["breaking"]);
  });

  it("a sync event kind removed", () => {
    assert.deepEqual(kinds(contract(), contract({ syncEvents: {} })), ["breaking"]);
  });

  it("a required sync payload field removed", () => {
    const after = contract({
      syncEvents: { "catalog.changed": object({ kind: { type: "string", const: "catalog.changed" } }, ["kind"]) },
    });
    assert.deepEqual(kinds(contract(), after), ["breaking"]);
  });
});

describe("classifyContractDiff: additive", () => {
  it("a procedure added", () => {
    const after = contract({
      procedures: { ...contract().procedures, "tags.list": { type: "query", input: null } },
    });
    assert.deepEqual(kinds(contract(), after), ["additive"]);
  });

  it("an optional input property added", () => {
    assert.deepEqual(kinds(contract(), withStartInput(object({ description: str, tagIds: str }))), [
      "additive",
    ]);
  });

  it("an enum value added, on an input or a sync payload", () => {
    const before = withStartInput(object({ source: { type: "string", enum: ["web"] } }));
    const after = withStartInput(object({ source: { type: "string", enum: ["web", "api"] } }));
    assert.deepEqual(kinds(before, after), ["additive"]);

    const scoped = contract({
      syncEvents: {
        "catalog.changed": object(
          {
            kind: { type: "string", const: "catalog.changed" },
            scope: { type: "string", enum: ["client", "tag", "rate"] },
          },
          ["kind", "scope"],
        ),
      },
    });
    assert.deepEqual(kinds(contract(), scoped), ["additive"]);
  });

  it("a sync event kind added", () => {
    const after = contract({
      syncEvents: { ...contract().syncEvents, "favorites.changed": object({}, []) },
    });
    assert.deepEqual(kinds(contract(), after), ["additive"]);
  });
});

describe("classifyContractDiff: neutral", () => {
  it("an input property removed is stripped, not refused", () => {
    assert.deepEqual(kinds(contract(), withStartInput(object({}))), ["neutral"]);
  });

  it("a description change is no change", () => {
    assert.deepEqual(
      kinds(contract(), withStartInput(object({ description: { ...str, description: "What you did" } }))),
      [],
    );
  });
});

describe("contractVerdict", () => {
  it("is null when nothing changed", () => {
    assert.equal(contractVerdict(contract(), contract()), null);
  });

  it("asks for both levels on a breaking change", () => {
    const after = contract({ syncEvents: {} });
    assert.match(contractVerdict(contract(), after) ?? "", /Raise MIN_CLIENT_API_LEVEL and API_LEVEL/);
    // Only the level raised is not enough.
    assert.match(contractVerdict(contract(), { ...after, apiLevel: 4 }) ?? "", /Raise MIN_CLIENT_API_LEVEL/);
    // Both raised: only the regeneration remains.
    assert.match(
      contractVerdict(contract(), { ...after, apiLevel: 4, minClientApiLevel: 3 }) ?? "",
      /^The committed tRPC contract is stale\.[\s\S]*contract:emit/,
    );
  });

  it("asks for an API_LEVEL bump on an additive change", () => {
    const after = withStartInput(object({ description: str, tagIds: str }));
    assert.match(contractVerdict(contract(), after) ?? "", /Bump API_LEVEL and add an API_LEVEL_CHANGES entry/);
    assert.match(contractVerdict(contract(), { ...after, apiLevel: 4 }) ?? "", /is stale[\s\S]*contract:emit/);
  });

  it("asks only for a regeneration on a neutral change", () => {
    assert.match(
      contractVerdict(contract(), withStartInput(object({}))) ?? "",
      /is stale[\s\S]*pnpm run contract:emit/,
    );
  });
});
