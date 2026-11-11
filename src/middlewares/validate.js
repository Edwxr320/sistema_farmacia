'use strict';

const { AppError } = require('../utils/app-error');

function formatIssues(error) {
  return error.issues.map((i) => ({ field: i.path.join('.') || null, message: i.message }));
}

/**
 * Valida req[source] con un esquema zod y reemplaza el valor por el resultado
 * normalizado (en req.validated[source], porque req.query es de solo lectura en Express 5).
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      return next(new AppError(400, 'VALIDATION_ERROR', 'Datos inválidos', formatIssues(result.error)));
    }
    req.validated = { ...(req.validated || {}), [source]: result.data };
    return next();
  };
}

module.exports = { validate, formatIssues };
