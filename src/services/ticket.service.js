'use strict';

/**
 * Tickets internos (sale_tickets). NO son boletas ni facturas: sin integración SUNAT.
 * Los datos del encabezado son snapshots tomados al emitir (trigger trg_sale_tickets_bi).
 */

const { withConnection, withTransaction } = require('../config/database');
const { AppError } = require('../utils/app-error');
const saleRepository = require('../repositories/sale.repository');
const documentSequence = require('../repositories/document-sequence.repository');
const auditRepository = require('../repositories/audit.repository');
const { assertBranchAccess, assertBranchAccessInTx } = require('./branch-access.service');

const LOGO_URL = '/img/Logo-pharma-plus.jpeg';
const DEFAULT_LEGEND = 'Ticket interno. No es un comprobante de pago electrónico.';

async function buildTicket(conn, saleId) {
  const t = await saleRepository.findTicket(conn, saleId);
  if (!t) return null;
  const payments = await saleRepository.findPayments(conn, saleId);
  const h = t.header;
  return {
    documentType: 'TICKET_INTERNO',
    isTaxReceipt: false,
    logoUrl: LOGO_URL,
    ticketNumber: h.ticket_number,
    issuedAt: h.issued_at,
    business: { name: h.business_name, ruc: h.business_ruc },
    branch: { id: t.meta.branch_id, name: h.branch_name, address: h.branch_address, phone: h.branch_phone },
    sale: { id: h.sale_id, saleNumber: h.sale_number, soldAt: h.sold_at, status: h.sale_status },
    seller: h.seller_name,
    customer: h.customer_name ? { name: h.customer_name, document: t.meta.customer_document_snapshot } : null,
    items: t.lines.map((l) => ({
      sku: l.sku, name: l.product_name, quantity: Number(l.quantity), unitPrice: l.unit_price,
      discountAmount: l.discount_amount, lineTotal: l.line_total, batches: l.batches,
    })),
    subtotal: h.subtotal,
    discountTotal: h.discount_total,
    total: h.total,
    payments: payments
      .filter((p) => ['APPROVED', 'REFUNDED'].includes(p.status))
      .map((p) => ({
        method: p.method, status: p.status, amount: p.amount, tenderedAmount: p.tendered_amount, changeAmount: p.change_amount,
        mode: Number(p.is_simulated) ? 'DEMO' : 'REAL', reference: p.external_reference, operationCode: p.operation_code,
      })),
    changeGiven: h.change_given,
    legend: h.legend || DEFAULT_LEGEND,
    printCount: Number(h.print_count),
    lastPrintedAt: t.meta.last_printed_at,
  };
}

async function get(saleId, auth, ctx) {
  return withConnection(ctx, async (conn) => {
    const sale = await saleRepository.findSale(conn, saleId);
    if (!sale) throw AppError.notFound('Venta no encontrada');
    assertBranchAccess(auth, sale.branch_id);
    const ticket = await buildTicket(conn, saleId);
    if (!ticket) throw AppError.notFound('La venta no tiene ticket emitido');
    return ticket;
  });
}

/** Emite el ticket si falta (solo ventas COMPLETED). Idempotente: uno por venta. */
async function issue(saleId, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const sale = await saleRepository.lockSale(conn, saleId);
    if (!sale) throw AppError.notFound('Venta no encontrada');
    await assertBranchAccessInTx(conn, auth, sale.branch_id);
    const existing = await buildTicket(conn, saleId);
    if (existing) return existing;
    if (sale.status !== 'COMPLETED') throw AppError.conflict('No se emite ticket para una venta anulada', 'SALE_VOIDED');
    const ticketNumber = await documentSequence.nextNumber(conn, sale.branch_id, 'TICKET');
    await saleRepository.insertTicket(conn, {
      ticketNumber, saleId, issuedBy: auth.userId, legend: await saleRepository.getSetting(conn, 'tickets.legend'),
    });
    await auditRepository.log(conn, { action: 'ISSUE', module: 'sales', table: 'sale_tickets', entityId: saleId, newValues: { ticket_number: ticketNumber } });
    return buildTicket(conn, saleId);
  });
}

