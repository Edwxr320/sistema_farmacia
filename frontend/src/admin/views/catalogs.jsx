import React, { useState } from 'react';
import { useAdmin } from '../context.jsx';
import {
  Card, PageHead, Table, Button, toast, Pagination, SearchInput, Select, confirmDialog, ToneBadge, KV, useAsync, Async,
} from '../../components/ui.jsx';
import { openModal } from '../../components/modal.jsx';
import { formModal } from '../../components/form.jsx';
import { dateTime, money, errorMessage } from '../../core/format.js';
import { Cell } from './_shared.jsx';

/**
 * Pantalla de mantenimiento genérica.
 * cfg: { title, sub, endpoint, managePerm, columns, fields(row), toBody(values,row), filters, toggle, detail(ctx,row) }
 */
function crud(cfg) {
  return function CrudView() {
    const ctx = useAdmin();
    const [f, setF] = useState({ q: '', page: 1, ...(cfg.defaultFilters || {}) });
    const canManage = ctx.can(cfg.managePerm);
    const state = useAsync(() => ctx.api.get(cfg.endpoint, { ...f, pageSize: 20 }), [f]);

    async function edit(row) {
      const ok = await formModal({
        title: row ? `Editar ${cfg.noun}` : `Nuevo ${cfg.noun}`, size: cfg.size, fields: cfg.fields(row),
        onSubmit: (v) => (row ? ctx.api.put(`${cfg.endpoint}/${row.id}`, cfg.toBody(v, row)) : ctx.api.post(cfg.endpoint, cfg.toBody(v))),
      });
      if (ok) { toast('Guardado', 'success'); state.reload(); }
    }

    async function toggle(row) {
      const activate = !cfg.toggle.isActive(row);
      const ok = await confirmDialog({ title: `${activate ? 'Activar' : 'Desactivar'} ${cfg.noun}`, message: activate ? 'Volverá a estar disponible.' : 'Dejará de estar disponible para nuevas operaciones. El historial se conserva.', danger: !activate });
      if (!ok) return;
      try { await cfg.toggle.send(ctx, row, activate); toast('Estado actualizado', 'success'); state.reload(); } catch (err) { toast(errorMessage(err), 'error'); }
    }

    const cols = [...cfg.columns];
    if (canManage) {
      cols.push({ label: '', render: (row) => (
        <div className="actions">
          <Button size="sm" icon="edit" onClick={() => edit(row)}>Editar</Button>
          {cfg.toggle ? <Button size="sm" variant={cfg.toggle.isActive(row) ? 'danger' : 'success'} onClick={() => toggle(row)}>{cfg.toggle.isActive(row) ? 'Desactivar' : 'Activar'}</Button> : null}
        </div>
      ) });
    }

    return (
      <>
        <PageHead title={cfg.title} sub={cfg.sub} actions={canManage ? <Button variant="primary" icon="plus" onClick={() => edit()}>{`Nuevo ${cfg.noun}`}</Button> : null} />
        <div className="card card-body toolbar">
          <SearchInput placeholder={cfg.searchPlaceholder || 'Buscar…'} onSearch={(q) => setF((x) => ({ ...x, q, page: 1 }))} />
          {(cfg.filters || []).map((x) => (
            <Select key={x.key} options={x.options} value={f[x.key] ?? ''} onChange={(v) => setF((y) => ({ ...y, [x.key]: v, page: 1 }))} label={x.label} placeholder={x.placeholder} />
          ))}
        </div>
        <div>
          <Async state={state}>
            {(r) => (
              <Card tight>
                <div>
                  <Table columns={cols} rows={r.data} empty={`Sin ${cfg.plural}`} onRowClick={cfg.detail ? (row) => cfg.detail(ctx, row) : undefined} />
                  <Pagination p={r.pagination} onChange={(page) => setF((x) => ({ ...x, page }))} />
                </div>
              </Card>
            )}
          </Async>
        </div>
      </>
    );
  };
}

