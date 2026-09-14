import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCiiXml, CiiInvariantError, paymentMeansCode, xrechnungFilename } from "../services/einvoice/cii.js";
import { planEinvoiceFill } from "../services/einvoice/fill.js";
import { computeEn16931Totals } from "../services/einvoice/totals.js";
import { assertEinvoiceReady, type EinvoiceReadyInvoice } from "../services/einvoice/validate.js";
import {
  businessProfileFixture,
  clientBillingFixture,
  EINVOICE_CASES,
  einvoiceCase,
  issuerFixture,
  legacyInvoiceFixture,
  recipientFixture,
} from "./fixtures/einvoice/cases.js";
import { assertWellFormedXml } from "./support/xml-well-formed.js";

const ready = (name: string, profile: "en16931" | "xrechnung" = "en16931"): EinvoiceReadyInvoice =>
  assertEinvoiceReady(einvoiceCase(name).invoice(), profile);

const xmlOf = (name: string, profile: "en16931" | "xrechnung" = "en16931"): string =>
  buildCiiXml(ready(name, profile), profile);

const AMOUNT_ELEMENTS = [
  "LineTotalAmount",
  "TaxBasisTotalAmount",
  "TaxTotalAmount",
  "GrandTotalAmount",
  "DuePayableAmount",
  "CalculatedAmount",
  "BasisAmount",
];

describe("buildCiiXml: every case", () => {
  for (const c of EINVOICE_CASES) {
    describe(c.name, () => {
      const en = buildCiiXml(assertEinvoiceReady(c.invoice(), "en16931"), "en16931");
      const xr = buildCiiXml(assertEinvoiceReady(c.invoice(), "xrechnung"), "xrechnung");

      it("differs between profiles in exactly one line, the guideline id", () => {
        const a = en.split("\n");
        const b = xr.split("\n");
        assert.equal(a.length, b.length);
        const differing = a.flatMap((line, i) => (line === b[i] ? [] : [i]));
        assert.equal(differing.length, 1);
        const i = differing[0] ?? -1;
        assert.equal(a[i]?.trim(), "<ram:ID>urn:cen.eu:en16931:2017</ram:ID>");
        assert.equal(
          b[i]?.trim(),
          "<ram:ID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</ram:ID>",
        );
        assert.match(a[i - 1] ?? "", /<ram:GuidelineSpecifiedDocumentContextParameter>/);
      });

      it("is deterministic", () => {
        assert.equal(buildCiiXml(assertEinvoiceReady(c.invoice(), "en16931"), "en16931"), en);
      });

      it("is well-formed", () => {
        assert.doesNotThrow(() => assertWellFormedXml(en));
      });

      it("has no empty element (PEPPOL-EN16931-R008)", () => {
        assert.doesNotMatch(en, /<[a-z]+:[A-Za-z]+(\s[^>]*)?\/>/);
        assert.doesNotMatch(en, /<([a-z]+:[A-Za-z]+)(\s[^>]*)?>\s*<\/\1>/);
      });

      it("writes every date as format 102 with 8 digits", () => {
        const dates = [...en.matchAll(/<udt:DateTimeString([^>]*)>([^<]*)</g)];
        assert.ok(dates.length >= 4);
        for (const [, attrs, value] of dates) {
          assert.equal(attrs, ' format="102"');
          assert.match(value ?? "", /^\d{8}$/);
        }
      });

      it("writes every amount with exactly two decimals", () => {
        for (const name of AMOUNT_ELEMENTS) {
          for (const [, value] of en.matchAll(new RegExp(`<ram:${name}(?:\\s[^>]*)?>([^<]*)<`, "g"))) {
            assert.match(value ?? "", /^-?\d+\.\d{2}$/, `${name} = ${value}`);
          }
        }
      });

      it("has no CR, no BOM and ends with a newline", () => {
        assert.doesNotMatch(en, /\r/);
        assert.notEqual(en.charCodeAt(0), 0xfeff);
        assert.ok(en.endsWith("</rsm:CrossIndustryInvoice>\n"));
      });
    });
  }
});