/** Registra una impresión (la primera o una reimpresión) y devuelve el ticket. */
async function print(saleId, auth, ctx) {
  return withTransaction(ctx, async (conn) => {
    const sale = await saleRepository.lockSale(conn, saleId);
    if (!sale) throw AppError.notFound('Venta no encontrada');
    await assertBranchAccessInTx(conn, auth, sale.branch_id);
    if ((await saleRepository.registerPrint(conn, saleId)) !== 1) throw AppError.notFound('La venta no tiene ticket emitido');
    const ticket = await buildTicket(conn, saleId);
    await auditRepository.log(conn, {
      action: ticket.printCount > 1 ? 'REPRINT' : 'PRINT', module: 'sales', table: 'sale_tickets', entityId: saleId,
      newValues: { ticket_number: ticket.ticketNumber, print_count: ticket.printCount },
    });
    return ticket;
  });
}

// ---------------------------------------------------------------- vista HTML
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAY_LABEL = { CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia', YAPE: 'Yape', PLIN: 'Plin', OTHER: 'Otro' };

function renderHtml(t) {
  const rows = t.items.map((i) => `
      <tr><td colspan="3">${esc(i.name)}</td></tr>
      <tr class="sub"><td>${i.quantity} x S/ ${esc(i.unitPrice)}${Number(i.discountAmount) > 0 ? ` (desc. -${esc(i.discountAmount)})` : ''}</td>
          <td></td><td class="r">S/ ${esc(i.lineTotal)}</td></tr>`).join('');
  const pays = t.payments.map((p) => `
      <tr><td>${esc(PAY_LABEL[p.method] || p.method)}${p.mode === 'DEMO' ? ' (DEMO)' : ''}${p.status === 'REFUNDED' ? ' — REEMBOLSADO' : ''}</td>
          <td></td><td class="r">S/ ${esc(p.amount)}</td></tr>
      ${p.reference ? `<tr class="sub"><td colspan="3">Ref.: ${esc(p.reference)}</td></tr>` : ''}
      ${p.tenderedAmount ? `<tr class="sub"><td>Recibido S/ ${esc(p.tenderedAmount)}</td><td></td><td class="r">Vuelto S/ ${esc(p.changeAmount)}</td></tr>` : ''}`).join('');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ticket ${esc(t.ticketNumber)}</title>
<style>
  body { font-family: "Courier New", monospace; font-size: 12px; width: 300px; margin: 0 auto; padding: 8px; color: #000; background: #fff; }
  .c { text-align: center; } .r { text-align: right; } table { width: 100%; border-collapse: collapse; }
  .sub td { font-size: 11px; color: #333; } hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .tot td { font-weight: bold; font-size: 14px; } .void { border: 2px solid #000; padding: 4px; font-weight: bold; text-align: center; }
  img { max-width: 180px; }
  @media print { body { width: auto; } }
</style></head><body>
  <div class="c"><img src="${esc(t.logoUrl)}" alt="Pharma Plus"></div>
  <div class="c"><strong>${esc(t.business.name)}</strong>${t.business.ruc ? `<br>RUC ${esc(t.business.ruc)}` : ''}
    <br>${esc(t.branch.name)}${t.branch.address ? `<br>${esc(t.branch.address)}` : ''}${t.branch.phone ? `<br>Tel. ${esc(t.branch.phone)}` : ''}</div>
  <hr>
  <div><strong>TICKET INTERNO ${esc(t.ticketNumber)}</strong><br>Venta: ${esc(t.sale.saleNumber)}<br>Fecha: ${esc(t.sale.soldAt)}
    <br>Atendido por: ${esc(t.seller)}${t.customer ? `<br>Cliente: ${esc(t.customer.name)}${t.customer.document ? ` (${esc(t.customer.document)})` : ''}` : ''}</div>
  ${t.sale.status === 'VOIDED' ? '<hr><div class="void">VENTA ANULADA</div>' : ''}
  ${t.printCount > 1 ? `<div class="c">*** REIMPRESIÓN N.º ${t.printCount - 1} ***</div>` : ''}
  <hr><table>${rows}</table><hr>
  <table>
    <tr><td>Subtotal</td><td></td><td class="r">S/ ${esc(t.subtotal)}</td></tr>
    ${Number(t.discountTotal) > 0 ? `<tr><td>Descuento</td><td></td><td class="r">- S/ ${esc(t.discountTotal)}</td></tr>` : ''}
    <tr class="tot"><td>TOTAL</td><td></td><td class="r">S/ ${esc(t.total)}</td></tr>
  </table><hr>
  <table>${pays}</table><hr>
  <div class="c">${esc(t.legend)}<br>No válido como boleta ni factura.</div>
</body></html>`;
}

module.exports = { get, issue, print, renderHtml, LOGO_URL };