const activeBadge = (v) => (v ? <ToneBadge tone="success">Activo</ToneBadge> : <ToneBadge tone="neutral">Inactivo</ToneBadge>);
const activeFilter = { key: 'isActive', label: 'Estado', placeholder: 'Todos', options: [{ value: 'true', label: 'Activos' }, { value: 'false', label: 'Inactivos' }] };
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export const Categories = crud({
  title: 'Categorías', sub: 'Agrupan los productos en el panel y la tienda.', noun: 'categoría', plural: 'categorías', endpoint: '/categories',
  managePerm: 'categories.manage', searchPlaceholder: 'Nombre de la categoría…', filters: [activeFilter],
  columns: [
    { label: 'Categoría', render: (c) => <Cell title={c.name} sub={c.description || ''} /> },
    { label: 'Productos', num: true, render: (c) => c.productsCount },
    { label: 'Estado', render: (c) => activeBadge(c.isActive) },
  ],
  fields: (c) => [
    { name: 'name', label: 'Nombre', required: true, full: true, value: c?.name },
    { name: 'description', label: 'Descripción', type: 'textarea', full: true, value: c?.description, emptyAs: null },
  ],
  toBody: (v) => v,
  toggle: { isActive: (c) => c.isActive, send: (ctx, c, isActive) => ctx.api.patch(`/categories/${c.id}/status`, { isActive }) },
});

export const Laboratories = crud({
  title: 'Laboratorios', sub: 'Fabricantes asociados a los productos.', noun: 'laboratorio', plural: 'laboratorios', endpoint: '/laboratories',
  managePerm: 'categories.manage', searchPlaceholder: 'Nombre del laboratorio…', filters: [activeFilter],
  columns: [
    { label: 'Laboratorio', render: (l) => <span className="cell-title">{l.name}</span> },
    { label: 'País', render: (l) => l.country },
    { label: 'Productos', num: true, render: (l) => l.productsCount },
    { label: 'Estado', render: (l) => activeBadge(l.isActive) },
  ],
  fields: (l) => [
    { name: 'name', label: 'Nombre', required: true, value: l?.name },
    { name: 'country', label: 'País', value: l?.country, emptyAs: null },
  ],
  toBody: (v) => v,
  toggle: { isActive: (l) => l.isActive, send: (ctx, l, isActive) => ctx.api.patch(`/laboratories/${l.id}/status`, { isActive }) },
});

export const Suppliers = crud({
  title: 'Proveedores', sub: 'Proveedores de mercadería (RUC validado con dígito verificador).', noun: 'proveedor', plural: 'proveedores', endpoint: '/suppliers',
  managePerm: 'suppliers.manage', searchPlaceholder: 'Razón social o nombre comercial…', size: 'lg',
  filters: [{ key: 'status', label: 'Estado', placeholder: 'Todos', options: [{ value: 'ACTIVE', label: 'Activos' }, { value: 'INACTIVE', label: 'Inactivos' }] }],
  columns: [
    { label: 'Proveedor', render: (s) => <Cell title={s.businessName} sub={s.tradeName || ''} /> },
    { label: 'RUC', render: (s) => <span className="mono">{s.ruc || '—'}</span> },
    { label: 'Contacto', render: (s) => [s.contactName, s.phone, s.email].filter(Boolean).join(' · ') },
    { label: 'Entradas', num: true, render: (s) => s.entriesCount },
    { label: 'Estado', render: (s) => activeBadge(s.status === 'ACTIVE') },
  ],
  fields: (s) => [
    { name: 'businessName', label: 'Razón social', required: true, full: true, value: s?.businessName },
    { name: 'tradeName', label: 'Nombre comercial', value: s?.tradeName, emptyAs: null },
    { name: 'ruc', label: 'RUC', value: s?.ruc, emptyAs: null, hint: '11 dígitos' },
    { name: 'contactName', label: 'Contacto', value: s?.contactName, emptyAs: null },
    { name: 'phone', label: 'Teléfono', value: s?.phone, emptyAs: null },
    { name: 'email', label: 'Correo', type: 'email', value: s?.email, emptyAs: null },
    { name: 'addressLine', label: 'Dirección', value: s?.addressLine, emptyAs: null },
    { name: 'district', label: 'Distrito', value: s?.district, emptyAs: null },
    { name: 'province', label: 'Provincia', value: s?.province, emptyAs: null },
    { name: 'department', label: 'Departamento', value: s?.department, emptyAs: null },
    { name: 'notes', label: 'Notas', type: 'textarea', full: true, value: s?.notes, emptyAs: null },
  ],
  toBody: (v, s) => (s ? compact(Object.fromEntries(Object.entries(v).filter(([k, val]) => String(val ?? '') !== String(s[k] ?? '')))) : v),
  toggle: { isActive: (s) => s.status === 'ACTIVE', send: (ctx, s, active) => ctx.api.patch(`/suppliers/${s.id}/status`, { status: active ? 'ACTIVE' : 'INACTIVE' }) },
  detail: async (ctx, s) => {
    const r = await ctx.api.get(`/suppliers/${s.id}/entries`, { pageSize: 20 }).catch(() => ({ data: [] }));
    openModal({
      title: s.businessName, size: 'lg',
      body: (
        <div className="stack">
          <KV pairs={[['RUC', s.ruc], ['Contacto', s.contactName], ['Teléfono', s.phone], ['Correo', s.email], ['Dirección', [s.addressLine, s.district, s.province].filter(Boolean).join(', ')]]} />
          <h3>Historial de entradas</h3>
          <Table
            columns={[
              { label: 'Entrada', key: 'entry_number' }, { label: 'Fecha', render: (e) => dateTime(e.received_at) }, { label: 'Estado', key: 'status' },
              { label: 'Total', num: true, render: (e) => money(e.total_cost) },
            ]}
            rows={r.data} empty="Sin entradas registradas"
          />
        </div>
      ),
    });
  },
});

