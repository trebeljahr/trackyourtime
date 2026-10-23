// The tRPC surface over the client services.
//
// Every resolver is one line: resolve the scope, call the service. The logic
// lives in `services/catalog/clients.ts` because the public REST API calls the
// same functions without entering tRPC.
//
// This file also keeps re-exporting the small helpers the sibling catalog
// routers have always imported from here (the palette, the name matcher, the
// ObjectId guard). They moved to `services/catalog/`; re-exporting keeps every
// existing import path working and avoids an import cycle back into a router.
import { z } from "zod";
import {
  clientListSchema,
  createClientSchema,
  idInputSchema,
  updateClientSchema,
  type Client as ClientWire,
} from "@starter/shared";
import { scopeFromContext } from "../../services/scope.js";
import {
  archiveClient,
  createClient,
  listClients,
  clientOptions,
  removeClient,
  updateClient,
} from "../../services/catalog/clients.js";
import { workspaceProcedure, router } from "../trpc.js";
import type { CatalogRemoveResult } from "./catalog-cascade.js";

// The palette, its project offset and the cycling picker live in
// `@starter/shared` so the web picker and the Raycast forms offer exactly the
// colors this router assigns. Re-exported because the sibling catalog routers
// have always imported them from here.
export {
  CATALOG_COLOR_PALETTE,
  PROJECT_COLOR_OFFSET,
  pickCatalogColor,
} from "@starter/shared";
export { exactNameRegExp } from "../../services/catalog/names.js";
export { assertObjectId } from "../../services/catalog/guards.js";

/** `archive` toggles: `archived` defaults to true when the caller omits it. */
export const archiveInputSchema = idInputSchema.extend({
  archived: z.boolean().optional(),
});

export const clientsRouter = router({
  options: workspaceProcedure.input(clientListSchema).query(({ ctx, input }) => clientOptions(scopeFromContext(ctx), input)),
  list: workspaceProcedure
    .input(clientListSchema)
    .query(async ({ ctx, input }): Promise<ClientWire[]> =>
      listClients(scopeFromContext(ctx), input),
    ),

  create: workspaceProcedure
    .input(createClientSchema)
    .mutation(async ({ ctx, input }): Promise<ClientWire> =>
      createClient(scopeFromContext(ctx), input),
    ),

  update: workspaceProcedure
    .input(updateClientSchema)
    .mutation(async ({ ctx, input }): Promise<ClientWire> =>
      updateClient(scopeFromContext(ctx), input),
    ),

  archive: workspaceProcedure
    .input(archiveInputSchema)
    .mutation(async ({ ctx, input }): Promise<ClientWire> =>
      archiveClient(scopeFromContext(ctx), input),
    ),

  /**
   * Always deletes. Its projects survive as client-less projects, so no
   * tracked time is lost. Use `archive` to keep the client around instead.
   */
  remove: workspaceProcedure
    .input(idInputSchema)
    .mutation(async ({ ctx, input }): Promise<CatalogRemoveResult> =>
      removeClient(scopeFromContext(ctx), input),
    ),
});
