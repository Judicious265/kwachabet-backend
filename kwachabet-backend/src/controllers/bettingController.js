const { query, withTransaction } = require('../config/database');
const { generateId, generateTicketCode } = require('../utils/helpers');
const smsService = require('../services/sms/smsService');
const logger = require('../utils/logger');

const TAX_RATE  = 0.20;
const MIN_STAKE = 50;
const MAX_STAKE = 5000000;
const MAX_PAYOUT = 10000000;
const MAX_SELECTIONS = 20;

// ── Place Bet ─────────────────────────────────────────────────────────────────
exports.placeBet = async (req, res) => {
  try {
    const { selections, stake, use_bonus = false, is_live = false } = req.body;
    const userId = req.user.id;

    if (!selections?.length) return res.status(400).json({ error: 'At least one selection required.' });
    if (selections.length > MAX_SELECTIONS) return res.status(400).json({ error: `Max ${MAX_SELECTIONS} selections.` });
    if (parseFloat(stake) < MIN_STAKE) return res.status(400).json({ error: `Minimum stake is MWK ${MIN_STAKE}.` });
    if (parseFloat(stake) > MAX_STAKE) return res.status(400).json({ error: `Maximum stake is MWK ${MAX_STAKE.toLocaleString()}.` });

    const { rows: userRows } = await query('SELECT is_suspended FROM users WHERE id=$1', [userId]);
    if (userRows[0]?.is_suspended) return res.status(403).json({ error: 'Account suspended.' });

    // Validate each selection and compute total odds
    const validated = [];
    let totalOdds = 1.0;

    for (const sel of selections) {
      const { rows: mktRows } = await query(
        `SELECT m.*, e.home_team, e.away_team, e.status as event_status, e.id as event_id
         FROM markets m JOIN events e ON m.event_id = e.id
         WHERE m.id = $1 AND m.outcome = $2 AND m.is_active = true`,
        [sel.market_id, sel.selection]
      );
      const market = mktRows[0];

      if (!market) return res.status(400).json({ error: `Market not available: ${sel.selection}` });
      if (market.event_status === 'finished' || market.event_status === 'cancelled') {
        return res.status(400).json({ error: `Event "${market.home_team} vs ${market.away_team}" is no longer available.` });
      }
      if (is_live && market.event_status !== 'live') {
        return res.status(400).json({ error: 'Live betting only for live events.' });
      }

      totalOdds *= parseFloat(market.odds);
      validated.push({ market, selection: sel.selection });
    }

    totalOdds = parseFloat(totalOdds.toFixed(3));
    const potentialWin = parseFloat((parseFloat(stake) * totalOdds).toFixed(2));

    if (potentialWin > MAX_PAYOUT) {
      return res.status(400).json({ error: `Payout exceeds max MWK ${MAX_PAYOUT.toLocaleString()}. Reduce stake.` });
    }

    // Place bet in a DB transaction
    const ticket = await withTransaction(async (client) => {
      const { rows: walletRows } = await client.query(
        'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]
      );
      const wallet    = walletRows[0];
      const available = parseFloat(wallet.balance) - parseFloat(wallet.locked_amount);

      if (parseFloat(stake) > available) throw new Error('Insufficient balance.');

      const balBefore = parseFloat(wallet.balance);

      // Deduct stake
      await client.query(
        'UPDATE wallets SET balance = balance - $1, locked_amount = locked_amount + $1, updated_at = NOW() WHERE user_id = $2',
        [stake, userId]
      );

      // Record stake transaction
      const txnId = generateId();
      await client.query(
        'INSERT INTO transactions (id,user_id,wallet_id,type,amount,balance_before,balance_after,status,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [txnId, userId, wallet.id, 'bet_stake', -parseFloat(stake), balBefore, balBefore - parseFloat(stake), 'completed',
         JSON.stringify({ total_odds: totalOdds, legs: selections.length })]
      );

      // Create ticket
      const ticketId   = generateId();
      const ticketCode = generateTicketCode();
      const betType    = validated.length === 1 ? 'single' : (is_live ? 'live' : 'accumulator');

      await client.query(
        'INSERT INTO tickets (id,user_id,ticket_code,type,stake,total_odds,potential_win,is_live,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [ticketId, userId, ticketCode, betType, stake, totalOdds, potentialWin, is_live, 'pending']
      );

      // Create selections
      for (const { market, selection } of validated) {
        await client.query(
          'INSERT INTO ticket_selections (id,ticket_id,event_id,market_id,market_type,selection,odds,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [generateId(), ticketId, market.event_id, market.id, market.market_type, selection, parseFloat(market.odds), 'pending']
        );
      }

      return { id: ticketId, ticket_code: ticketCode, stake, total_odds: totalOdds, potential_win: potentialWin };
    });

    logger.info(`Bet placed: ${ticket.ticket_code} user=${userId} stake=${stake} odds=${totalOdds}`);
    res.status(201).json({ message: 'Bet placed!', ticket });
  } catch (err) {
    if (err.message === 'Insufficient balance.') return res.status(400).json({ error: err.message });
    logger.error('placeBet error:', err.message);
    res.status(500).json({ error: 'Failed to place bet.' });
  }
};

