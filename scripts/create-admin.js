'use strict';

/**
 * npm run admin:create
 * Registra el PRIMER administrador de Pharma Plus de forma interactiva.
 * No existen contraseñas predeterminadas ni usuarios de ejemplo.
 */

const { validateConfig } = require('../src/config/env');
const { closePool } = require('../src/config/database');
const { createPrompter } = require('../src/utils/prompt');
const { createAdminSchema } = require('../src/validators/auth.validator');
const { createFirstAdmin } = require('../src/services/admin-bootstrap.service');
const { AppError } = require('../src/utils/app-error');
const { mapDbError } = require('../src/utils/db-errors');

const MAX_TRIES = 3;

async function askValid(prompter, label, field, schema, { hidden = false } = {}) {
  for (let i = 0; i < MAX_TRIES; i += 1) {
    const value = hidden ? await prompter.askHidden(label) : await prompter.ask(label);
    const result = schema.shape[field].safeParse(value);
    if (result.success) return result.data;
    console.log(`  ✖ ${result.error.issues.map((x) => x.message).join('; ')}`);
  }
  throw new Error(`Demasiados intentos inválidos para ${field}`);
}

async function main() {
  const problems = validateConfig({ requireAuthSecrets: false });
  if (problems.length > 0) {
    console.error('Configuración incompleta en .env:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  console.log('\n=== PHARMA PLUS · Registro del primer administrador ===\n');
  console.log('Política de contraseña: mínimo 10 caracteres, mayúscula, minúscula y número, sin espacios.\n');

  const baseSchema = createAdminSchema.innerType ? createAdminSchema.innerType() : createAdminSchema;
  const prompter = createPrompter();
  try {
    const fullName = await askValid(prompter, 'Nombre completo: ', 'fullName', baseSchema);
    const email = await askValid(prompter, 'Correo electrónico: ', 'email', baseSchema);

    let password = null;
    for (let i = 0; i < MAX_TRIES && password === null; i += 1) {
      const p1 = await prompter.askHidden('Contraseña: ');
      const p2 = await prompter.askHidden('Repita la contraseña: ');
      if (p1 !== p2) {
        console.log('  ✖ Las contraseñas no coinciden');
        continue;
      }
      const check = createAdminSchema.safeParse({ fullName, email, password: p1 });
      if (!check.success) {
        console.log(`  ✖ ${check.error.issues.map((x) => x.message).join('; ')}`);
        continue;
      }
      password = p1;
    }
    if (password === null) throw new Error('Demasiados intentos inválidos para la contraseña');

    const answer = await prompter.ask(`\n¿Crear el administrador "${fullName}" <${email}>? (s/N): `);
    if (!/^(s|si|sí|y|yes)$/i.test(answer.trim())) {
      console.log('Operación cancelada. No se realizó ningún cambio.');
      return;
    }

    console.log('Generando hash seguro y registrando...');
    const result = await createFirstAdmin({ fullName, email, password });
    password = null;
    console.log('\n✔ Administrador creado correctamente');
    console.log(`  ID:        ${result.userId}`);
    console.log(`  Nombre:    ${result.fullName}`);
    console.log(`  Correo:    ${result.email}`);
    console.log(`  Rol:       ${result.role}`);
    console.log(`  Sucursal:  ${result.branch.name} (${result.branch.code})`);
    console.log('  La operación quedó registrada en audit_logs.\n');
  } finally {
    prompter.close();
  }
}

main()
  .catch((err) => {
    const appErr = err instanceof AppError ? err : mapDbError(err);
    if (appErr) {
      console.error(`\n✖ ${appErr.message}`);
    } else if (err.message === 'Entrada cerrada') {
      console.error('\n✖ No hay una terminal interactiva para leer los datos. No se realizó ningún cambio.');
      console.error('  Ejecute "npm run admin:create" en PowerShell o en la terminal integrada de VS Code.');
    } else {
      console.error(`\n✖ No se pudo crear el administrador: ${err.code || err.message}`);
    }
    process.exitCode = 1;
  })
  .finally(() => closePool());
