// pdfkit's self-contained browser build, reached through the `pdfkit-standalone`
// alias in next.config.ts (the real `pdfkit/js/pdfkit.standalone.js` subpath is
// blocked by pdfkit's `exports` map, and the file has no types of its own). The
// public invoice generator imports it for the browser
// (`components/marketing/pages/invoice-generator-page.tsx`); its default export
// is the PDFDocument constructor, handed to the renderer as an opaque value.
declare module "pdfkit-standalone" {
  const PDFDocument: unknown;
  export default PDFDocument;
}
