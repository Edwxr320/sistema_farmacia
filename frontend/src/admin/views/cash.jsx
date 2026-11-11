import React, { useState } from 'react';
import { useAdmin, useRealtime } from '../context.jsx';
import { Card, Stat, PageHead, Table, Badge, Button, toast, EmptyState, KV, Pagination, AlertBox, ToneBadge, useAsync, Async } from '../../components/ui.jsx';
import { openModal } from '../../components/modal.jsx';
import { formModal } from '../../components/form.jsx';
import { money, dateTime, PAYMENT_METHODS, number } from '../../core/format.js';
import { Cell } from './_shared.jsx';

const MOVEMENT_LABEL = { SALE_INCOME: 'Cobro en efectivo', PAYMENT_REFUND: 'Reembolso de pago', RETURN_REFUND: 'Reembolso por devolución', CASH_IN: 'Ingreso manual', CASH_OUT: 'Retiro' };

function MovementsTable({ rows }) {
  return (
    <Table
      columns={[
        { label: 'Hora', render: (m) => dateTime(m.createdAt) },
        { label: 'Tipo', render: (m) => <ToneBadge tone={m.direction === 'IN' ? 'success' : 'warning'}>{MOVEMENT_LABEL[m.movementType] || m.movementType}</ToneBadge> },
        { label: 'Detalle', render: (m) => m.saleNumber || m.description || m.operationCode },
        { label: 'Usuario', render: (m) => m.performedBy.fullName },
        { label: 'Importe', num: true, render: (m) => `${m.direction === 'IN' ? '+' : '−'} ${money(m.amount)}` },
      ]}
      rows={rows} empty="Sin movimientos de efectivo"
    />
  );
}

export function SessionSummary({ s }) {
  return (
    <div className="stack">
      <div className="grid grid-4">
        <Stat label="Monto inicial" value={money(s.openingAmount)} />
        <Stat label="Ingresos" value={money(s.totalIn)} />
        <Stat label="Egresos" value={money(s.totalOut)} />
        <Stat label={s.status === 'OPEN' ? 'Saldo esperado (en vivo)' : 'Saldo esperado'} value={money(s.expectedAmount)} />
      </div>
      {s.status === 'CLOSED' ? (
        <div className="grid grid-2">
          <Stat label="Efectivo contado" value={money(s.countedAmount)} />
          <Stat label="Diferencia" value={money(s.differenceAmount)} sub={Number(s.differenceAmount) === 0 ? 'Caja cuadrada' : Number(s.differenceAmount) > 0 ? 'Sobrante' : 'Faltante'} />
        </div>
      ) : null}
      <div className="grid grid-2">
        <Card title="Datos de la sesión">
          <KV pairs={[
            ['Sesión', s.sessionNumber], ['Caja', `${s.register.name} (${s.register.code})`], ['Sucursal', s.branch.name],
            ['Abierta por', s.openedBy.fullName], ['Apertura', dateTime(s.openedAt)], ['Cierre', s.closedAt ? dateTime(s.closedAt) : '—'],
            ['Cerrada por', s.closedBy?.fullName], ['Observaciones', s.closingNotes || s.openingNotes],
          ]} />
        </Card>
        <Card title="Ventas y cobros">
          <div className="stack">
            <KV pairs={[['Ventas completadas', `${number(s.sales.completed)} · ${money(s.sales.completedTotal)}`], ['Ventas anuladas', number(s.sales.voided)], ['Descuentos', money(s.sales.discountTotal)]]} />
            <Table
              columns={[
                { label: 'Método', render: (p) => PAYMENT_METHODS[p.method] || p.method },
                { label: 'Estado', render: (p) => <Badge kind="payment" code={p.status} /> },
                { label: 'Cant.', num: true, render: (p) => p.count },
                { label: 'Importe', num: true, render: (p) => money(p.amount) },
              ]}
              rows={s.paymentsByMethod} empty="Sin cobros"
            />
          </div>
        </Card>
      </div>
      <Card title="Movimientos de efectivo" tight><MovementsTable rows={s.movements} /></Card>
    </div>
  );
}

