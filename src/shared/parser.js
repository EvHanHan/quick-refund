export function parseOrangeBill(rawText, fallbackFileName = "orange-bill.pdf") {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();

  const merchantName = extractMerchant(text);
  const totalAmount = extractAmount(text);
  const taxAmount = extractTax(text);
  const invoiceDateISO = extractDateISO(text);
  const currency = extractCurrency(text);
  const invoiceNumber = extractInvoiceNumber(text);

  if (!merchantName || !totalAmount || !invoiceDateISO || !currency) {
    return null;
  }

  return {
    merchantName,
    invoiceDateISO,
    currency,
    totalAmount,
    taxAmount,
    invoiceNumber,
    sourceFileName: fallbackFileName,
    sourceMimeType: fallbackFileName.endsWith(".html") ? "text/html" : "application/pdf"
  };
}

function extractMerchant(text) {
  return /orange/i.test(text) ? "Orange" : null;
}

function extractAmount(text) {
  const value = matchGroup(text, /(total|montant|amount)\s*[:\-]?\s*(\d+[\d.,]*)\s?(EUR|USD|GBP|€|\$|£)?/i, 2)
    || matchGroup(text, /(\d+[\d.,]*)\s?(EUR|USD|GBP|€|\$|£)/i, 1);

  if (!value) return null;
  const normalized = parseLocalizedNumber(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function extractTax(text) {
  const value = matchGroup(text, /(tax|vat|tva)\s*[:\-]?\s*(\d+[\d.,]*)/i, 2);
  if (!value) return undefined;
  const normalized = parseLocalizedNumber(value);
  return Number.isFinite(normalized) ? normalized : undefined;
}

function extractDateISO(text) {
  const iso = matchGroup(text, /(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso;

  const euMatch = text.match(/(\d{2})[\/.-](\d{2})[\/.-](\d{4})/);
  if (euMatch) {
    return `${euMatch[3]}-${euMatch[2]}-${euMatch[1]}`;
  }

  return null;
}

function extractCurrency(text) {
  const currency = matchGroup(text, /(EUR|USD|GBP|€|\$|£)/i);
  if (!currency) return null;
  const upper = currency.toUpperCase();
  if (upper === "€") return "EUR";
  if (upper === "$") return "USD";
  if (upper === "£") return "GBP";
  return upper;
}

function extractInvoiceNumber(text) {
  return matchGroup(text, /(invoice|facture)\s*(no|number|#)?\s*[:\-]?\s*([A-Z0-9-]+)/i, 3) || undefined;
}

function matchGroup(text, regex, group = 1) {
  const match = text.match(regex);
  return match && match[group] ? match[group].trim() : null;
}

function parseLocalizedNumber(raw) {
  const value = String(raw).trim();
  const lastDot = value.lastIndexOf(".");
  const lastComma = value.lastIndexOf(",");

  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) {
      return Number.parseFloat(value.replace(/\./g, "").replace(",", "."));
    }
    return Number.parseFloat(value.replace(/,/g, ""));
  }

  if (lastComma >= 0) {
    return Number.parseFloat(value.replace(",", "."));
  }

  return Number.parseFloat(value);
}
