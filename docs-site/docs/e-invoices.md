---
title: E-invoices (XRechnung and ZUGFeRD)
sidebar_label: E-invoices
description: Send an invoice as XRechnung XML or as a ZUGFeRD PDF with the invoice data inside. Complete your business profile, add your client's billing details and fix what the check reports.
---

# E-invoices (XRechnung and ZUGFeRD)

Public-sector customers in Germany ask for invoices their software can read,
and more businesses ask for the same. Track Your Time makes that file from an
invoice you already created: an XRechnung XML file, or a ZUGFeRD PDF that a
person can read and software can process.

You enter your business details once and each client's details once. After
that, a new invoice can be downloaded in both formats. When something is
missing, the invoice tells you which field it is and links to it.

This page explains the data the formats need. It is not tax or legal advice.
Ask your tax advisor (Steuerberater) which VAT treatment applies to you.

## What you can download

Every invoice has three downloads on its detail view:

| Download | What you get | Who asks for it |
| --- | --- | --- |
| **Download PDF** | The invoice as a normal PDF. | Customers who do not need an e-invoice. |
| **Download ZUGFeRD PDF** | A PDF/A-3 file. The invoice data is attached inside it as `factur-x.xml`, in the EN 16931 profile. | Businesses. The PDF opens in any viewer, and accounting software reads the attached data. |
| **Download XRechnung XML** | An XRechnung 3.0 file in CII syntax. There is no PDF. | Public-sector customers. They give you a Leitweg-ID for it. |

Your server makes all three files. Invoice data does not go to another
service to make them.

## Complete your business profile

Open **Settings → Billing**. The card **Business profile** holds the details
that print as the issuer of your invoices. Fill in the fields, then click
**Save business profile**. The button stays disabled while a field holds a
value the server would refuse, and the field says why.

