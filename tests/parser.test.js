import test from "node:test";
import assert from "node:assert/strict";
import { parseOrangeBill } from "../src/shared/parser.js";

test("parseOrangeBill extracts main fields from French-like text", () => {
  const parsed = parseOrangeBill("Orange France Facture no F-2026-10 Total: 123,45 EUR TVA: 20,00 Date: 15/02/2026", "bill.pdf");

  assert.ok(parsed);
  assert.equal(parsed.merchantName, "Orange");
  assert.equal(parsed.invoiceDateISO, "2026-02-15");
  assert.equal(parsed.currency, "EUR");
  assert.equal(parsed.totalAmount, 123.45);
  assert.equal(parsed.taxAmount, 20);
  assert.equal(parsed.sourceFileName, "bill.pdf");
});

test("parseOrangeBill returns null when required fields are missing", () => {
  const parsed = parseOrangeBill("missing all required fields");
  assert.equal(parsed, null);
});
