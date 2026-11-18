<div align="center">

<img src="frontend/public/img/pharma-plus-logo-claro.png" alt="Pharma Plus" width="320">

# Pharma Plus

**Sistema web integral para boticas y farmacias: tienda virtual para clientes y panel administrativo para la gestión de inventario, ventas, caja y pedidos.**

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![MariaDB](https://img.shields.io/badge/MariaDB-10.11-003545?logo=mariadb&logoColor=white)
![Pruebas](https://img.shields.io/badge/pruebas-Node%20Test%20Runner%20%7C%20Supertest%20%7C%20Puppeteer-informational)

</div>

![Tienda virtual de Pharma Plus](evidencias/tienda/store-desktop-1440-claro.png)

---

## Contenido

1. [Presentación](#1-presentación)
2. [Problema que resuelve](#2-problema-que-resuelve)
3. [Objetivos y funcionalidades principales](#3-objetivos-y-funcionalidades-principales)
4. [Tecnologías](#4-tecnologías)
5. [Arquitectura](#5-arquitectura)
6. [Organización del proyecto](#6-organización-del-proyecto)
7. [Panel administrativo](#7-panel-administrativo)
8. [Tienda virtual](#8-tienda-virtual)
9. [Capturas del sistema](#9-capturas-del-sistema)
10. [Instalación](#10-instalación)
11. [Base de datos MariaDB](#11-base-de-datos-mariadb)
12. [Ejecución](#12-ejecución)
13. [Configuración inicial (primer administrador)](#13-configuración-inicial-primer-administrador)
14. [Pruebas](#14-pruebas)
15. [Seguridad y despliegue](#15-seguridad-y-despliegue)
16. [Estado del proyecto](#16-estado-del-proyecto)

---

## 1. Presentación

**Pharma Plus** es una aplicación web Full Stack para la operación diaria de una botica con una o varias sucursales. Reúne en un solo sistema:

- una **tienda virtual** donde los clientes consultan el catálogo, compran y siguen sus pedidos, y
- un **panel administrativo** donde el personal gestiona productos, lotes y vencimientos, vende en el punto de venta (POS), controla la caja, atiende pedidos online y consulta reportes.

Toda la información se guarda en **MariaDB**: el navegador nunca calcula precios ni totales, y cada operación (venta, entrada de mercadería, devolución, transferencia, pedido) se registra en una transacción con su movimiento de inventario y su auditoría.

| Portal | URL local | Usuarios |
|---|---|---|
| Tienda virtual | `http://localhost:3000/` | Clientes (rol `CUSTOMER`) |
| Acceso único | `http://localhost:3000/acceso` | Personal y clientes |
| Panel administrativo | `http://localhost:3000/admin/` | Personal (`ADMIN`, `STAFF` y roles creados) |
| Estado de la API | `http://localhost:3000/api/health` | Monitoreo |

## 2. Problema que resuelve

Muchas boticas pequeñas y medianas controlan su stock en hojas de cálculo o en sistemas de caja que no conocen los **lotes ni las fechas de vencimiento**. Eso provoca:

- venta de productos vencidos o pérdidas por vencimientos no detectados a tiempo;
- diferencias entre el stock registrado y el real, y descuadres de caja sin trazabilidad;
- ausencia de un canal de venta online conectado al inventario real;
- poca información para decidir compras (más vendidos, stock bajo, márgenes).

Pharma Plus centraliza esas operaciones y aplica las reglas del negocio farmacéutico directamente en el servidor y en la base de datos.

## 3. Objetivos y funcionalidades principales

- **Inventario por lotes con FEFO** (*First Expired, First Out*): cada venta descuenta primero los lotes que vencen antes; los lotes vencidos no se pueden vender.
- **Kardex completo**: el stock solo cambia mediante movimientos (`inventory_movements`); nunca se edita directamente.
- **Alertas automáticas** de stock bajo, sin stock y próximos vencimientos.
- **POS con caja**: apertura, ventas con pagos simples o mixtos, vuelto, ticket interno, anulación y cierre con arqueo.
- **Tienda virtual** conectada al stock real, con carrito, checkout (recojo o delivery), recetas y seguimiento en tiempo real.
- **Multisucursal**: precios, stock y permisos por sucursal; transferencias entre sucursales con recepción parcial.
- **Roles y permisos granulares**, auditoría de cada operación y sesiones seguras.
- **Reportes**: ventas, productos más vendidos, métodos de pago, valorización de inventario, devoluciones, pedidos y caja.

## 4. Tecnologías

| Capa | Tecnologías |
|---|---|
| Frontend | React 18, React Router 6, Vite 6, CSS propio (tema claro/oscuro, responsive) |
| Backend | Node.js 20+, Express 5, Zod (validación), Socket.IO (tiempo real), Multer (imágenes), Pino (logs) |
| Seguridad | bcryptjs, JWT en cookie HttpOnly, CSRF firmado, Helmet, express-rate-limit |
| Base de datos | MariaDB 10.11 (XAMPP), `mysql2/promise`, triggers, vistas y procedimientos almacenados |
| Pruebas | Node Test Runner, Supertest, Puppeteer (Chrome real) |

## 5. Arquitectura

```
┌──────────────────────────┐        HTTP/JSON + cookies         ┌─────────────────────────────────────────────┐
│  React (Vite)            │  ───────────────────────────────▶  │  Express 5                                  │
│  · Tienda virtual        │      /api/*  ·  /socket.io         │  routes → middlewares (auth, permisos,      │
│  · Panel administrativo  │  ◀───────────────────────────────  │  CSRF, validación Zod) → controllers        │
│  core/api-client.js      │                                    │  → services (reglas de negocio)             │
└──────────────────────────┘                                    │  → repositories (SQL parametrizado)         │
                                                                └──────────────────────┬──────────────────────┘
                                                                                       │ mysql2 (pool)
                                                                ┌──────────────────────▼──────────────────────┐
                                                                │  MariaDB `pharma_plus`                       │
                                                                │  43 tablas · vistas · triggers · sp_*        │
                                                                │  (FEFO, stock no negativo, auditoría)        │
                                                                └─────────────────────────────────────────────┘
```

- **Controllers** solo traducen HTTP; **services** contienen las reglas (transacciones, FEFO, pagos, idempotencia); **repositories** son el único lugar con SQL.
- Express sirve también el frontend compilado (`frontend/dist`) en el mismo puerto, por lo que no se necesita CORS.
- Las operaciones críticas usan `withTransaction()`, que fija el contexto de auditoría en la conexión y reintenta ante bloqueos.
- **Socket.IO** notifica ventas, pedidos, inventario y alertas solo después del `COMMIT`.

La referencia completa de rutas, permisos y reglas por módulo está en [`docs/REFERENCIA_TECNICA.md`](docs/REFERENCIA_TECNICA.md).

## 6. Organización del proyecto

```
sistema_farmacia/
├── database/                    # Esquema MariaDB, migraciones, diccionario de datos y diagrama ER
│   ├── pharma_plus_mariadb_10_11.sql   # Esquema principal (tablas, vistas, triggers, procedimientos, datos base)
│   ├── migrations/              # Cambios posteriores (001_user_sessions.sql)
│   └── setup/                   # Creación del usuario restringido pharma_app
├── docs/                        # Referencia técnica y documento de exposición
├── evidencias/                  # Capturas reales del sistema (generadas por las pruebas E2E)
├── frontend/                    # React + Vite
│   ├── public/img/              # Logos
│   └── src/
│       ├── access/              # Acceso único y registro de clientes
│       ├── admin/               # Panel: layout, navegación por permisos y vistas por módulo
│       ├── store/               # Tienda: inicio, catálogo, producto, carrito, checkout, pedidos, cuenta
│       ├── components/          # UI reutilizable (tablas, formularios, modales, gráficos, imágenes)
│       ├── core/                # Cliente API (cookies + CSRF), formato y permisos
│       └── styles/              # Estilos globales y de la tienda
├── scripts/                     # Utilidades: crear administrador, verificar BD, datos de demostración, base temporal
├── src/                         # API Node.js + Express
│   ├── config/                  # Variables de entorno, logger, pool MariaDB y transacciones
│   ├── routes/ · controllers/   # Endpoints REST
│   ├── middlewares/             # Autenticación, permisos, CSRF, validación, errores, rate limit, subidas
│   ├── services/                # Lógica de negocio por módulo
│   ├── repositories/            # Consultas SQL parametrizadas
│   ├── validators/              # Esquemas Zod
│   └── utils/                   # Dinero en céntimos, fechas, imágenes, errores
└── tests/                       # unit/ · integration/ · e2e/ · helpers/
```

## 7. Panel administrativo

El menú y los botones se muestran según los permisos efectivos del usuario, y el backend vuelve a validar cada acción.

| Área | Módulos |
|---|---|
| **Ventas** | Dashboard con indicadores, Punto de venta (POS), Caja (apertura, ingresos/egresos, arqueo), Ventas (detalle, ticket, anulación), Devoluciones, Pedidos online |
| **Inventario** | Stock por sucursal, Lotes y vencimientos, Entradas de mercadería, Ajustes y bajas, Transferencias, Kardex, Alertas |
| **Catálogo** | Productos (precios por sucursal, imagen, estado, receta), Categorías, Laboratorios, Proveedores |
| **Administración** | Clientes, Usuarios (sucursales, bloqueo, permisos individuales), Roles y permisos, Sucursales y cajas, Configuración, Reportes |

## 8. Tienda virtual

- Inicio con categorías y productos destacados; catálogo con búsqueda, filtros, orden y disponibilidad por sucursal.
- Detalle de producto (presentación, laboratorio, receta, stock disponible sin revelar cantidades exactas).
- Registro e inicio de sesión de clientes desde el **acceso único**.
- Carrito persistente en la base de datos y **checkout** con recojo en tienda o delivery (direcciones y cobertura), referencia de receta y control de cambios de precio.
- **Mis pedidos**: historial, seguimiento con actualización en vivo y cancelación mientras está pendiente.
- **Mi cuenta**: datos personales, direcciones y cambio de contraseña.

## 9. Capturas del sistema

> Todas las capturas son reales: las genera la suite E2E (`npm run test:e2e`) recorriendo la aplicación con Chrome sobre una base de datos temporal.

### Tienda virtual

| Inicio | Catálogo |
|---|---|
| ![Inicio de la tienda](evidencias/tienda/store-desktop-1440-claro.png) | ![Catálogo de productos](evidencias/tienda/vistas/catalogo-desktop-claro.png) |
| **Detalle de producto** | **Carrito** |
| ![Detalle de producto](evidencias/tienda/vistas/producto-desktop-claro.png) | ![Carrito de compras](evidencias/tienda/vistas/carrito-desktop-claro.png) |
| **Checkout** | **Mi cuenta** |
| ![Checkout](evidencias/tienda/vistas/checkout-desktop-claro.png) | ![Mi cuenta](evidencias/tienda/vistas/cuenta-desktop-claro.png) |

<details>
<summary><b>Tienda en modo oscuro y en móvil</b></summary>

| Inicio (oscuro) | Catálogo (oscuro) |
|---|---|
| ![Inicio oscuro](evidencias/tienda/store-desktop-1440-oscuro.png) | ![Catálogo oscuro](evidencias/tienda/vistas/catalogo-desktop-oscuro.png) |

| Inicio (móvil) | Menú (móvil) | Categorías (móvil) | Inicio oscuro (móvil) |
|---|---|---|---|
| ![Inicio móvil](evidencias/tienda/store-mobile-claro.png) | ![Menú móvil](evidencias/tienda/store-mobile-menu.png) | ![Categorías móvil](evidencias/tienda/store-mobile-categorias.png) | ![Inicio móvil oscuro](evidencias/tienda/store-mobile-oscuro.png) |

</details>

### Registro e inicio de sesión

| Acceso único | Registro de clientes |
|---|---|
| ![Inicio de sesión](evidencias/login/login-pc-claro.png) | ![Registro de clientes](evidencias/registro/registro-pc-claro.png) |

| Acceso (oscuro, móvil) | Registro (oscuro, móvil) |
|---|---|
| ![Acceso móvil oscuro](evidencias/login/login-movil-oscuro.png) | ![Registro móvil oscuro](evidencias/registro/registro-movil-oscuro.png) |

### Panel administrativo

| Dashboard | Punto de venta (POS) |
|---|---|
| ![Dashboard](evidencias/admin/modulos/dashboard-claro.png) | ![Punto de venta](evidencias/admin/modulos/pos-claro.png) |
| **Productos** | **Stock por sucursal** |
| ![Gestión de productos](evidencias/admin/modulos/products-claro.png) | ![Stock](evidencias/admin/modulos/stock-claro.png) |
| **Lotes y vencimientos** | **Ventas** |
| ![Lotes y vencimientos](evidencias/admin/modulos/batches-claro.png) | ![Ventas](evidencias/admin/modulos/sales-claro.png) |
| **Proveedores** | **Usuarios** |
| ![Proveedores](evidencias/admin/modulos/suppliers-claro.png) | ![Usuarios](evidencias/admin/modulos/users-claro.png) |
| **Roles y permisos** | **Reportes** |
| ![Roles y permisos](evidencias/admin/modulos/roles-claro.png) | ![Reportes](evidencias/admin/modulos/reports-claro.png) |

<details>
<summary><b>Más módulos del panel (caja, pedidos, kardex, transferencias, alertas…)</b></summary>

| Caja | Pedidos online |
|---|---|
| ![Caja](evidencias/admin/modulos/cash-claro.png) | ![Pedidos online](evidencias/admin/modulos/orders-claro.png) |
| **Entradas de mercadería** | **Kardex** |
| ![Entradas](evidencias/admin/modulos/entries-claro.png) | ![Kardex](evidencias/admin/modulos/kardex-claro.png) |
| **Transferencias** | **Alertas de inventario** |
| ![Transferencias](evidencias/admin/modulos/transfers-claro.png) | ![Alertas](evidencias/alertas/alertas-modulo-pc.png) |
| **Devoluciones** | **Configuración** |
| ![Devoluciones](evidencias/admin/modulos/returns-claro.png) | ![Configuración](evidencias/admin/modulos/settings-claro.png) |

</details>

<details>
<summary><b>Panel en modo oscuro y en móvil</b></summary>

| Dashboard (oscuro) | POS (oscuro) |
|---|---|
| ![Dashboard oscuro](evidencias/admin/modulos/dashboard-oscuro.png) | ![POS oscuro](evidencias/admin/modulos/pos-oscuro.png) |

| Panel móvil | Productos móvil (oscuro) |
|---|---|
| ![Panel móvil](evidencias/admin/admin-mobile-claro.png) | ![Productos móvil](evidencias/admin/admin-mobile-productos-oscuro.png) |

</details>

## 10. Instalación

### Requisitos

| Componente | Versión |
|---|---|
| Node.js | 20 o superior (probado en 24.21) |
| npm | 10 o superior |
| MariaDB | 10.11.x (probado con XAMPP, MariaDB 10.11.16) |
| Google Chrome | Solo para las pruebas E2E |

### Dependencias

```bash
git clone https://github.com/Edwxr320/sistema_farmacia.git
cd sistema_farmacia
npm install
```

### Archivo `.env`

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

| Variable | Descripción |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME` | Conexión a MariaDB (`127.0.0.1`, `3306`, `pharma_plus`) |
| `DB_USER`, `DB_PASSWORD` | Usuario restringido `pharma_app` (nunca `root`). La contraseña va entre comillas simples |
| `JWT_SECRET`, `CSRF_SECRET` | Dos secretos aleatorios **distintos** de 32+ caracteres:<br>`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `SESSION_TTL_MINUTES`, `BCRYPT_COST` | Duración de la sesión (480 min) y costo bcrypt (12) |
| `AUTH_MAX_FAILED_ATTEMPTS`, `AUTH_LOCKOUT_MINUTES`, `LOGIN_RATE_LIMIT_*` | Bloqueo por intentos fallidos y límite de peticiones de login |
| `ALLOWED_ORIGINS`, `TRUST_PROXY` | Orígenes permitidos y proxy inverso |
| `PAYMENT_PROVIDER` | `demo` (pagos electrónicos simulados) o `disabled` (solo efectivo). Ver [Estado del proyecto](#16-estado-del-proyecto) |
| `UPLOADS_DIR`, `UPLOAD_MAX_IMAGE_KB` | Carpeta persistente de imágenes de productos y tamaño máximo |
| `JOBS_ENABLED`, `EXPIRY_ALERTS_HOUR` | Tarea diaria de alertas de vencimiento |

El servidor **se niega a arrancar** si falta la contraseña de la base, si `DB_USER=root`, si los secretos son cortos o iguales, o si `PAYMENT_PROVIDER` no es válido. `.env` está excluido en `.gitignore`.

## 11. Base de datos MariaDB

La base `pharma_plus` contiene **43 tablas**, vistas (`vw_*`), **triggers** que protegen el stock y la auditoría, y procedimientos (`sp_*`). El backend **no crea ni altera el esquema**: solo opera sobre él.

1. **Importar el esquema** como `root` (phpMyAdmin → Importar, o consola):
   ```bash
   mariadb -u root -p < database/pharma_plus_mariadb_10_11.sql
   ```
2. **Aplicar las migraciones** de `database/migrations/` (también como `root`). `001_user_sessions.sql` es no destructiva (`CREATE TABLE IF NOT EXISTS`).
3. **Crear el usuario de la aplicación** `pharma_app` con `database/setup/01_crear_usuario_pharma_app.sql`, después de reemplazar `CAMBIE_ESTA_CONTRASENA` en una copia del archivo por una contraseña aleatoria (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). Tiene `SELECT, INSERT, UPDATE, DELETE, EXECUTE` y **ningún** permiso DDL.
4. **Verificar**:
   ```bash
   npm run db:check            # versión, tablas, vistas, procedimientos y migraciones pendientes
   npm run settings:security   # política de bloqueo por intentos (solo inserta si no existe)
   ```

Documentación de la base: [diccionario de datos](database/DICCIONARIO_DATOS.md), [diagrama ER](database/DIAGRAMA_ER.md) y [guía de la base MariaDB](database/README_DATABASE_MARIADB.md).

## 12. Ejecución

```bash
npm run build      # compila React → frontend/dist
npm start          # API + frontend compilado en http://localhost:3000
```

Desarrollo con recarga en caliente (dos terminales):

```bash
npm run dev        # API Express con reinicio automático (puerto 3000)
npm run dev:web    # Vite en http://localhost:5173 (reenvía /api, /uploads y /socket.io a Express)
```

## 13. Configuración inicial (primer administrador)

El sistema **no incluye usuarios ni contraseñas predeterminadas**. El primer administrador se crea de forma interactiva:

```bash
npm run admin:create
```

El script pide nombre, correo y contraseña (oculta, dos veces), valida la política (10+ caracteres, mayúscula, minúscula y número), usa el rol `ADMIN` y la sucursal principal, y **se niega** si ya existe un administrador. Desde el panel se crean después los trabajadores (con contraseña temporal que deben cambiar al ingresar) y los roles. Los clientes se registran desde la tienda.

Datos opcionales de demostración para el Dashboard y las alertas (solo en entornos de prueba):

```bash
npm run seed:dashboard-demo
npm run seed:inventory-alerts
```

## 14. Pruebas

```bash
npm run build             # compilación del frontend
npm run test:unit         # unitarias (sin base de datos)
npm run test:integration  # integración HTTP contra MariaDB, dentro de una transacción que se revierte
npm test                  # build + todas las pruebas
npm run test:tempdb       # toda la suite (incluida concurrencia real) en una base temporal que se elimina al final
npm run test:e2e          # Chrome real (Puppeteer) contra una base temporal; regenera las capturas de evidencias/
```

- Las pruebas de integración usan la base real pero **revierten** todos sus cambios.
- `test:tempdb` y `test:e2e` necesitan el cliente `mariadb` y una cuenta administrativa local para crear la base temporal (`MARIADB_CLI`, `TEST_DB_ADMIN_USER`, `TEST_DB_ADMIN_PASSWORD`; por defecto, `root` de XAMPP).
- `test:e2e` usa `CHROME_PATH` (por defecto `C:\Program Files\Google\Chrome\Application\chrome.exe`).

Cobertura funcional: autenticación y bloqueo, permisos, catálogo, entradas, FEFO, ajustes, POS y caja, pagos rechazados, devoluciones, transferencias, tienda y pedidos, reportes, ventas y checkouts **concurrentes** (sin stock negativo ni doble descuento) y recorridos completos en el navegador.

## 15. Seguridad y despliegue

**Implementado**

- Sesión JWT solo en cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` en producción), validada contra `user_sessions` (revocable aunque el servidor se reinicie).
- Contraseñas con bcrypt (costo 12), bloqueo por intentos fallidos y límite de peticiones de login por IP.
- CSRF *double-submit* firmado con HMAC y ligado a la sesión, más verificación de `Origin`.
- Permisos efectivos (rol + concesiones/denegaciones individuales) leídos de la base en cada petición.
- SQL siempre parametrizado; importes en céntimos enteros; validación Zod en el backend.
- Imágenes verificadas por su firma binaria y guardadas con nombre generado por el servidor.
- Helmet (CSP sin scripts inline), logs con ocultación de datos sensibles y errores sin detalles internos.
- Auditoría de cada operación con usuario, sucursal, IP y petición.

**Checklist de despliegue**

- `NODE_ENV=production`, HTTPS delante de la aplicación (`TRUST_PROXY=1` si hay proxy inverso) y `ALLOWED_ORIGINS` con el dominio real.
- Secretos nuevos y exclusivos del servidor; nunca reutilizar los de desarrollo.
- `UPLOADS_DIR` en un **volumen persistente fuera del proyecto** e incluido en las copias de seguridad (las imágenes no se versionan en Git). El servidor avisa al arrancar si en producción apunta dentro del proyecto.
- Copias de seguridad periódicas de MariaDB y usuario `pharma_app` sin privilegios DDL.
- `PAYMENT_PROVIDER=disabled` mientras no exista una pasarela real (ver abajo).

## 16. Estado del proyecto

| Área | Estado |
|---|---|
| Autenticación, roles, permisos y sesiones | ✅ Completo |
| Catálogo, proveedores, inventario por lotes, FEFO, kardex y alertas | ✅ Completo |
| POS, caja, ventas, anulaciones, tickets internos | ✅ Completo |
| Devoluciones y transferencias entre sucursales | ✅ Completo |
| Tienda virtual, carrito, checkout y pedidos con seguimiento en vivo | ✅ Completo |
| Reportes y dashboard | ✅ Completo |
| Pagos electrónicos (tarjeta, Yape, Plin, transferencia) | ⚠️ **Modo DEMO**: se registran como simulados (`is_simulated = 1`, referencia `DEMO-…`) y no se cobra nada. Con `PAYMENT_PROVIDER=disabled` solo se acepta efectivo |
| Comprobantes electrónicos (boleta/factura SUNAT) | ⚠️ No incluido: el ticket es interno y lo indica |
| Almacenamiento de imágenes | ✅ Disco local configurable (`UPLOADS_DIR`). Para almacenamiento en la nube (S3, Cloudinary…) se necesitan credenciales del servicio |

**Para activar pagos reales falta**: contratar una pasarela (Niubiz, Culqi, Mercado Pago, Izipay…), obtener sus credenciales, implementar el proveedor en `src/services/payment-gateway.service.js` (intención de pago + verificación del webhook firmado) y cambiar `payments.mode` en la base. Pharma Plus nunca solicita ni almacena datos de tarjeta.

---

<div align="center">
<sub>Pharma Plus · Aplicación Full Stack · React + Node.js + Express + MariaDB</sub>
</div>
