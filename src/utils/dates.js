'use strict';

const LIMA_OFFSET_MS = -5 * 60 * 60 * 1000; // America/Lima: UTC-05:00 sin horario de verano

/** Fecha actual en Lima como 'YYYY-MM-DD'. */
function todayLima(now = Date.now()) {
  return new Date(now + LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Milisegundos hasta la próxima ocurrencia de HH:MM hora de Lima. */
function msUntilNextLimaTime(hour, minute = 0, now = Date.now()) {
  const lima = new Date(now + LIMA_OFFSET_MS);
  const target = new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate(), hour, minute, 0, 0));
  let delta = target.getTime() - lima.getTime();
  if (delta <= 0) delta += 24 * 60 * 60 * 1000;
  return delta;
}

module.exports = { todayLima, msUntilNextLimaTime };
