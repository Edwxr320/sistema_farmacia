'use strict';

const multer = require('multer');
const { config } = require('../config/env');
const { AppError } = require('../utils/app-error');
const { ALLOWED_MIME } = require('../utils/image-storage');

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxImageBytes, files: 1, fields: 0, parts: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(AppError.badRequest('Tipo de archivo no permitido'));
    return cb(null, true);
  },
});

/** Un único archivo en el campo "image"; traduce los errores de multer. */
function singleImage(req, res, next) {
  imageUpload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof AppError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'La imagen supera el tamaño máximo'));
    return next(AppError.badRequest('Archivo inválido: envíe un único archivo en el campo "image"'));
  });
}

module.exports = { singleImage };