export const Customers = crud({
  title: 'Clientes', sub: 'Clientes de mostrador y de la tienda virtual (las cuentas web las gestiona el propio cliente).', noun: 'cliente', plural: 'clientes',
  endpoint: '/customers', managePerm: 'customers.manage', searchPlaceholder: 'Nombre, documento, teléfono o correo…', size: 'lg',
  filters: [activeFilter, { key: 'hasAccount', label: 'Tipo', placeholder: 'Todos', options: [{ value: 'true', label: 'Con cuenta web' }, { value: 'false', label: 'Solo mostrador' }] }],
  columns: [
    { label: 'Cliente', render: (c) => <Cell title={c.fullName} sub={c.documentNumber ? `${c.documentType} ${c.documentNumber}` : 'Sin documento'} /> },
    { label: 'Contacto', render: (c) => [c.phone, c.email].filter(Boolean).join(' · ') },
    { label: 'Tipo', render: (c) => (c.hasAccount ? <ToneBadge tone="info">Cuenta web</ToneBadge> : <ToneBadge tone="neutral">Mostrador</ToneBadge>) },
    { label: 'Compras', num: true, render: (c) => c.purchases },
    { label: 'Pedidos', num: true, render: (c) => c.orders },
    { label: 'Estado', render: (c) => activeBadge(c.isActive) },
  ],
  fields: (c) => [
    { name: 'fullName', label: 'Nombre completo', required: true, full: true, value: c?.fullName },
    { name: 'documentType', label: 'Tipo de documento', type: 'select', value: c?.documentType, placeholder: 'Sin documento', emptyAs: null,
      options: [{ value: 'DNI', label: 'DNI' }, { value: 'CE', label: 'Carné de extranjería' }, { value: 'PASSPORT', label: 'Pasaporte' }, { value: 'RUC', label: 'RUC' }, { value: 'OTHER', label: 'Otro' }] },
    { name: 'documentNumber', label: 'Número de documento', value: c?.documentNumber, emptyAs: null },
    { name: 'phone', label: 'Teléfono', value: c?.phone, emptyAs: null },
    { name: 'email', label: 'Correo', type: 'email', value: c?.email, emptyAs: null, disabled: Boolean(c?.hasAccount), hint: c?.hasAccount ? 'Lo gestiona el cliente desde la tienda' : undefined },
    { name: 'birthDate', label: 'Fecha de nacimiento', type: 'date', value: c?.birthDate, emptyAs: null },
  ],
  toBody: (v, c) => {
    const body = { ...v };
    if (c?.hasAccount) delete body.email;
    return c ? Object.fromEntries(Object.entries(body).filter(([k, val]) => String(val ?? '') !== String(c[k] ?? ''))) : body;
  },
  toggle: { isActive: (c) => c.isActive, send: (ctx, c, isActive) => ctx.api.put(`/customers/${c.id}`, { isActive }) },
});