| Field | ZUGFeRD | XRechnung | Notes |
| --- | --- | --- | --- |
| Legal name | Required | Required | The registered name of your business. |
| Address line 1, Postal code, City, Country code | Required | Required | The country code has two letters, for example DE. |
| Email | Optional | Required | Also used as your electronic address when that field is empty. |
| Phone | Optional | Required | |
| VAT ID (USt-IdNr) | See notes | See notes | Enter your VAT ID or your tax number. Reverse-charge invoices need the VAT ID. |
| Tax number (Steuernummer) | See notes | See notes | Needed when you have no VAT ID. |
| Register number, Seller identifier | See notes | See notes | Needed when the e-invoice shows no VAT ID: you have none, or the invoice is not subject to German VAT. One of the two is enough. |
| Contact person | Optional | Required | |
| Electronic address | Optional | Required | Where customers send e-invoices to you. Empty uses your email address. |
| IBAN | Optional | Required | BIC, bank name and account holder are optional. |
| Payment terms in days | Optional | Optional | Sets the due date of a new invoice. The e-invoice states the due date in the same sentence as the PDF. |
| Small business under § 19 UStG | | | See [Small businesses](#small-businesses-kleinunternehmer). |
| Default VAT | | | Selected on every new invoice. |

Only workspace owners and admins can change the business profile. The
e-invoice panel and its downloads follow the invoice permissions: a member who
cannot open an invoice cannot download it in any format.

Changes apply to invoices you create after the change. An invoice keeps the
details it was created with. See
[Invoices do not change after you create them](#invoices-do-not-change-after-you-create-them).

### A tax ID from before e-invoicing

Before e-invoicing, the profile had one free-text **Tax ID** field. An
e-invoice must say whether a number is a VAT ID or a tax number, and the app
does not guess. While that old value is set, the form shows it with two
buttons: **Use as VAT ID** and **Use as tax number**. Each moves the text into
that field. Save to keep the change.

### Small businesses (Kleinunternehmer)

Tick **Small business under § 19 UStG** if you invoice without VAT. The
default VAT then becomes **Exempt (E)**, and the **Exemption note** starts
with a standard sentence that you can change. It is printed on each invoice
as the reason for no VAT.

## Add your client's billing details

Open **Clients**, click a client's row menu, then **Edit**. Open **Billing
details** in the dialog, fill in the fields, then click **Save changes**.

| Field | ZUGFeRD | XRechnung | Notes |
| --- | --- | --- | --- |
| Legal name | Optional | Optional | Empty uses the client's name. |
| Address line 1, Postal code, City, Country code | Required | Required | |
| VAT ID | See notes | See notes | Needed for reverse charge (AE). |
| Reference | Optional | Required | The buyer reference. A public-sector client in Germany gives you a Leitweg-ID for it. |
| Electronic address | Optional | Required | Where this client receives e-invoices. Empty uses the billing email. |
| Invoice format | Optional | Optional | The download an invoice for this client offers first. |
| Default VAT category | Optional | Optional | For example reverse charge for a business in another EU country. The dialog suggests one from the two country codes. |

A client whose old **Tax ID** is set shows it with a **Use as VAT ID** button,
as in the business profile.

## Choose the VAT when you create the invoice

The **New invoice** dialog has a **VAT** field. It starts with the client's
default VAT category, or with your profile's default VAT. You can change it
for this invoice.

| VAT choice | Category | When a German services business uses it | What the invoice needs |
| --- | --- | --- | --- |
| 19 % standard rate, 7 % reduced rate, Other rate | S | Most services to customers in Germany. | A rate above 0. |
| 0 % zero rated | Z | Rarely for services taxed in Germany. | Nothing extra. |
| Exempt | E | Small businesses under § 19 UStG, and other exemptions. | A reason, printed on the invoice. |
| Reverse charge | AE | Services to a business in another EU country. The customer pays the VAT. | A reason, your VAT ID and the client's VAT ID. |
| Not subject to German VAT | O | Services that are not taxable in Germany. | No other category on the same invoice. No VAT IDs are printed. |
| No VAT details | none | Only when you do not want an e-invoice for this invoice. Not offered when your profile or the client has a default VAT. | Nothing. The invoice can then only be downloaded as a plain PDF. |

For **Exempt**, **Reverse charge** and **Not subject to German VAT**, the
dialog shows a field for the reason. Reverse charge and not subject to VAT
start with a standard sentence. Exempt starts with your exemption note when
you are a small business, and is empty otherwise. **Create invoice…** stays
disabled while a reason is empty.

When reverse charge is chosen for a client without a VAT ID, the dialog warns
and offers **Add the VAT ID**. That opens the client's billing details over
the invoice dialog with the VAT ID field selected. The invoice you are
building stays as it is.

Turn on **Different VAT per line** to give each line its own VAT choice. The
invoice then shows one VAT row per rate.

VAT is calculated once per category and rate, from the sum of the line
amounts. It is not calculated per line and then added up. The two methods can
differ by a cent, and the e-invoice standard (EN 16931) requires the first one.

## Download the file, or fix what is missing

The invoice detail view has an **E-invoice** panel with the two e-invoice
downloads. It checks the invoice against the format you pick. When the check
passes, the panel says **Ready** and shows the seller, the buyer, the buyer
reference and the VAT categories that go into the file.

When something is missing, the panel lists each problem under the place where
you fix it:

- **Business profile (Settings)**, for example "Your postal code is missing."
  The **Fix in settings** link opens Settings → Billing with that field
  selected.
- **Client billing details**, for example "The buyer reference (for example
  the Leitweg-ID) is missing." The **Edit client** link opens that client's
  edit dialog with the billing details open and that field selected.
- **This invoice**, for data that was fixed when the invoice was created.

A link from the invoice adds a **Back to the invoice** link to the form it
opens.

The e-invoice download buttons are never greyed out. When data is missing, the
server refuses the download and the panel lists the problems. No file is made
in that case. The plain PDF still downloads.

XRechnung needs more data than ZUGFeRD: a contact person, phone, email, your
electronic address and IBAN, and the client's reference and electronic
address. So an invoice can be ready for ZUGFeRD and not ready for XRechnung.

## Invoices do not change after you create them

An invoice stores its own copy of your details, the client's details, the VAT
of each line and the totals. A later change to your profile or to the client
does not change an invoice you already created.

For a draft, each e-invoice download is made again from that stored copy. For
an invoice that is no longer a draft, the first XRechnung or ZUGFeRD download
stores the XML for that format. Every later download uses that same XML:

- An XRechnung download returns the stored file byte for byte.
- A ZUGFeRD download embeds the stored XML in a PDF that is made again from the
  stored copy of the invoice. The page shows the same details, but the PDF file
  itself (for example its creation time) is new.

After the first e-invoice download, the details on the invoice are final. The
**Fill in missing details…** step is then no longer offered, for either
format.

## Invoices created before e-invoicing, or with missing details

An invoice created before you filled in your profile has no seller or buyer
details stored. It still downloads as a plain PDF.

For an e-invoice, open its E-invoice panel and click **Fill in missing
details…**. The dialog lists every value it will copy from your business
profile and from the client as they are today. Values it copies also appear
on the invoice PDF from then on, and the dialog names each change to the PDF:
the copied details, the VAT rows and exemption reason, and the payment terms. Check that each value was also correct
on the issue date, tick **I checked these values**, and confirm.

- The fill only adds values that the invoice does not have. It never replaces
  a stored value.
- The amounts never change. The dialog shows the subtotal, tax and total that
  stay on the invoice.
- An invoice that was issued with a VAT rate above 0 gets that rate as the
  standard rate on every line.
- An invoice that was issued with 0 % or no VAT asks you why: exempt, reverse
  charge, not subject to German VAT, or zero rated.

Some older invoices cannot become e-invoices. Their tax was rounded by an
older calculation, and the e-invoice standard gives a tax amount that differs
by a cent. The
dialog then shows both sets of figures and offers the plain PDF only. Changing
the amounts of an issued invoice is not an option, so nothing is written.

## Checking the files

Both formats follow public standards, so you can check any downloaded file
with the validator your customer or your tax advisor uses.

The project checks its own output on every change to the e-invoice code. A CI
job makes a fixed set of sample invoices through the same code the app uses,
and runs them through two open-source validators:

- **Mustang 2.26.0**, with **veraPDF** inside it, for every ZUGFeRD PDF and its
  EN 16931 XML. It checks the XML schema, the EN 16931 rules and PDF/A-3b.
- **KoSIT validator 1.6.3** with the XRechnung 3.0.2 configuration, for every
  XRechnung file.

The job fails when a validator rejects a sample. It also gives each validator
a deliberately broken file and fails when the validator accepts it.

The samples cover 19 % and 7 %, mixed rates, zero rated, exempt, reverse
charge, not subject to VAT (in euros and in Swiss francs), a Leitweg-ID, a
filled legacy invoice, special characters in names and a 500-line invoice.
Passing these validators is not a certification, and it does not replace the
check your customer's software makes.

### Running the check on your own machine

Making e-invoices needs no extra software on your server. The check does: it
needs Java 11 or later, and it downloads the two validators on the first run.

```bash
# Write the sample XML and PDF files, without a database
pnpm --filter @starter/server run einvoice:samples -- --out /tmp/einvoice-samples

# Write the samples and run both validators over them
JAVA=/path/to/java pnpm einvoice:validate
```

`einvoice:validate` keeps the validators in `.cache/einvoice-validators` and
its reports in `.cache/einvoice-validation`. It exits with an error when any
file fails, and when a validator does not reject a deliberately broken file.

## Limits

- Only German VAT cases for services. There are no categories for deliveries
  of goods, such as intra-community supply or export.
- One currency per invoice.
- XRechnung is written in CII syntax only, not UBL.
- The app does not send e-invoices. You download the file and send it by email
  or upload it to your customer's portal.
- There are no credit notes or corrected invoices.
