import React, { useRef, useState } from 'react';
import { useAdmin } from '../context.jsx';
import {
  Card, PageHead, Table, Badge, Button, toast, Pagination, SearchInput, Select, confirmDialog, ToneBadge, KV, AlertBox, Spinner, ErrorState, useAsync, Async,
} from '../../components/ui.jsx';
import { openModal, ModalBody, ModalFoot } from '../../components/modal.jsx';
import { formModal } from '../../components/form.jsx';
import { dateTime, money, errorMessage } from '../../core/format.js';
import { Cell } from './_shared.jsx';

// ================================================================ trabajadores
/** Casillas de sucursales; el valor se publica en valuesRef.current (lo lee onSubmit del formulario). */
function BranchChecks({ branches, initial, valuesRef }) {
  const [sel, setSel] = useState(() => new Set(initial));
  valuesRef.current = branches.filter((b) => sel.has(b.id)).map((b) => b.id);
  return (
    <div className="stack" style={{ gap: '6px' }}>
      {branches.map((b) => (
        <label className="check" key={b.id}>
          <input type="checkbox" checked={sel.has(b.id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(b.id); else n.delete(b.id); return n; })} />
          {`${b.name} (${b.code})`}
        </label>
      ))}
    </div>
  );
}

export function Users() {
  const ctx = useAdmin();
  const meta = useAsync(async () => {
    const [roles, branches] = await Promise.all([
      ctx.can('roles.manage') ? ctx.api.get('/roles').then((r) => r.data) : Promise.resolve(null),
      ctx.api.get('/branches').then((r) => r.data),
    ]);
    return { staffRoles: roles ? roles.filter((r) => r.code !== 'CUSTOMER' && r.isActive) : null, branchOptions: branches.filter((b) => b.status === 'ACTIVE') };
  }, []);
  return <Async state={meta}>{(m) => <UsersList {...m} />}</Async>;
}

