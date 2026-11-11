'use strict';

/**
 * Lectura de datos por consola. En una terminal interactiva la contraseña no
 * se muestra. Con stdin redirigido (sin TTY) se leen líneas sin eco.
 */

const readline = require('node:readline');

function createPrompter(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
  const lines = [];
  const waiters = [];
  let closed = false;
  let muted = false;

  // Con TTY, ocultar lo que se escribe mientras muted = true.
  const originalWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
  if (originalWrite) {
    rl._writeToOutput = (str) => {
      if (!muted) return originalWrite(str);
      if (str.includes('\n') || str.includes('\r')) return originalWrite('\n');
      return undefined;
    };
  }

  rl.on('line', (line) => {
    if (waiters.length > 0) waiters.shift().resolve(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift().reject(new Error('Entrada cerrada'));
  });

  function nextLine() {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (closed) return Promise.reject(new Error('Entrada cerrada'));
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  async function ask(question) {
    output.write(question);
    return nextLine();
  }

  async function askHidden(question) {
    output.write(question);
    muted = true;
    try {
      return await nextLine();
    } finally {
      muted = false;
      if (!input.isTTY) output.write('\n');
    }
  }

  return { ask, askHidden, close: () => rl.close() };
}

module.exports = { createPrompter };
