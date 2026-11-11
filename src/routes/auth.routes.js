'use strict';

const { Router } = require('express');
const authController = require('../controllers/auth.controller');
const { authenticate, optionalAuthenticate } = require('../middlewares/authenticate');
const { validate } = require('../middlewares/validate');
const { loginRateLimiter, sensitiveRateLimiter } = require('../middlewares/rate-limit');
const { loginSchema, changePasswordSchema } = require('../validators/auth.validator');

const router = Router();

router.get('/csrf-token', authController.getCsrfToken);
router.post('/login', loginRateLimiter, validate(loginSchema), authController.login);
// Acceso único: el backend reconoce si la cuenta es de personal o de cliente.
router.post('/access', loginRateLimiter, optionalAuthenticate, validate(loginSchema), authController.access);
router.post('/logout', optionalAuthenticate, authController.logout);
router.get('/me', authenticate, authController.me);
router.post(
  '/change-password',
  sensitiveRateLimiter,
  authenticate,
  validate(changePasswordSchema),
  authController.changePassword,
);

module.exports = router;
