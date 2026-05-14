// Individual route files - each exports its router
// server.js requires these by individual name

const { 
  authRouter, usersRouter, walletRouter, bettingRouter,
  oddsRouter, paymentsRouter, adminRouter, bonusRouter, webhookRouter
} = require('./index');

module.exports = {
  authRouter, usersRouter, walletRouter, bettingRouter,
  oddsRouter, paymentsRouter, adminRouter, bonusRouter, webhookRouter
};