export function Cash() {
  const ctx = useAdmin();
  const [page, setPage] = useState(1);

  const current = useAsync(async () => {
    const r = await ctx.api.get('/cash/sessions/current');
    if (r.data) return { open: r.data };
    const regs = await ctx.api.get('/cash/registers');
    return { open: null, regs: regs.data.filter((x) => x.branch.id === ctx.branchId && x.isActive) };
  }, []);
  const history = useAsync(
    () => ctx.api.get('/cash/sessions', { page, pageSize: 10, branchId: ctx.can('cash.view_all') ? ctx.branchId : undefined }),
    [page],
  );

  async function open(register) {
    const ok = await formModal({
      title: `Abrir ${register.name}`,
      fields: [
        { name: 'openingAmount', label: 'Monto inicial en efectivo', type: 'money', required: true, value: '0.00' },
        { name: 'notes', label: 'Observaciones', type: 'textarea', full: true },
      ],
      submitLabel: 'Abrir caja',
      onSubmit: (v) => ctx.api.post('/cash/sessions', { cashRegisterId: register.id, openingAmount: v.openingAmount, notes: v.notes }),
    });
    if (ok) { toast('Caja abierta', 'success'); current.reload(); history.reload(); }
  }

  async function movement(type) {
    const ok = await formModal({
      title: type === 'CASH_IN' ? 'Ingreso de efectivo' : 'Retiro de efectivo',
      fields: [
        { name: 'amount', label: 'Importe', type: 'money', required: true },
        { name: 'description', label: 'Motivo', type: 'text', required: true, full: true, placeholder: type === 'CASH_IN' ? 'Ej.: sencillo para vuelto' : 'Ej.: depósito bancario' },
      ],
      submitLabel: 'Registrar',
      onSubmit: (v) => ctx.api.post('/cash/movements', { movementType: type, amount: v.amount, description: v.description }),
    });
    if (ok) { toast('Movimiento registrado', 'success'); current.reload(); }
  }

  async function close(s) {
    const res = await formModal({
      title: 'Cerrar caja y arqueo',
      intro: <AlertBox tone="info">{`Saldo esperado en este momento: ${money(s.expectedAmount)}. El saldo final lo calcula el sistema al cerrar.`}</AlertBox>,
      fields: [
        { name: 'countedAmount', label: 'Efectivo contado', type: 'money', required: true },
        { name: 'notes', label: 'Observaciones', type: 'textarea', full: true },
      ],
      submitLabel: 'Cerrar caja',
      onSubmit: (v) => ctx.api.post(`/cash/sessions/${s.id}/close`, { countedAmount: v.countedAmount, notes: v.notes }),
    });
    if (res && res.data) {
      const c = res.data;
      openModal({ title: `Cierre de ${c.sessionNumber}`, size: 'lg', body: <SessionSummary s={c} /> });
      current.reload();
      history.reload();
    }
  }

  async function detail(id) {
    try {
      const r = await ctx.api.get(`/cash/sessions/${id}`);
      openModal({ title: `Sesión ${r.data.sessionNumber}`, size: 'xl', body: <SessionSummary s={r.data} /> });
    } catch (err) { toast(err.message, 'error'); }
  }

  useRealtime('sale:created', current.reload);
  useRealtime('cash:movement', current.reload);
  useRealtime('sale:voided', current.reload);

  return (
    <>
      <PageHead title="Caja" sub="Apertura, movimientos, arqueo y cierre de su sesión de caja." />
      <div className="stack">
        <Async state={current}>
          {({ open: s, regs }) => (s ? (
            <>
              <div className="row between">
                <div className="row"><h2>{`Sesión ${s.sessionNumber}`}</h2><Badge kind="cash" code={s.status} /></div>
                <div className="row">
                  {ctx.can('cash.movements') ? (
                    <>
                      <Button icon="plus" onClick={() => movement('CASH_IN')}>Ingreso</Button>
                      <Button icon="minus" onClick={() => movement('CASH_OUT')}>Retiro</Button>
                    </>
                  ) : null}
                  {ctx.can('cash.close') ? <Button variant="primary" icon="check" onClick={() => close(s)}>Cerrar caja</Button> : null}
                </div>
              </div>
              {s.branch.id !== ctx.branchId ? <AlertBox tone="info">{`Esta sesión es de ${s.branch.name}.`}</AlertBox> : null}
              <SessionSummary s={s} />
            </>
          ) : (
            <Card title="No tiene una caja abierta" tight>
              {regs.length ? (
                <Table
                  columns={[
                    { label: 'Caja', render: (x) => <Cell title={x.name} sub={x.code} /> },
                    { label: 'Estado', render: (x) => (x.openSession ? <span><Badge kind="cash" code="OPEN" />{` por ${x.openSession.openedBy.fullName}`}</span> : <Badge kind="cash" code="CLOSED" />) },
                    { label: '', render: (x) => (!x.openSession && ctx.can('cash.open') ? <Button variant="primary" size="sm" onClick={() => open(x)}>Abrir</Button> : null) },
                  ]}
                  rows={regs}
                />
              ) : <EmptyState title="Sin cajas en esta sucursal" text="Un administrador puede crearlas desde Sucursales." />}
            </Card>
          ))}
        </Async>
      </div>
      <div>
        <Async state={history}>
          {(r) => (
            <Card title="Historial de sesiones" tight>
              <div>
                <Table
                  columns={[
                    { label: 'Sesión', render: (s) => <Cell title={s.sessionNumber} sub={s.register.name} /> },
                    { label: 'Trabajador', render: (s) => s.openedBy.fullName },
                    { label: 'Apertura', render: (s) => dateTime(s.openedAt) },
                    { label: 'Cierre', render: (s) => (s.closedAt ? dateTime(s.closedAt) : '—') },
                    { label: 'Estado', render: (s) => <Badge kind="cash" code={s.status} /> },
                    { label: 'Esperado', num: true, render: (s) => money(s.expectedAmount) },
                    { label: 'Diferencia', num: true, render: (s) => (s.differenceAmount === null ? '—' : money(s.differenceAmount)) },
                  ]}
                  rows={r.data} empty="Sin sesiones" onRowClick={(s) => detail(s.id)}
                />
                <Pagination p={r.pagination} onChange={setPage} />
              </div>
            </Card>
          )}
        </Async>
      </div>
    </>
  );
}