function UsersList({ staffRoles, branchOptions }) {
  const ctx = useAdmin();
  const [f, setF] = useState({ q: '', status: '', page: 1 });
  const canManage = ctx.can('users.manage');
  const state = useAsync(() => ctx.api.get('/users', { ...f, pageSize: 20 }), [f]);
  const reloadRef = useRef(state.reload);
  reloadRef.current = state.reload;

  async function create() {
    const checks = { current: [] };
    const ok = await formModal({
      title: 'Nuevo trabajador', size: 'lg',
      intro: (
        <div className="stack">
          <AlertBox tone="info">La contraseña es temporal: el trabajador deberá cambiarla en su primer ingreso.</AlertBox>
          <div className="field"><span className="label">Sucursales asignadas</span><BranchChecks branches={branchOptions} initial={[ctx.branchId]} valuesRef={checks} /></div>
        </div>
      ),
      fields: [
        { name: 'fullName', label: 'Nombre completo', required: true, full: true },
        { name: 'email', label: 'Correo', type: 'email', required: true },
        { name: 'phone', label: 'Teléfono', emptyAs: null },
        { name: 'roleId', label: 'Rol', type: 'select', required: true, placeholder: 'Seleccione…', options: staffRoles.map((r) => ({ value: r.id, label: r.name })) },
        { name: 'password', label: 'Contraseña temporal', type: 'password', required: true, autocomplete: 'new-password', hint: 'Mín. 10 caracteres, mayúscula, minúscula y número' },
      ],
      onSubmit: (v) => {
        const branchIds = checks.current;
        if (!branchIds.length) throw Object.assign(new Error('Asigne al menos una sucursal'), { status: 400 });
        return ctx.api.post('/users', { ...v, roleId: Number(v.roleId), branchIds });
      },
    });
    if (ok) { toast('Trabajador creado', 'success'); state.reload(); }
  }

  const detail = (id) => openModal({ title: 'Trabajador', size: 'lg', content: (p) => <UserDetail id={id} staffRoles={staffRoles} branchOptions={branchOptions} onChanged={() => reloadRef.current()} {...p} /> });

  return (
    <>
      <PageHead title="Trabajadores" sub="Cuentas del personal, rol, sucursales y estado."
        actions={canManage && staffRoles ? <Button variant="primary" icon="plus" onClick={create}>Nuevo trabajador</Button> : null} />
      <div className="card card-body toolbar">
        <SearchInput placeholder="Nombre o correo…" onSearch={(q) => setF((x) => ({ ...x, q, page: 1 }))} />
        <Select options={[{ value: 'ACTIVE', label: 'Activos' }, { value: 'INACTIVE', label: 'Inactivos' }, { value: 'BLOCKED', label: 'Bloqueados' }]} value={f.status} onChange={(v) => setF((x) => ({ ...x, status: v, page: 1 }))} label="Estado" placeholder="Todos" />
      </div>
      <div>
        <Async state={state}>
          {(r) => (
            <Card tight>
              <div>
                <Table
                  columns={[
                    { label: 'Trabajador', render: (u) => <Cell title={u.fullName} sub={u.email} /> },
                    { label: 'Rol', render: (u) => u.role.name },
                    { label: 'Sucursales', render: (u) => u.branches.map((b) => `${b.code}${b.isDefault ? '*' : ''}`).join(', ') },
                    { label: 'Último ingreso', render: (u) => dateTime(u.lastLoginAt) },
                    { label: 'Estado', render: (u) => (
                      <div className="row" style={{ gap: '4px' }}>
                        <Badge kind="user" code={u.status} />
                        {u.mustChangePassword ? <ToneBadge tone="warning">Clave temporal</ToneBadge> : null}
                        {u.lockedUntil && new Date(u.lockedUntil) > new Date() ? <ToneBadge tone="danger">Bloqueo temporal</ToneBadge> : null}
                      </div>
                    ) },
                  ]}
                  rows={r.data} empty="Sin trabajadores" onRowClick={(u) => detail(u.id)}
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

function UserDetail({ id, staffRoles, branchOptions, onChanged, setTitle }) {
  const ctx = useAdmin();
  const canManage = ctx.can('users.manage');
  const state = useAsync(async () => {
    const { data } = await ctx.api.get(`/users/${id}`);
    setTitle(data.fullName);
    return data;
  }, [id]);

  async function act(fn) {
    try { await fn(); toast('Actualizado', 'success'); state.reload(); onChanged(); } catch (err) { toast(errorMessage(err), 'error'); }
  }
  async function setStatus(u, status) {
    const ok = await confirmDialog({ title: status === 'BLOCKED' ? 'Bloquear trabajador' : 'Activar trabajador',
      message: status === 'BLOCKED' ? 'Se cerrarán todas sus sesiones de inmediato.' : 'Podrá volver a ingresar.', danger: status === 'BLOCKED' });
    if (ok) await act(() => ctx.api.put(`/users/${u.id}`, { status }));
  }
  async function reset(u) {
    const ok = await formModal({ title: `Restablecer contraseña de ${u.fullName}`, intro: <AlertBox tone="warning">Se cerrarán sus sesiones y deberá cambiarla al ingresar.</AlertBox>,
      fields: [{ name: 'password', label: 'Contraseña temporal', type: 'password', required: true, full: true, autocomplete: 'new-password' }],
      onSubmit: (v) => ctx.api.post(`/users/${u.id}/reset-password`, v) });
    if (ok) { toast('Contraseña restablecida', 'success'); state.reload(); }
  }
  async function edit(u) {
    const checks = { current: [] };
    const isMe = u.id === ctx.user.id;
    const fields = [
      { name: 'fullName', label: 'Nombre completo', required: true, full: true, value: u.fullName },
      { name: 'phone', label: 'Teléfono', value: u.phone, emptyAs: null },
    ];
    if (staffRoles && !isMe) fields.push({ name: 'roleId', label: 'Rol', type: 'select', value: u.role.id, options: staffRoles.map((r) => ({ value: r.id, label: r.name })) });
    const ok = await formModal({
      title: `Editar ${u.fullName}`, size: 'lg', fields,
      intro: <div className="field"><span className="label">Sucursales asignadas</span><BranchChecks branches={branchOptions} initial={u.branches.map((b) => b.id)} valuesRef={checks} /></div>,
      onSubmit: (v) => {
        const branchIds = checks.current;
        if (!branchIds.length) throw Object.assign(new Error('Asigne al menos una sucursal'), { status: 400 });
        const body = { fullName: v.fullName, phone: v.phone, branchIds };
        if (v.roleId && Number(v.roleId) !== u.role.id) body.roleId = Number(v.roleId);
        return ctx.api.put(`/users/${u.id}`, body);
      },
    });
    if (ok) { toast('Trabajador actualizado', 'success'); state.reload(); onChanged(); }
  }
  function overrides(u) {
    openModal({ title: `Permisos individuales de ${u.fullName}`, size: 'lg', content: (p) => <UserOverrides u={u} onSaved={() => state.reload()} {...p} /> });
  }

  return (
    <ModalBody>
      <div className="stack">
        <Async state={state}>
          {(u) => {
            const isMe = u.id === ctx.user.id;
            return (
              <>
                <div className="row between">
                  <div className="row"><Badge kind="user" code={u.status} />{u.role.name}</div>
                  <div className="row">
                    {canManage ? (
                      <>
                        <Button icon="edit" onClick={() => edit(u)}>Editar</Button>
                        {!isMe ? (u.status === 'ACTIVE'
                          ? <Button variant="danger" onClick={() => setStatus(u, 'BLOCKED')}>Bloquear</Button>
                          : <Button variant="success" onClick={() => setStatus(u, 'ACTIVE')}>Activar</Button>) : null}
                        <Button onClick={() => reset(u)}>Restablecer contraseña</Button>
                        {u.lockedUntil ? <Button onClick={() => act(() => ctx.api.post(`/users/${u.id}/unlock`))}>Quitar bloqueo temporal</Button> : null}
                      </>
                    ) : null}
                    {ctx.can('roles.manage') && !isMe ? <Button icon="shield" onClick={() => overrides(u)}>Permisos individuales</Button> : null}
                  </div>
                </div>
                {isMe ? <AlertBox tone="info">Es su propia cuenta: no puede cambiar su rol, estado ni permisos.</AlertBox> : null}
                <KV pairs={[['Correo', u.email], ['Teléfono', u.phone], ['Sucursales', u.branches.map((b) => `${b.code}${b.isDefault ? ' (predeterminada)' : ''}`).join(', ')],
                  ['Último ingreso', dateTime(u.lastLoginAt)], ['Creado', dateTime(u.createdAt)], ['Contraseña temporal', u.mustChangePassword ? 'Sí' : 'No']]} />
                {u.permissionOverrides.length ? (
                  <Card title="Permisos individuales" tight>
                    <Table
                      columns={[
                        { label: 'Permiso', render: (p) => <span className="mono">{p.code}</span> },
                        { label: 'Efecto', render: (p) => <ToneBadge tone={p.effect === 'GRANT' ? 'success' : 'danger'}>{p.effect === 'GRANT' ? 'Concedido' : 'Denegado'}</ToneBadge> },
                        { label: 'Motivo', render: (p) => p.reason },
                      ]}
                      rows={u.permissionOverrides}
                    />
                  </Card>
                ) : null}
              </>
            );
          }}
        </Async>
      </div>
    </ModalBody>
  );
}

function UserOverrides({ u, onSaved, close }) {
  const ctx = useAdmin();
  const perms = useAsync(async () => (await ctx.api.get('/roles/permissions')).data.filter((p) => !p.code.startsWith('store.')), []);
  const [sel, setSel] = useState(() => Object.fromEntries(u.permissionOverrides.map((o) => [o.code, o.effect])));
  if (perms.error) return <ModalBody><ErrorState error={perms.error} onRetry={perms.reload} /></ModalBody>;
  if (!perms.data) return <ModalBody><Spinner /></ModalBody>;
  return (
    <>
      <ModalBody>
        <div className="stack">
          <AlertBox tone="info">Los permisos individuales se suman (conceder) o restan (denegar) a los del rol.</AlertBox>
          <Table
            columns={[
              { label: 'Módulo', render: (p) => p.module },
              { label: 'Permiso', render: (p) => <div><div>{p.name}</div><div className="cell-sub mono">{p.code}</div></div> },
              { label: 'Efecto', render: (p) => (
                <select className="input" style={{ width: 'auto' }} value={sel[p.code] || ''} onChange={(e) => setSel((s) => ({ ...s, [p.code]: e.target.value }))}>
                  {[['', 'Según rol'], ['GRANT', 'Conceder'], ['DENY', 'Denegar']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              ) },
            ]}
            rows={perms.data}
          />
        </div>
      </ModalBody>
      <ModalFoot>
        <Button variant="primary" onClick={async () => {
          try {
            await ctx.api.put(`/users/${u.id}/permissions`, { overrides: perms.data.filter((p) => sel[p.code]).map((p) => ({ code: p.code, effect: sel[p.code] })) });
            toast('Permisos actualizados', 'success'); close(); onSaved();
          } catch (err) { toast(errorMessage(err), 'error'); }
        }}>Guardar permisos</Button>
      </ModalFoot>
    </>
  );
}

// ===================================================================== roles
export function Roles() {
  const ctx = useAdmin();
  const state = useAsync(async () => {
    const [rolesR, permsR] = await Promise.all([ctx.api.get('/roles'), ctx.api.get('/roles/permissions')]);
    return { roles: rolesR.data, perms: permsR.data };
  }, []);
  return (
    <>
      <PageHead title="Roles y permisos" sub="ADMIN y CUSTOMER son roles protegidos del sistema."
        actions={(
          <Button variant="primary" icon="plus" onClick={async () => {
            const ok = await formModal({ title: 'Nuevo rol', fields: [
              { name: 'code', label: 'Código', required: true, hint: 'Mayúsculas, números y _ (ej.: CAJERO)' },
              { name: 'name', label: 'Nombre', required: true },
              { name: 'description', label: 'Descripción', full: true, emptyAs: null },
            ], onSubmit: (v) => ctx.api.post('/roles', { ...v, code: v.code.toUpperCase() }) });
            if (ok) { toast('Rol creado', 'success'); state.reload(); }
          }}>Nuevo rol</Button>
        )} />
      <div className="stack">
        <Async state={state}>{({ roles, perms }) => roles.map((r) => <RoleCard key={r.id} r={r} perms={perms} />)}</Async>
      </div>
    </>
  );
}

function RoleCard({ r, perms }) {
  const ctx = useAdmin();
  const editable = !['ADMIN', 'CUSTOMER'].includes(r.code);
  const [checked, setChecked] = useState(() => new Set(r.permissions));
  const groups = {};
  for (const p of perms) {
    if (p.code.startsWith('store.') && r.code !== 'CUSTOMER') continue;
    (groups[p.module] ||= []).push(p);
  }
  const visibleCodes = Object.values(groups).flat().map((p) => p.code);
  return (
    <Card
      title={<div><h2>{`${r.name} `}</h2><span className="small muted">{`${r.code} · ${r.usersCount} usuario(s) · ${r.permissions.length} permisos`}</span></div>}
      actions={editable ? (
        <Button variant="primary" size="sm" onClick={async () => {
          try {
            const r2 = await ctx.api.put(`/roles/${r.id}/permissions`, { permissions: visibleCodes.filter((c) => checked.has(c)) });
            toast(`Permisos de ${r.name} guardados (+${r2.data.added} / −${r2.data.removed})`, 'success');
          } catch (err) { toast(errorMessage(err), 'error'); }
        }}>Guardar permisos</Button>
      ) : null}
    >
      <div className="stack">
        {!editable ? <AlertBox tone="info">Rol protegido: sus permisos no se modifican desde el panel.</AlertBox> : null}
        <div className="grid grid-3">
          {Object.entries(groups).map(([mod, ps]) => (
            <fieldset key={mod} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px' }}>
              <legend className="label">{mod}</legend>
              {ps.map((p) => (
                <label key={p.code} className="check small" title={p.code}>
                  <input type="checkbox" checked={checked.has(p.code)} disabled={!editable}
                    onChange={(e) => setChecked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.code); else n.delete(p.code); return n; })} />
                  {p.name}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ================================================================= sucursales
export function Branches() {
  const ctx = useAdmin();
  const state = useAsync(async () => {
    const r = await ctx.api.get('/branches');
    const regs = await ctx.api.get('/cash/registers').catch(() => ({ data: [] }));
    return { branches: r.data, regs: regs.data };
  }, []);
  const fields = (b) => [
    ...(b ? [] : [{ name: 'code', label: 'Código', required: true, hint: '2 a 20 caracteres A-Z/0-9 (ej.: SP02)' }]),
    { name: 'name', label: 'Nombre', required: true, value: b?.name },
    { name: 'addressLine', label: 'Dirección', full: true, value: b?.addressLine, emptyAs: null },
    { name: 'district', label: 'Distrito', value: b?.district, emptyAs: null },
    { name: 'province', label: 'Provincia', value: b?.province, emptyAs: null, hint: 'Se usa para la cobertura de delivery si no hay lista de distritos' },
    { name: 'department', label: 'Departamento', value: b?.department, emptyAs: null },
    { name: 'phone', label: 'Teléfono', value: b?.phone, emptyAs: null },
    { name: 'email', label: 'Correo', type: 'email', value: b?.email, emptyAs: null },
    { name: 'openedOn', label: 'Fecha de apertura', type: 'date', value: b?.openedOn, emptyAs: null },
  ];
  async function edit(b) {
    const ok = await formModal({ title: b ? `Editar ${b.name}` : 'Nueva sucursal', size: 'lg', fields: fields(b),
      onSubmit: (v) => (b ? ctx.api.put(`/branches/${b.id}`, v) : ctx.api.post('/branches', { ...v, code: v.code.toUpperCase() })) });
    if (ok) { toast('Sucursal guardada', 'success'); state.reload(); }
  }
  return (
    <>
      <PageHead title="Sucursales" sub="Locales de la botica y sus cajas." actions={<Button variant="primary" icon="plus" onClick={() => edit()}>Nueva sucursal</Button>} />
      <div>
        <Async state={state}>
          {({ branches, regs }) => (
            <Card tight>
              <Table
                columns={[
                  { label: 'Sucursal', render: (b) => <Cell title={`${b.name}${b.isMain ? ' (principal)' : ''}`} sub={b.code} /> },
                  { label: 'Ubicación', render: (b) => [b.addressLine, b.district, b.province].filter(Boolean).join(', ') || <span className="muted">Sin dirección registrada</span> },
                  { label: 'Trabajadores', num: true, render: (b) => b.users },
                  { label: 'Cajas', render: (b) => regs.filter((x) => x.branch.id === b.id).map((x) => x.code).join(', ') || '—' },
                  { label: 'Estado', render: (b) => <ToneBadge tone={b.status === 'ACTIVE' ? 'success' : 'neutral'}>{b.status === 'ACTIVE' ? 'Activa' : 'Inactiva'}</ToneBadge> },
                  { label: '', render: (b) => (
                    <div className="actions">
                      <Button size="sm" onClick={() => edit(b)}>Editar</Button>
                      <Button size="sm" onClick={async () => {
                        const ok = await formModal({ title: `Nueva caja en ${b.name}`, fields: [{ name: 'code', label: 'Código', required: true, value: 'CAJA02' }, { name: 'name', label: 'Nombre', required: true, value: 'Caja 2' }],
                          onSubmit: (v) => ctx.api.post(`/branches/${b.id}/registers`, { ...v, code: v.code.toUpperCase() }) });
                        if (ok) { toast('Caja creada', 'success'); state.reload(); }
                      }}>Nueva caja</Button>
                      {!b.isMain ? (
                        <Button size="sm" variant={b.status === 'ACTIVE' ? 'danger' : 'success'} onClick={async () => {
                          const ok = await confirmDialog({ title: 'Cambiar estado', message: `¿${b.status === 'ACTIVE' ? 'Desactivar' : 'Activar'} ${b.name}?`, danger: b.status === 'ACTIVE' });
                          if (!ok) return;
                          try { await ctx.api.put(`/branches/${b.id}`, { status: b.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }); toast('Estado actualizado', 'success'); state.reload(); } catch (err) { toast(errorMessage(err), 'error'); }
                        }}>{b.status === 'ACTIVE' ? 'Desactivar' : 'Activar'}</Button>
                      ) : null}
                    </div>
                  ) },
                ]}
                rows={branches}
              />
            </Card>
          )}
        </Async>
      </div>
    </>
  );
}

// ============================================================= configuración
const GROUPS = { business: 'Negocio', app: 'Aplicación', orders: 'Pedidos y delivery', sales: 'Ventas', inventory: 'Inventario', security: 'Seguridad', tickets: 'Tickets', payments: 'Pagos' };

export function Settings() {
  const ctx = useAdmin();
  const state = useAsync(async () => (await ctx.api.get('/settings')).data, []);

  async function editSetting(s) {
    const field = s.type === 'BOOLEAN'
      ? { name: 'value', label: s.description || s.key, type: 'select', value: s.value, options: [{ value: 'true', label: 'Sí (true)' }, { value: 'false', label: 'No (false)' }], full: true }
      : { name: 'value', label: s.description || s.key, type: s.type === 'DECIMAL' ? 'money' : s.type === 'INTEGER' ? 'number' : 'text', value: s.value, full: true, emptyAs: '' };
    const ok = await formModal({ title: `Editar ${s.key}`, fields: [field], onSubmit: (v) => ctx.api.put(`/settings/${s.key}`, { value: String(v.value ?? '') }) });
    if (ok) { toast('Parámetro actualizado', 'success'); state.reload(); }
  }

  async function editDistricts(current) {
    const list = current ? JSON.parse(current.value) : [];
    const ok = await formModal({
      title: 'Distritos con cobertura de delivery',
      intro: <AlertBox tone="info">Un distrito por línea. Los pedidos con delivery solo se aceptan si la dirección del cliente está en esta lista.</AlertBox>,
      fields: [{ name: 'districts', label: 'Distritos', type: 'textarea', full: true, value: list.join('\n'), emptyAs: '' }],
      onSubmit: (v) => ctx.api.put('/settings/orders.delivery_districts', { value: String(v.districts || '').split('\n').map((x) => x.trim()).filter(Boolean) }),
    });
    if (ok) { toast('Cobertura actualizada', 'success'); state.reload(); }
  }

  return (
    <>
      <PageHead title="Configuración" sub="Valores actuales de los parámetros que utiliza el sistema." />
      <div className="stack">
        <Async state={state}>
          {(data) => {
            const delivery = data.settings.find((s) => s.key === 'orders.delivery_districts');
            const fee = data.settings.find((s) => s.key === 'orders.default_delivery_fee');
            const byGroup = {};
            for (const s of data.settings) (byGroup[s.key.split('.')[0]] ||= []).push(s);
            return (
              <>
                <Card title="Delivery y cobertura">
                  <div className="stack">
                    <KV pairs={[['Costo de envío actual', fee ? money(fee.value) : 'No configurado'],
                      ['Distritos con cobertura', delivery ? (JSON.parse(delivery.value).join(', ') || 'Lista vacía (ningún distrito)')
                        : <span><ToneBadge tone="warning">No configurado</ToneBadge> — se exige la misma provincia que la sucursal (si la sucursal la tiene registrada; si no, se acepta cualquier dirección).</span>]]} />
                    <div className="row"><Button onClick={() => editDistricts(delivery)}>{delivery ? 'Editar distritos' : 'Configurar distritos'}</Button></div>
                  </div>
                </Card>
                {Object.entries(byGroup).map(([g, rows]) => (
                  <Card key={g} title={GROUPS[g] || g} tight>
                    <Table
                      columns={[
                        { label: 'Parámetro', render: (s) => <div><div className="cell-title">{s.description || s.key}</div><div className="cell-sub mono">{s.key}</div></div> },
                        { label: 'Valor actual', render: (s) => (s.value === '' ? <span className="muted">(vacío)</span> : <span className="mono">{s.value}</span>) },
                        { label: 'Tipo', render: (s) => s.type },
                        { label: '', render: (s) => (s.editable ? <Button size="sm" onClick={() => editSetting(s)}>Editar</Button> : <ToneBadge tone="neutral">Protegido</ToneBadge>) },
                      ]}
                      rows={rows}
                    />
                  </Card>
                ))}
              </>
            );
          }}
        </Async>
      </div>
    </>
  );
}
