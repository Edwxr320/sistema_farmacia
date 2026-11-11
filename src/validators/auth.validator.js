'use strict';

const { z } = require('zod');

const emailField = z
  .string({ error: 'El correo es obligatorio' })
  .trim()
  .toLowerCase()
  .min(5, 'Correo inválido')
  .max(190, 'El correo no puede superar 190 caracteres')
  .pipe(z.email({ error: 'Correo inválido' }));

const loginSchema = z
  .object({
    email: emailField,
    // En el login solo se limita la longitud (evita abuso de CPU); la política se aplica al crear.
    password: z.string({ error: 'La contraseña es obligatoria' }).min(1, 'La contraseña es obligatoria').max(256),
  })
  .strict();

/**
 * Política de contraseñas para cuentas nuevas.
 * bcrypt solo usa los primeros 72 bytes: se rechazan contraseñas más largas.
 */
const strongPassword = z
  .string({ error: 'La contraseña es obligatoria' })
  .min(10, 'La contraseña debe tener al menos 10 caracteres')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'La contraseña no puede superar 72 bytes')
  .refine((v) => /[a-z]/.test(v), 'Debe incluir al menos una letra minúscula')
  .refine((v) => /[A-Z]/.test(v), 'Debe incluir al menos una letra mayúscula')
  .refine((v) => /[0-9]/.test(v), 'Debe incluir al menos un número')
  .refine((v) => !/\s/.test(v), 'No debe contener espacios');

const fullNameField = z
  .string({ error: 'El nombre es obligatorio' })
  .trim()
  .min(3, 'El nombre debe tener al menos 3 caracteres')
  .max(150, 'El nombre no puede superar 150 caracteres')
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u, 'El nombre solo puede contener letras, espacios, puntos, apóstrofos y guiones');

const createAdminSchema = z
  .object({ fullName: fullNameField, email: emailField, password: strongPassword })
  .superRefine((data, ctx) => {
    const local = data.email.split('@')[0];
    if (local.length >= 4 && data.password.toLowerCase().includes(local)) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'La contraseña no debe contener el correo' });
    }
  });

const changePasswordSchema = z
  .object({
    currentPassword: z.string({ error: 'La contraseña actual es obligatoria' }).min(1, 'La contraseña actual es obligatoria').max(256),
    newPassword: strongPassword,
    confirmPassword: z.string({ error: 'Confirme la nueva contraseña' }),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.newPassword !== data.confirmPassword) {
      ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'La confirmación no coincide' });
    }
    if (data.newPassword === data.currentPassword) {
      ctx.addIssue({ code: 'custom', path: ['newPassword'], message: 'La nueva contraseña debe ser distinta de la actual' });
    }
  });

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = { loginSchema, createAdminSchema, changePasswordSchema, strongPassword, emailField, fullNameField, paginationSchema };
