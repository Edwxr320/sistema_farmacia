'use strict';

/**
 * Imágenes en disco; en MariaDB solo se guarda la ruta pública (/uploads/...).
 * - Tipo verificado por la firma binaria (no solo por la extensión o el MIME declarado).
 * - Nombre generado por el servidor: el nombre original del cliente nunca se usa.
 * - Escritura exclusiva ('wx') dentro del directorio configurado.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { config } = require('../config/env');
const { AppError } = require('./app-error');

const PUBLIC_PREFIX = '/uploads';
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Detecta el formato real por los primeros bytes. */
function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

/** Valida el archivo recibido por multer (memoria). */
function validateImage(file) {
  if (!file) throw AppError.badRequest('Debe adjuntar una imagen en el campo "image"');
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw AppError.badRequest('Extensión no permitida (use .jpg, .jpeg, .png o .webp)');
  if (!ALLOWED_MIME.has(file.mimetype)) throw AppError.badRequest('Tipo de archivo no permitido');
  if (file.size > config.uploads.maxImageBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'La imagen supera el tamaño máximo');
  const real = detectImageType(file.buffer);
  if (!real) throw AppError.badRequest('El archivo no es una imagen JPG, PNG o WEBP válida');
  if (real.mime !== file.mimetype) throw AppError.badRequest('El contenido no coincide con el tipo de archivo declarado');
  return real;
}

/** Guarda la imagen y devuelve su ruta pública. */
async function saveImage(folder, prefix, file) {
  const { ext } = validateImage(file);
  if (!/^[a-z0-9-]+$/.test(folder) || !/^[a-z0-9-]+$/.test(prefix)) throw new Error('nombre de carpeta inválido');
  const dir = path.join(config.uploads.dir, folder);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${prefix}-${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(dir, filename), file.buffer, { flag: 'wx' });
  return `${PUBLIC_PREFIX}/${folder}/${filename}`;
}

/** Elimina una imagen previa (solo si está dentro del directorio de subidas). */
async function deleteImage(publicPath) {
  if (!publicPath || !publicPath.startsWith(`${PUBLIC_PREFIX}/`)) return;
  const abs = path.resolve(config.uploads.dir, publicPath.slice(PUBLIC_PREFIX.length + 1));
  if (!abs.startsWith(config.uploads.dir + path.sep)) return; // evita salir del directorio
  await fs.unlink(abs).catch(() => {});
}

module.exports = { detectImageType, validateImage, saveImage, deleteImage, PUBLIC_PREFIX, ALLOWED_MIME };