// ── Get user tickets ──────────────────────────────────────────────────────────
exports.getTickets = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql    = 'SELECT * FROM tickets WHERE user_id = $1';
    const args = [req.user.id];
    if (status) { sql += ' AND status = $2'; args.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT ${Math.min(parseInt(limit), 50)} OFFSET ${offset}`;

    const { rows: tickets } = await query(sql, args);

    // Attach selections to each ticket
    for (const t of tickets) {
      const { rows: sels } = await query(
        `SELECT ts.*, e.home_team, e.away_team, e.league, e.commence_time, e.status as event_status
         FROM ticket_selections ts JOIN events e ON ts.event_id = e.id
         WHERE ts.ticket_id = $1`,
        [t.id]
      );
      t.selections = sels;
    }

    const countRes = await query(
      'SELECT COUNT(*) FROM tickets WHERE user_id = $1' + (status ? ' AND status = $2' : ''),
      status ? [req.user.id, status] : [req.user.id]
    );

    res.json({
      tickets,
      pagination: { total: parseInt(countRes.rows[0].count), page: parseInt(page), pages: Math.ceil(countRes.rows[0].count / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not retrieve tickets.' });
  }
};

// ── Get single ticket ─────────────────────────────────────────────────────────
exports.getTicket = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM tickets WHERE ticket_code = $1 AND user_id = $2',
      [req.params.code.toUpperCase(), req.user.id]
    );
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

    const { rows: sels } = await query(
      `SELECT ts.*, e.home_team, e.away_team, e.league, e.commence_time, e.status as event_status
       FROM ticket_selections ts JOIN events e ON ts.event_id = e.id
       WHERE ts.ticket_id = $1`,
      [ticket.id]
    );
    ticket.selections = sels;
    res.json({ ticket });
  } catch (err) {
    res.status(500).json({ error: 'Could not retrieve ticket.' });
  }
};

// ── Public ticket check ───────────────────────────────────────────────────────
exports.checkTicket = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT ticket_code,type,stake,total_odds,potential_win,actual_win,status,created_at,settled_at FROM tickets WHERE ticket_code = $1',
      [req.params.code.toUpperCase()]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ticket not found.' });
    res.json({ ticket: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not check ticket.' });
  }
};

// ── Settle bet (called by bet settler job) ────────────────────────────────────
exports.settleBet = async (ticketId) => {
  return withTransaction(async (client) => {
    const { rows: tRows } = await client.query(
      'SELECT * FROM tickets WHERE id = $1 AND status = $2 FOR UPDATE',
      [ticketId, 'pending']
    );
    const ticket = tRows[0];
    if (!ticket) return null;

    const { rows: sels } = await client.query(
      'SELECT * FROM ticket_selections WHERE ticket_id = $1', [ticketId]
    );

    const statuses    = sels.map(s => s.status);
    let ticketStatus;

    if (statuses.every(s => s === 'void'))     ticketStatus = 'cancelled';
    else if (statuses.every(s => s === 'won')) ticketStatus = 'won';
    else if (statuses.includes('lost'))        ticketStatus = 'lost';
    else return null; // Still pending

    await client.query('UPDATE tickets SET status=$1, settled_at=NOW() WHERE id=$2', [ticketStatus, ticketId]);

    const { rows: walletRows } = await client.query(
      'SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE', [ticket.user_id]
    );
    const wallet = walletRows[0];

    // Release locked funds
    await client.query(
      'UPDATE wallets SET locked_amount = GREATEST(0, locked_amount - $1) WHERE user_id = $2',
      [ticket.stake, ticket.user_id]
    );

    if (ticketStatus === 'won') {
      const grossWin  = parseFloat(ticket.potential_win);
      const tax       = parseFloat((grossWin * TAX_RATE).toFixed(2));
      const netWin    = parseFloat((grossWin - tax).toFixed(2));
      const balBefore = parseFloat(wallet.balance);

      await client.query('UPDATE wallets SET balance = balance + $1, updated_at=NOW() WHERE user_id=$2', [netWin, ticket.user_id]);
      await client.query('UPDATE tickets SET actual_win=$1, tax_deducted=$2 WHERE id=$3', [netWin, tax, ticketId]);

      await client.query(
        'INSERT INTO transactions (id,user_id,wallet_id,type,amount,balance_before,balance_after,status,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [generateId(), ticket.user_id, wallet.id, 'bet_win', netWin, balBefore, balBefore + netWin, 'completed',
         JSON.stringify({ ticket_id: ticketId, gross_win: grossWin, tax })]
      );

      const { rows: uRows } = await client.query('SELECT phone FROM users WHERE id=$1', [ticket.user_id]);
      await smsService.sendWinNotification(uRows[0].phone, netWin, balBefore + netWin);
      logger.info(`Ticket won: ${ticket.ticket_code} net_win=${netWin}`);

    } else if (ticketStatus === 'cancelled') {
      const balBefore = parseFloat(wallet.balance);
      await client.query('UPDATE wallets SET balance = balance + $1, updated_at=NOW() WHERE user_id=$2', [ticket.stake, ticket.user_id]);
      await client.query(
        'INSERT INTO transactions (id,user_id,wallet_id,type,amount,balance_before,balance_after,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [generateId(), ticket.user_id, wallet.id, 'bet_refund', ticket.stake, balBefore, balBefore + parseFloat(ticket.stake), 'completed']
      );
    }

    return ticket;
  });
};
