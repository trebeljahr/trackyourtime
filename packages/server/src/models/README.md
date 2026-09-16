# Models

Two rules keep a database readable by more than one release at once. A
self-hosted instance can be rolled back, and a hosted deploy briefly runs the
old and the new server side by side on the same database.

## Absent reads as the default

A new field is optional and has no `required`. Documents written before the
field existed do not have it, and the code reads the absent value as the
default. Anything that must rewrite existing documents is a migration in
`services/migrations/`, never a side effect of a model change.

## Never reject a value a newer release may have written

Mongoose runs `enum` validators on `create` and `insertMany`. This codebase
does not call `.save()` on stored documents, and updates run without
validators. So an `enum` only bites when a create copies a value it read from
another stored document. A newer release may have added a value to that enum,
such as a new locale or electronic address scheme. The older release then
throws a `ValidationError` on something the user did not type.

- **Snapshot fields carry no `enum`.** The issuer and recipient snapshots,
  `Invoice.locale`, and the per-line and breakdown tax categories on an
  invoice are copies. The values are checked where they enter: the zod
  schemas in `@starter/shared` and the normalisers in
  `@starter/shared/business-identity`.
- **A create that copies a stored value normalises it first.** An unknown
  value becomes `null` or the default, for example `oneOf(...)` in
  `normalizeClientBilling` or the supported-locale check in
  `invoiceLocaleFor` (`trpc/routers/invoices.ts`).
- An `enum` on a live field that only a zod-validated request writes is fine.

`tests/invoice-future-values.test.ts` pins this for invoices.

## Indexes

`db/indexes.ts` builds every schema index at boot and logs each failure.
A failed unique index that guards an invariant stops the boot. Never call
`syncIndexes()`: it drops indexes a newer release created. A model must be
imported by `registry.ts` to be checked.
