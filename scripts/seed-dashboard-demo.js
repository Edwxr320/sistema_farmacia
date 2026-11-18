'use strict';

/**
 * Generador de datos de demostración para el Dashboard de Pharma Plus.
 *
 *   npm run seed:dashboard-demo
 *       Simulación de SOLO LECTURA (por defecto): muestra el plan, el stock que usaría y los problemas.
 *
 *   npm run seed:dashboard-demo -- --execute --run-id dashboard-20261111-01 [--branch-id 1] [--email admin@...]
 *       Ejecución real: muestra el plan, exige escribir «CONFIRMAR GENERACION DEMO EN <base>», pide las
 *       credenciales de un administrador (la contraseña no se muestra ni se guarda), opera con los servicios
 *       reales del backend, verifica el resultado y revoca la sesión temporal.
 *
 * Nunca se ejecuta desde start/dev/build/test. Ver scripts/lib/dashboard-demo.js.
 */

const readline = require('node:readline');
const { Writable } = require('node:stream');
const { config } = require('../src/config/env');
const { closePool } = require('../src/config/database');
const authService = require('../src/services/auth.service');
const demo = require('./lib/dashboard-demo');

function parseArgs(argv) {
  const out = { execute: false, runId: null, branchId: null, email: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--execute') out.execute = true;
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--branch-id') out.branchId = Number(argv[++i]);
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Argumento desconocido: ${a}`);
  }
  if (out.branchId !== null && !(Number.isInteger(out.branchId) && out.branchId > 0)) throw new Error('--branch-id debe ser un número de sucursal');
  return out;
}

/** Pregunta por consola; con hidden la respuesta no se muestra (contraseñas). */
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const out = new Writable({ write(chunk, enc, cb) { if (!this.muted) process.stdout.write(chunk, enc); cb(); } });
    out.muted = false;
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: Boolean(process.stdin.isTTY) });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    out.muted = hidden;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Uso: npm run seed:dashboard-demo [-- --execute --run-id <id> [--branch-id <id>] [--email <correo>]]');
    return 0;
  }
  const db = config.db.database;
  const runId = args.runId || demo.defaultRunId();
  demo.assertRunId(runId);

  console.log(`\nPharma Plus · generador de datos de demostración · base de datos: ${db}\n`);
  const sim = await demo.dryRun({ runId, branchId: args.branchId });
  console.log(sim.text);

  if (!args.execute) {
    console.log('\nSimulación de solo lectura: no se escribió nada.');
    console.log(`Para ejecutar: npm run seed:dashboard-demo -- --execute --run-id ${runId}`);
    return sim.preflight.problems.length ? 2 : 0;
  }
  if (!args.runId) throw new Error('La ejecución real exige indicar --run-id explícitamente.');
  if (!process.stdin.isTTY) throw new Error('La ejecución real es interactiva: ejecútela desde una terminal.');
  if (sim.preflight.problems.length) {
    console.log('\nNo se ejecutará: corrija los problemas indicados.');
    return 2;
  }

  console.log(`\nSe escribirá en la base «${db}» mediante los servicios del sistema (ventas, pagos DEMO, pedidos, devoluciones y movimientos de inventario).`);
  const phrase = `CONFIRMAR GENERACION DEMO EN ${db}`;
  const typed = await ask(`Para continuar escriba exactamente «${phrase}»: `);
  if (typed.trim() !== phrase) {
    console.log('Confirmación incorrecta: cancelado, no se escribió nada.');
    return 1;
  }

  const email = (args.email || (await ask('Correo del administrador: '))).trim();
  const password = await ask('Contraseña (no se mostrará): ', { hidden: true });
  const reqCtx = { ip: '127.0.0.1', userAgent: 'seed-dashboard-demo', requestId: `${runId}-login` };
  const login = await authService.login({ email, password }, reqCtx, { portal: 'staff' });
  const auth = {
    userId: login.user.id, branchId: login.activeBranchId, jti: login.session.jti, sessionHash: login.session.sessionHash,
    user: login.user, branches: login.branches, permissions: new Set(login.permissions),
  };
  try {
    console.log(`\nSesión iniciada como ${login.user.fullName} (${login.user.role.code}).\n`);
    const result = await demo.execute({ runId, auth, branchId: args.branchId, ctx: reqCtx, log: (m) => console.log(`  · ${m}`) });
    console.log('\nCreado en esta ejecución:', JSON.stringify(result.created));
    for (const [k, why] of Object.entries(result.skipped)) if (why) console.log(`Omitido (${k}): ${why}`);
    result.notes.forEach((n) => console.log(`Nota: ${n}`));
    console.log(`\nVerificación (solo lectura) del RUN_ID ${runId}:`);
    console.log(demo.formatVerification(result.verification));
    return result.verification.issues.length ? 3 : 0;
  } finally {
    // La sesión temporal del generador se revoca siempre.
    await authService.logout(auth, { ...reqCtx, requestId: `${runId}-logout` }).catch((err) => console.error(`No se pudo revocar la sesión: ${err.message}`));
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`\nError: ${err.message}`);
    if (err.problems?.length) err.problems.forEach((p) => console.error(`  ✖ ${p}`));
    if (err.details) console.error(JSON.stringify(err.details));
    console.error('Las operaciones confirmadas antes del error se conservan; puede reanudar con el mismo --run-id.');
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
