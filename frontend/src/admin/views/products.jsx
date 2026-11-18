import React, { useId, useRef, useState } from 'react';
import { useAdmin } from '../context.jsx';
import {
  Card, PageHead, Table, Badge, Button, toast, KV, Pagination, SearchInput, Select, confirmDialog, ToneBadge, AlertBox, useAsync, Async,
} from '../../components/ui.jsx';
import { openModal, ModalBody } from '../../components/modal.jsx';
import { formModal } from '../../components/form.jsx';
import { money, number, date, errorMessage } from '../../core/format.js';
import { Cell } from './_shared.jsx';
import { ProductImage, hasProductImage } from '../../components/ProductImage.jsx';

export function Products() {
  const ctx = useAdmin();
  const catalogs = useAsync(async () => {
    const [cats, labs] = await Promise.all([ctx.api.get('/categories', { pageSize: 100 }), ctx.api.get('/laboratories', { pageSize: 100 })]);
    return { categories: cats.data, laboratories: labs.data };
  }, []);
  return <Async state={catalogs}>{(c) => <ProductsList {...c} />}</Async>;
}

function ProductsList({ categories, laboratories }) {
  const ctx = useAdmin();
  const [f, setF] = useState({ q: '', categoryId: '', laboratoryId: '', status: 'ACTIVE', page: 1 });
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const state = useAsync(() => ctx.api.get('/products', { ...f, pageSize: 20 }), [f]);
  const reloadRef = useRef(state.reload);
  reloadRef.current = state.reload;
  const reload = () => reloadRef.current();

  async function edit(p) {
    const canPrices = !p || ctx.can('products.prices');
    const fields = [
      { name: 'name', label: 'Nombre', required: true, full: true, value: p?.name },
      { name: 'sku', label: 'SKU', required: true, value: p?.sku, hint: 'Letras, números, punto y guion' },
      { name: 'barcode', label: 'Código de barras', value: p?.barcode, emptyAs: null },
      { name: 'categoryId', label: 'Categoría', type: 'select', required: true, value: p?.category.id, placeholder: 'Seleccione…', options: categories.filter((c) => c.isActive || c.id === p?.category.id).map((c) => ({ value: c.id, label: c.name })) },
      { name: 'laboratoryId', label: 'Laboratorio', type: 'select', value: p?.laboratory?.id, placeholder: 'Sin laboratorio', emptyAs: null, options: laboratories.filter((l) => l.isActive || l.id === p?.laboratory?.id).map((l) => ({ value: l.id, label: l.name })) },
      { name: 'activeIngredient', label: 'Principio activo', value: p?.activeIngredient, emptyAs: null },
      { name: 'concentration', label: 'Concentración', value: p?.concentration, emptyAs: null },
      { name: 'dosageForm', label: 'Forma farmacéutica', value: p?.dosageForm, emptyAs: null },
      { name: 'presentation', label: 'Presentación', value: p?.presentation, emptyAs: null },
      { name: 'sanitaryRegistration', label: 'Registro sanitario', value: p?.sanitaryRegistration, emptyAs: null },
      { name: 'unit', label: 'Unidad', value: p?.unit ?? 'unidad' },
      { name: 'purchasePrice', label: 'Precio de compra referencial', type: 'money', value: p?.purchasePrice ?? '0.00', disabled: !canPrices },
      { name: 'salePrice', label: 'Precio de venta general', type: 'money', required: true, value: p?.salePrice, disabled: !canPrices },
      { name: 'requiresPrescription', label: 'Requiere receta médica', type: 'checkbox', value: p?.requiresPrescription },
      { name: 'description', label: 'Descripción', type: 'textarea', full: true, value: p?.description, emptyAs: null },
      ...(p ? [] : [{ name: 'minimumStock', label: 'Stock mínimo inicial (todas las sucursales)', type: 'number', min: 0, hint: 'Vacío = valor por defecto' }]),
    ];
    const res = await formModal({
      title: p ? `Editar ${p.name}` : 'Nuevo producto', size: 'lg', fields,
      intro: !canPrices ? <AlertBox tone="info">No tiene permiso para modificar precios.</AlertBox> : null,
      onSubmit: async (v) => {
        const body = { ...v, categoryId: Number(v.categoryId), laboratoryId: v.laboratoryId ? Number(v.laboratoryId) : null };
        if (!canPrices) { delete body.salePrice; delete body.purchasePrice; }
        if (body.minimumStock === undefined) delete body.minimumStock;
        if (p) {
          // Solo se envían los campos que cambiaron.
          const changes = {};
          const map = { name: p.name, sku: p.sku, barcode: p.barcode, categoryId: p.category.id, laboratoryId: p.laboratory?.id ?? null, activeIngredient: p.activeIngredient, concentration: p.concentration,
            dosageForm: p.dosageForm, presentation: p.presentation, sanitaryRegistration: p.sanitaryRegistration, unit: p.unit, purchasePrice: p.purchasePrice, salePrice: p.salePrice,
            requiresPrescription: p.requiresPrescription, description: p.description };
          for (const [k, val] of Object.entries(body)) if (String(val ?? '') !== String(map[k] ?? '')) changes[k] = val;
          if (!Object.keys(changes).length) return true;
          return ctx.api.put(`/products/${p.id}`, changes);
        }
        return ctx.api.post('/products', body);
      },
    });
    if (res) { toast(p ? 'Producto actualizado' : 'Producto creado', 'success'); reload(); if (res.data) detail(res.data.id); }
  }

  function detail(id) {
    openModal({ title: 'Producto', size: 'xl', content: (pr) => <ProductDetail id={id} onEdit={edit} onChanged={reload} {...pr} /> });
  }

  return (
    <>
      <PageHead
        title="Productos" sub="Catálogo único compartido por el panel y la tienda virtual."
        actions={ctx.can('products.create') ? <Button variant="primary" icon="plus" onClick={() => edit()}>Nuevo producto</Button> : null}
      />
      <div className="card card-body toolbar">
        <SearchInput placeholder="Nombre, principio activo, SKU o código de barras…" onSearch={(q) => set({ q })} />
        <Select options={categories.map((c) => ({ value: c.id, label: c.name }))} value={f.categoryId} onChange={(v) => set({ categoryId: v })} label="Categoría" placeholder="Todas" />
        <Select options={laboratories.map((l) => ({ value: l.id, label: l.name }))} value={f.laboratoryId} onChange={(v) => set({ laboratoryId: v })} label="Laboratorio" placeholder="Todos" />
        <Select options={[{ value: 'ACTIVE', label: 'Activos' }, { value: 'INACTIVE', label: 'Inactivos' }, { value: 'DISCONTINUED', label: 'Descontinuados' }]} value={f.status} onChange={(v) => set({ status: v })} label="Estado" placeholder="Todos" />
      </div>
      <div>
        <Async state={state}>
          {(r) => (
            <Card tight>
              <div>
                <Table
                  columns={[
                    { label: '', render: (p) => <span className={`pp-pthumb${hasProductImage(p) ? ' has-photo' : ''}`}><ProductImage product={p} className="pp-pthumb-img" /></span> },
                    { label: 'Producto', render: (p) => <Cell title={p.name} sub={[p.sku, p.barcode, p.presentation].filter(Boolean).join(' · ')} /> },
                    { label: 'Categoría', render: (p) => p.category.name },
                    { label: 'Laboratorio', render: (p) => p.laboratory?.name },
                    { label: 'Receta', render: (p) => (p.requiresPrescription ? <ToneBadge tone="info">Sí</ToneBadge> : 'No') },
                    { label: 'Precio', num: true, render: (p) => money(p.salePrice) },
                    { label: 'Estado', render: (p) => <Badge kind="product" code={p.status} /> },
                  ]}
                  rows={r.data} rowKey={(p) => p.id} empty="Sin productos con esos filtros" onRowClick={(p) => detail(p.id)}
                />
                <Pagination p={r.pagination} onChange={(page) => setF((x) => ({ ...x, page }))} />
              </div>
            </Card>
          )}
        </Async>
      </div>
    </>
  );
}

