export function mapParsedBillToNavanDraft(parsedBill) {
  if (!parsedBill) return null;

  return {
    transactionDateISO: parsedBill.invoiceDateISO,
    merchant: parsedBill.merchantName,
    amount: parsedBill.totalAmount,
    currency: parsedBill.currency,
    taxAmount: parsedBill.taxAmount,
    description: parsedBill.invoiceNumber
      ? `Orange invoice ${parsedBill.invoiceNumber}`
      : `Orange billing ${parsedBill.invoiceDateISO}`
  };
}
