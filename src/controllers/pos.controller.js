'use strict';

const cashService = require('../services/cash.service');
const saleService = require('../services/sale.service');
const ticketService = require('../services/ticket.service');
const { AppError } = require('../utils/app-error');

const v = (req) => req.validated;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

const cash = {
  registers: async (req, res) => res.json({ data: await cashService.registers(req.auth, req.dbContext) }),
  listSessions: async (req, res) => res.json(await cashService.list(v(req).query, req.auth, req.dbContext)),
  currentSession: async (req, res) => res.json({ data: await cashService.current(req.auth, req.dbContext) }),
  getSession: async (req, res) => res.json({ data: await cashService.get(v(req).params.id, req.auth, req.dbContext) }),
  openSession: async (req, res) => res.status(201).json({ data: await cashService.open(v(req).body, req.auth, req.dbContext) }),
  closeSession: async (req, res) => res.json({ data: await cashService.close(v(req).params.id, v(req).body, req.auth, req.dbContext) }),
  listMovements: async (req, res) => res.json(await cashService.movements(v(req).query, req.auth, req.dbContext)),
  addMovement: async (req, res) => res.status(201).json({ data: await cashService.addMovement(v(req).body, req.auth, req.dbContext) }),
};

const sales = {
  catalog: async (req, res) => res.json(await saleService.catalog(v(req).query, req.auth, req.dbContext)),
  quote: async (req, res) => res.json({ data: await saleService.quote(v(req).body, req.auth, req.dbContext) }),
  /**
   * Cabecera opcional Idempotency-Key: si el cliente reintenta con la misma clave,
   * se devuelve la venta ya registrada en lugar de cobrar y descontar otra vez.
   * La clave se usa como request_id de la petición (queda en la auditoría y en el kardex).
   */
  create: async (req, res) => {
    const key = req.get('idempotency-key');
    if (key !== undefined && !IDEMPOTENCY_PATTERN.test(key)) {
      throw AppError.badRequest('Idempotency-Key inválida (8 a 64 caracteres: letras, números, punto, guion o guion bajo)');
    }
    const ctx = key ? { ...req.dbContext, requestId: key } : req.dbContext;
    const sale = await saleService.create(v(req).body, req.auth, ctx, { idempotencyKey: key });
    res.status(sale.idempotentReplay ? 200 : 201).json({ data: sale });
  },
  list: async (req, res) => res.json(await saleService.list(v(req).query, req.auth, req.dbContext)),
  get: async (req, res) => res.json({ data: await saleService.get(v(req).params.id, req.auth, req.dbContext) }),
  void: async (req, res) => res.json({ data: await saleService.voidSale(v(req).params.id, v(req).body.reason, req.auth, req.dbContext) }),
  ticket: async (req, res) => {
    const ticket = await ticketService.get(v(req).params.id, req.auth, req.dbContext);
    if (v(req).query.format === 'html') {
      res.set('Cache-Control', 'no-store');
      return res.type('html').send(ticketService.renderHtml(ticket));
    }
    return res.json({ data: ticket });
  },
  issueTicket: async (req, res) => res.status(201).json({ data: await ticketService.issue(v(req).params.id, req.auth, req.dbContext) }),
  printTicket: async (req, res) => res.json({ data: await ticketService.print(v(req).params.id, req.auth, req.dbContext) }),
  payments: async (req, res) => res.json(await saleService.payments(v(req).query, req.auth, req.dbContext)),
};

module.exports = { cash, sales };