function ProductDetail({ id, onEdit, onChanged, close, setTitle }) {
  const ctx = useAdmin();
  const fileId = `img-${useId().replace(/:/g, '')}`;
  const state = useAsync(async () => {
    const { data } = await ctx.api.get(`/products/${id}`);
    setTitle(data.name);
    return data;
  }, [id]);

  async function editBranch(p, b) {
    const fields = [];
    if (ctx.can('products.prices')) fields.push({ name: 'salePrice', label: 'Precio en la sucursal', type: 'money', value: b.salePrice ?? '', hint: 'Vacío = usar el precio general', emptyAs: null });
    if (ctx.can('inventory.minimum_stock')) {
      fields.push({ name: 'minimumStock', label: 'Stock mínimo', type: 'number', min: 0, value: b.minimumStock, required: true },
        { name: 'maximumStock', label: 'Stock máximo', type: 'number', min: 0, value: b.maximumStock ?? '', emptyAs: null });
    }
    if (ctx.can('products.update')) {
      fields.push({ name: 'shelfLocation', label: 'Ubicación (anaquel)', value: b.shelfLocation ?? '', emptyAs: null },
        { name: 'isAvailable', label: 'Habilitado para la venta en esta sucursal', type: 'checkbox', value: b.isAvailable });
    }
    const ok = await formModal({ title: `${p.name} — ${b.branchName}`, fields, onSubmit: (v) => ctx.api.put(`/products/${p.id}/branches/${b.branchId}`, v) });
    if (ok) { toast('Configuración guardada', 'success'); state.reload(); }
  }

  return (
    <ModalBody>
      <div className="stack">
        <Async state={state}>
          {(p) => {
            const next = p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
            return (
              <>
                <div className="row between">
                  <div className="row"><Badge kind="product" code={p.status} />{p.requiresPrescription ? <ToneBadge tone="info">Requiere receta</ToneBadge> : null}</div>
                  <div className="row">
                    {ctx.can('products.update', 'products.prices') ? <Button icon="edit" onClick={() => { close(); onEdit(p); }}>Editar</Button> : null}
                    {ctx.can('products.update') ? (
                      <>
                        <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" id={fileId} onChange={async (e) => {
                          const file = e.target.files[0];
                          e.target.value = '';
                          if (!file) return;
                          try { await ctx.api.upload(`/products/${p.id}/image`, file); toast('Imagen actualizada', 'success'); state.reload(); onChanged(); } catch (err) { toast(errorMessage(err), 'error'); }
                        }} />
                        <label className="btn" htmlFor={fileId} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById(fileId)?.click(); } }}>Cambiar imagen</label>
                      </>
                    ) : null}
                    {ctx.can('products.deactivate') ? (
                      <Button variant={next === 'ACTIVE' ? 'success' : 'danger'} onClick={async () => {
                        const ok = await confirmDialog({ title: `${next === 'ACTIVE' ? 'Activar' : 'Desactivar'} producto`, message: next === 'ACTIVE' ? 'Volverá a venderse en el POS y la tienda.' : 'Dejará de venderse en el POS y la tienda. El historial se conserva.', danger: next !== 'ACTIVE' });
                        if (!ok) return;
                        try { await ctx.api.patch(`/products/${p.id}/status`, { status: next }); toast('Estado actualizado', 'success'); state.reload(); onChanged(); } catch (err) { toast(errorMessage(err), 'error'); }
                      }}>{next === 'ACTIVE' ? 'Activar' : 'Desactivar'}</Button>
                    ) : null}
                  </div>
                </div>
                <div className="grid grid-2">
                  <Card title="Datos">
                    <div className="row" style={{ alignItems: 'flex-start' }}>
                      <span className={`pp-pthumb lg${hasProductImage(p) ? ' has-photo' : ''}`}><ProductImage product={p} alt={p.name} loading="eager" className="pp-pthumb-img" /></span>
                      <div className="grow">
                        <KV pairs={[['SKU', p.sku], ['Código de barras', p.barcode], ['Categoría', p.category.name], ['Laboratorio', p.laboratory?.name], ['Principio activo', p.activeIngredient],
                          ['Concentración', p.concentration], ['Forma', p.dosageForm], ['Presentación', p.presentation], ['Registro sanitario', p.sanitaryRegistration],
                          ['Precio general', money(p.salePrice)], ['Compra referencial', money(p.purchasePrice)]]} />
                      </div>
                    </div>
                  </Card>
                  <Card title="Inventario por sucursal" tight>
                    <Table
                      columns={[
                        { label: 'Sucursal', render: (s) => s.branchName },
                        { label: 'Disponible', num: true, render: (s) => number(s.availableStock) },
                        { label: 'Vencido', num: true, render: (s) => number(s.expiredStock) },
                        { label: 'Mín.', num: true, render: (s) => number(s.minimumStock) },
                        { label: 'Estado', render: (s) => <Badge kind="stock" code={s.stockStatus} /> },
                      ]}
                      rows={p.inventory} empty="Sin existencias registradas"
                    />
                  </Card>
                </div>
                <Card title="Configuración por sucursal" tight>
                  <Table
                    columns={[
                      { label: 'Sucursal', render: (b) => b.branchName },
                      { label: 'Precio sucursal', num: true, render: (b) => (b.salePrice ? money(b.salePrice) : <span className="muted">General</span>) },
                      { label: 'Precio efectivo', num: true, render: (b) => money(b.effectiveSalePrice) },
                      { label: 'Mín. / máx.', num: true, render: (b) => `${b.minimumStock} / ${b.maximumStock ?? '—'}` },
                      { label: 'Ubicación', render: (b) => b.shelfLocation },
                      { label: 'Venta', render: (b) => (b.isAvailable ? <ToneBadge tone="success">Habilitado</ToneBadge> : <ToneBadge tone="neutral">No habilitado</ToneBadge>) },
                      { label: '', render: (b) => (ctx.can('products.prices', 'products.update', 'inventory.minimum_stock') ? <Button size="sm" onClick={() => editBranch(p, b)}>Editar</Button> : null) },
                    ]}
                    rows={p.branches}
                  />
                </Card>
                <Card title="Lotes con existencias" tight>
                  <Table
                    columns={[
                      { label: 'Sucursal', render: (b) => b.branch_name },
                      { label: 'Lote', render: (b) => <span className="mono">{b.batch_number}</span> },
                      { label: 'Vence', render: (b) => date(b.expiry_date) },
                      { label: 'Vigencia', render: (b) => <Badge kind="expiry" code={b.expiry_status} /> },
                      { label: 'Stock', num: true, render: (b) => number(b.current_quantity) },
                    ]}
                    rows={p.batches} empty="Sin lotes con stock"
                  />
                </Card>
              </>
            );
          }}
        </Async>
      </div>
    </ModalBody>
  );
}
