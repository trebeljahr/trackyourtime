# Vendored fonts

The e-invoice PDF (PDF/A-3b, `services/einvoice/pdfa3.ts`) must embed every font
it draws with, so it cannot use the standard-14 Helvetica the plain invoice PDF
uses. These two faces are embedded instead. pdfkit subsets them, so each PDF
carries only the glyphs it draws.

| File | SHA-256 |
|---|---|
| NotoSans-Regular.ttf | `478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823` |
| NotoSans-Bold.ttf | `1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913` |
| OFL.txt | `cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a` |

- **Font:** Noto Sans 2.015, static hinted TTF, Regular and Bold.
- **Source:** the `NotoSans-v2.015` release of
  https://github.com/notofonts/latin-greek-cyrillic
  (`NotoSans-v2.015.zip`: `NotoSans/hinted/ttf/NotoSans-Regular.ttf`,
  `NotoSans/hinted/ttf/NotoSans-Bold.ttf` and `OFL.txt`).
- **Licence:** SIL Open Font License 1.1, full text in `OFL.txt`. The OFL covers
  these font files only; it is compatible with bundling in this AGPL-3.0-or-later
  software.
- **Not modified, not renamed.** The files are byte-identical to the release.
  If they are ever changed (subset, merged, converted), the OFL's rules for
  Modified Versions apply, including its Reserved Font Name clause.
- **Static faces only.** Do not replace them with the variable font: pdfkit's
  subsetter drops the `gvar` table.

`tests/pdf-fonts.test.ts` reads the hashes from the table above and fails when a
file does not match, so this README and the files cannot drift apart.

The server Docker image copies this folder (`COPY --from=build /prod/assets
./assets`). Without that line every e-invoice export fails with the missing
path in the log.
