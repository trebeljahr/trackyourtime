# @starter/invoice-pdf

The invoice PDF renderer, extracted from the server so the same source produces
the same bytes in Node and in the browser. It draws with pdfkit, formats and
localises every figure from the snapshot on the invoice, and returns a
`Uint8Array` — the document's bytes, byte for byte what the server has always
sent.

## What it is not

- **No Node.** No `node:` import, no `fs`/`path`, no `Buffer` in the public API.
  `import-guard.test.ts` walks `src/` and fails the build on any of them.
- **No filesystem, no fonts of its own.** The plain PDF uses pdfkit's built-in
  standard-14 Helvetica through `INVOICE_PDF_FONT_NAMES`. A variant (the
  server's ZUGFeRD/PDF-A output) registers embedded faces under those same
  names in its `prepare(doc)` hook, so the renderer never reads a font file.

## Public API

```ts
import { renderInvoicePdf, invoicePdfFilename } from "@starter/invoice-pdf";

const bytes: Uint8Array = await renderInvoicePdf(invoice, { generatedAt });
```

`renderInvoicePdf(invoice, meta, variant?)` returns the PDF bytes. `invoice` is
a `RenderableInvoice` (a wire `Invoice` with the issuer logo's bytes kept).
The package also exports `pdfFormat`, `sanitizePdfText`, `invoiceT`, the
e-invoice totals arithmetic (`computeEn16931Totals`, …) and the pure date /
format helpers, so a page can compute an invoice's totals and render it with no
server.

The server calls the renderer through `packages/server/src/services/invoice-pdf.ts`,
which wraps the `Uint8Array` in a Node `Buffer`; every other server module and
test keeps its old import path via thin re-export shims.

## Bundling for the browser

pdfkit's Node entry pulls in Node builtins. In a browser build, alias `pdfkit`
to its self-contained standalone bundle, which ships its own Buffer/zlib/font
support:

```js
// esbuild
esbuild.build({ alias: { pdfkit: "pdfkit/js/pdfkit.standalone.js" }, platform: "browser", ... });

// vite
resolve: { alias: { pdfkit: "pdfkit/js/pdfkit.standalone.js" } }
```

With that alias the entry `import { renderInvoicePdf } from "@starter/invoice-pdf"`
bundles for the browser with no Node externals.
