import test from "node:test";
import assert from "node:assert/strict";
import { mapParsedBillToNavanDraft } from "../src/shared/mapping.js";

test("mapParsedBillToNavanDraft maps all supported properties", () => {
  const draft = mapParsedBillToNavanDraft({
    invoiceDateISO: "2026-02-15",
    merchantName: "Orange",
    totalAmount: 48.9,
    currency: "EUR",
    taxAmount: 8,
    invoiceNumber: "INV-99"
  });

  assert.deepEqual(draft, {
    transactionDateISO: "2026-02-15",
    merchant: "Orange",
    amount: 48.9,
    currency: "EUR",
    taxAmount: 8,
    description: "Orange invoice INV-99"
  });
});