describe("buildCiiXml: element order", () => {
  it("writes ApplicableTradeTax children in schema order (ExemptionReason before BasisAmount)", () => {
    const xml = xmlOf("reverse-charge-ae");
    const block = /<ram:ApplicableTradeTax>\s*<ram:CalculatedAmount>[\s\S]*?<\/ram:ApplicableTradeTax>/.exec(xml)?.[0] ?? "";
    const order = [...block.matchAll(/<ram:([A-Za-z]+)>/g)].map((m) => m[1]);
    assert.deepEqual(order, [
      "ApplicableTradeTax",
      "CalculatedAmount",
      "TypeCode",
      "ExemptionReason",
      "BasisAmount",
      "CategoryCode",
      "ExemptionReasonCode",
      "RateApplicablePercent",
    ]);
  });

  it("writes the transaction aggregates and the settlement children in schema order", () => {
    const xml = xmlOf("standard-19");
    const positions = [
      "<ram:IncludedSupplyChainTradeLineItem>",
      "<ram:ApplicableHeaderTradeAgreement>",
      "<ram:BuyerReference>",
      "<ram:SellerTradeParty>",
      "<ram:BuyerTradeParty>",
      "<ram:ApplicableHeaderTradeDelivery>",
      "<ram:ApplicableHeaderTradeSettlement>",
      "<ram:PaymentReference>",
      "<ram:InvoiceCurrencyCode>",
      "<ram:SpecifiedTradeSettlementPaymentMeans>",
      "<ram:ApplicableTradeTax>\n        <ram:CalculatedAmount>",
      "<ram:BillingSpecifiedPeriod>",
      "<ram:SpecifiedTradePaymentTerms>",
      "<ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
    ].map((tag) => xml.indexOf(tag));
    assert.ok(positions.every((p) => p >= 0), `missing element: ${positions.join(",")}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  });

  it("writes address children in schema order, whatever is missing", () => {
    const xml = xmlOf("xrechnung-leitweg");
    const buyer = /<ram:BuyerTradeParty>[\s\S]*?<\/ram:BuyerTradeParty>/.exec(xml)?.[0] ?? "";
    const order = [...buyer.matchAll(/<ram:(PostcodeCode|LineOne|LineTwo|CityName|CountryID)>/g)].map((m) => m[1]);
    assert.deepEqual(order, ["PostcodeCode", "LineOne", "LineTwo", "CityName", "CountryID"]);
  });
});

describe("buildCiiXml: tax categories", () => {
  it("standard 19 %: two-decimal rates, the research sample's figures", () => {
    const xml = xmlOf("standard-19");
    assert.match(xml, /<ram:RateApplicablePercent>19\.00<\/ram:RateApplicablePercent>/);
    assert.match(xml, /<ram:BilledQuantity unitCode="HUR">12\.5<\/ram:BilledQuantity>/);
    assert.match(xml, /<ram:CalculatedAmount>293\.55<\/ram:CalculatedAmount>/);
    assert.match(xml, /<ram:GrandTotalAmount>1838\.55<\/ram:GrandTotalAmount>/);
    assert.match(xml, /<ram:TaxTotalAmount currencyID="EUR">293\.55<\/ram:TaxTotalAmount>/);
    assert.match(xml, /<ram:ID schemeID="VA">DE123456789<\/ram:ID>/);
    assert.match(xml, /<ram:ID schemeID="FC">30\/123\/45678<\/ram:ID>/);
  });

  it("mixed 19/7: one breakdown row per rate, 19 before 7, ties away from zero, 6-dp quantity", () => {
    const xml = xmlOf("mixed-19-7");
    const rows = [...xml.matchAll(/<ram:CalculatedAmount>([^<]+)<\/ram:CalculatedAmount>/g)].map((m) => m[1]);
    assert.deepEqual(rows, ["234.56", "23.35"]);
    assert.match(xml, /<ram:BilledQuantity unitCode="HUR">13\.716667<\/ram:BilledQuantity>/);
    assert.match(xml, /<ram:TaxTotalAmount currencyID="EUR">257\.91<\/ram:TaxTotalAmount>/);
    assert.match(xml, /<ram:GrandTotalAmount>1825\.91<\/ram:GrandTotalAmount>/);
  });

  it("zero-rated Z: no exemption reason (BR-Z-10)", () => {
    const xml = xmlOf("zero-rated");
    assert.match(xml, /<ram:CategoryCode>Z<\/ram:CategoryCode>/);
    assert.doesNotMatch(xml, /ExemptionReason/);
  });

  it("small business E: no VAT id, tax number and seller identifier, § 19 reason without a code", () => {
    const xml = xmlOf("small-business-e");
    assert.doesNotMatch(xml, /schemeID="VA"/);
    assert.match(xml, /<ram:SellerTradeParty>\s*<ram:ID>30\/123\/45678<\/ram:ID>\s*<ram:Name>/);
    assert.match(xml, /<ram:ExemptionReason>Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß § 19 UStG\.<\/ram:ExemptionReason>/);
    assert.doesNotMatch(xml, /ExemptionReasonCode/);
  });

  it("reverse charge AE: buyer VAT id and VATEX-EU-AE", () => {
    const xml = xmlOf("reverse-charge-ae");
    assert.match(xml, /<ram:ExemptionReasonCode>VATEX-EU-AE<\/ram:ExemptionReasonCode>/);
    const buyer = /<ram:BuyerTradeParty>[\s\S]*?<\/ram:BuyerTradeParty>/.exec(xml)?.[0] ?? "";
    assert.match(buyer, /<ram:ID schemeID="VA">ATU12345678<\/ram:ID>/);
  });

  it("not subject O: no VAT ids for either party, no line rate, breakdown rate 0.00", () => {
    const invoice = ready("not-subject-o");
    assert.ok(invoice.issuer.vatId, "the snapshot keeps the seller VAT id");
    assert.ok(invoice.recipient.vatId, "the snapshot keeps the buyer VAT id");
    const xml = buildCiiXml(invoice, "en16931");
    assert.doesNotMatch(xml, /schemeID="VA"/);
    const line = /<ram:IncludedSupplyChainTradeLineItem>[\s\S]*?<\/ram:IncludedSupplyChainTradeLineItem>/.exec(xml)?.[0] ?? "";
    assert.doesNotMatch(line, /RateApplicablePercent/);
    assert.match(xml, /<ram:ExemptionReasonCode>VATEX-EU-O<\/ram:ExemptionReasonCode>\s*<ram:RateApplicablePercent>0\.00<\/ram:RateApplicablePercent>/);
    assert.match(xml, /<ram:SpecifiedLegalOrganization>\s*<ram:ID>HRB 123456 B<\/ram:ID>/);
  });

  it("declares a SEPA credit transfer (58) only for a euro invoice, a plain one (30) otherwise", () => {
    assert.match(xmlOf("standard-19"), /<ram:SpecifiedTradeSettlementPaymentMeans>\s*<ram:TypeCode>58<\/ram:TypeCode>/);
    const chf = xmlOf("not-subject-chf");
    assert.match(chf, /<ram:InvoiceCurrencyCode>CHF<\/ram:InvoiceCurrencyCode>/);
    assert.match(chf, /<ram:SpecifiedTradeSettlementPaymentMeans>\s*<ram:TypeCode>30<\/ram:TypeCode>/);
    assert.equal(paymentMeansCode("EUR"), "58");
    assert.equal(paymentMeansCode("eur"), "58");
    assert.equal(paymentMeansCode("USD"), "30");
  });

  it("Leitweg-ID: buyer reference and electronic address with scheme 0204", () => {
    const xml = xmlOf("xrechnung-leitweg", "xrechnung");
    assert.match(xml, /<ram:BuyerReference>991-12345-06<\/ram:BuyerReference>/);
    assert.match(xml, /<ram:URIID schemeID="0204">991-12345-06<\/ram:URIID>/);
    assert.match(xml, /<ram:LineTwo>Amt für Digitales<\/ram:LineTwo>/);
  });

  it("joins a third and fourth address line into LineThree (BT-163), after LineTwo and before CityName", () => {
    const invoice = ready("standard-19");
    invoice.recipient = recipientFixture({
      addressLines: ["Beispielweg 7", "Gebäude B", "3. Stock", "Raum 12"],
    });
    const xml = buildCiiXml(invoice, "en16931");
    const buyer = /<ram:BuyerTradeParty>[\s\S]*?<\/ram:BuyerTradeParty>/.exec(xml)?.[0] ?? "";
    assert.match(
      buyer,
      /<ram:LineOne>Beispielweg 7<\/ram:LineOne>\s*<ram:LineTwo>Gebäude B<\/ram:LineTwo>\s*<ram:LineThree>3\. Stock, Raum 12<\/ram:LineThree>\s*<ram:CityName>/,
    );
  });

  it("names the buyer by the client's display name when no registered name differs (BT-44)", () => {
    const invoice = ready("standard-19");
    invoice.recipient = { ...invoice.recipient, legalName: null };
    const xml = buildCiiXml(invoice, "en16931");
    assert.match(xml, /<ram:BuyerTradeParty>\s*<ram:Name>Beispielkunde<\/ram:Name>/);
  });

  it("writes no payment means without an IBAN, whatever the currency (BG-16 needs BT-84)", () => {
    const invoice = ready("standard-19");
    invoice.issuer = { ...invoice.issuer, iban: null, bic: null };
    const xml = buildCiiXml(invoice, "en16931");
    assert.doesNotMatch(xml, /SpecifiedTradeSettlementPaymentMeans/);
  });

  it("writes no electronic address when the snapshot has none", () => {
    const invoice = ready("standard-19");
    invoice.recipient = { ...invoice.recipient, electronicAddress: null, electronicAddressScheme: null };
    const xml = buildCiiXml(invoice, "en16931");
    const buyer = /<ram:BuyerTradeParty>[\s\S]*?<\/ram:BuyerTradeParty>/.exec(xml)?.[0] ?? "";
    assert.doesNotMatch(buyer, /URIUniversalCommunication/);
  });

  it("writes the last billed day, not the exclusive bound, as BT-72 and BT-74", () => {
    const xml = xmlOf("standard-19");
    assert.match(xml, /<ram:StartDateTime>\s*<udt:DateTimeString format="102">20260901</);
    assert.match(xml, /<ram:EndDateTime>\s*<udt:DateTimeString format="102">20260930</);
    assert.match(xml, /<ram:OccurrenceDateTime>\s*<udt:DateTimeString format="102">20260930</);
    assert.match(xml, /<ram:IssueDateTime>\s*<udt:DateTimeString format="102">20261001</);
    assert.match(xml, /<ram:DueDateDateTime>\s*<udt:DateTimeString format="102">20261015</);
  });

  it("long invoices number their lines up to 500", () => {
    const xml = xmlOf("long-500");
    assert.match(xml, /<ram:LineID>500<\/ram:LineID>/);
    assert.doesNotMatch(xml, /<ram:LineID>501<\/ram:LineID>/);
  });
});

describe("buildCiiXml: text", () => {
  const xml = xmlOf("escaping");

  it("escapes markup characters and keeps non-ASCII text and emoji", () => {
    assert.match(xml, /<ram:Name>R&amp;D &lt;phase 2&gt; &quot;alpha&quot; &apos;beta&apos; – Größe 😀 final<\/ram:Name>/u);
    assert.match(xml, /<ram:Name>Müller &amp; Söhne &lt;Test&gt; GmbH<\/ram:Name>/);
  });

  it("keeps newlines in notes, drops CR and control characters", () => {
    assert.match(xml, /<ram:Content>First line &amp; more\nSecond line &lt;b&gt;bold&lt;\/b&gt;\nThird line<\/ram:Content>/);
    assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\r]/);
  });
});

describe("buildCiiXml: invariants", () => {
  const tampered = (mutate: (invoice: EinvoiceReadyInvoice) => void): EinvoiceReadyInvoice => {
    const copy = structuredClone(ready("mixed-19-7"));
    mutate(copy);
    return copy;
  };
  const line = (invoice: EinvoiceReadyInvoice, index: number): EinvoiceReadyInvoice["lineItems"][number] => {
    const found = invoice.lineItems[index];
    assert.ok(found);
    return found;
  };
  const row = (invoice: EinvoiceReadyInvoice, index: number): EinvoiceReadyInvoice["taxBreakdown"][number] => {
    const found = invoice.taxBreakdown[index];
    assert.ok(found);
    return found;
  };

  const cases: Array<[string, RegExp, (invoice: EinvoiceReadyInvoice) => void]> = [
    ["no lines", /invariant 1/, (i) => {
      i.lineItems.splice(0);
    }],
    ["a line without a category", /invariant 1/, (i) => {
      Object.assign(line(i, 0), { taxCategory: "" });
    }],
    ["a zero-rate category with a rate", /invariant 1/, (i) => {
      Object.assign(line(i, 1), { taxCategory: "E" });
    }],
    ["a rate with three decimals", /invariant 1/, (i) => {
      line(i, 0).taxRate = 19.001;
    }],
    ["lines that do not sum to the subtotal", /invariant 2/, (i) => {
      i.subtotal = 1568.01;
      i.total = 1825.92;
    }],
    ["an amount with three decimals", /amount-2dp/, (i) => {
      line(i, 0).amount = 1234.505;
    }],
    ["a breakdown that does not sum to taxAmount", /invariant 3/, (i) => {
      i.taxAmount = 257.92;
      i.total = 1825.92;
    }],
    ["a total that is not subtotal + tax", /invariant 3/, (i) => {
      i.total = 1825.9;
    }],
    ["a breakdown basis that disagrees with its lines", /invariant 4/, (i) => {
      row(i, 0).basisAmount = 1234.4;
    }],
    ["lines without a breakdown row", /invariant 4/, (i) => {
      const removed = i.taxBreakdown.pop();
      row(i, 0).taxAmount = Math.round((row(i, 0).taxAmount + (removed?.taxAmount ?? 0)) * 100) / 100;
    }],
    ["a line whose amount is not quantity × price", /invariant 5/, (i) => {
      line(i, 0).hourlyRate = 91;
    }],
    ["payment terms with a line starting with #", /invariant 6/, (i) => {
      i.paymentTerms = "Payable in 14 days.\n#SKONTO#TAGE=7#PROZENT=2.00#";
    }],
  ];

  for (const [name, message, mutate] of cases) {
    it(`throws CiiInvariantError for ${name}`, () => {
      const invoice = tampered(mutate);
      assert.throws(
        () => buildCiiXml(invoice, "xrechnung"),
        (error: unknown) => error instanceof CiiInvariantError && message.test(error.message),
      );
    });
  }

  it("does not mutate its input", () => {
    const invoice = ready("standard-19");
    const before = structuredClone(invoice);
    buildCiiXml(invoice, "xrechnung");
    assert.deepEqual(invoice, before);
  });
});

describe("legacy invoice with totals one cent off", () => {
  const offByOneCent = (): ReturnType<typeof legacyInvoiceFixture> => {
    const invoice = legacyInvoiceFixture();
    const bump = (value: number): number => Math.round((value + 0.01) * 100) / 100;
    return { ...invoice, taxAmount: bump(invoice.taxAmount), total: bump(invoice.total) };
  };

  it("is refused by the fill planner", () => {
    const plan = planEinvoiceFill(
      offByOneCent(),
      { profile: businessProfileFixture(), client: { billing: clientBillingFixture() } },
      {},
    );
    assert.notEqual(plan.mismatch, null);
  });

  it("makes the serializer throw when forced through as ready", () => {
    const invoice = offByOneCent();
    const lines = invoice.lineItems.map((item) => ({ ...item, taxCategory: "S" as const, taxRate: 19 }));
    const totals = computeEn16931Totals(lines, {});
    const forced: EinvoiceReadyInvoice = {
      ...invoice,
      lineItems: lines,
      issuer: issuerFixture(),
      recipient: ready("standard-19").recipient,
      taxBreakdown: totals.breakdown,
      paymentTerms: null,
    };
    assert.throws(() => buildCiiXml(forced, "en16931"), CiiInvariantError);
  });
});

describe("xrechnungFilename", () => {
  it("sanitises the invoice number", () => {
    assert.equal(xrechnungFilename("2026-014"), "xrechnung-2026-014.xml");
    assert.equal(xrechnungFilename("RE/2026 #7"), "xrechnung-RE-2026-7.xml");
    assert.equal(xrechnungFilename("  "), "xrechnung-document.xml");
  });
});
