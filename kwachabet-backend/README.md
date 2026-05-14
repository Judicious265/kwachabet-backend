# Kwacha Bet — PostgreSQL Backend API

Node.js + Express + PostgreSQL (NO SQLite, NO better-sqlite3)

## Tech Stack
- **Runtime**: Node.js 20 (locked via `.node-version`)
- **Database**: PostgreSQL (via `pg` library — pure JS, no native compilation)
- **Auth**: JWT + bcrypt
- **SMS**: Africa's Talking
- **Odds**: The Odds API
- **Payments**: PayChangu

## Why PostgreSQL?
- Multi-user concurrent transactions
- ACID compliance for financial operations
- Row-level locking for wallet operations
- Scales to millions of bets

## Deploy on Render (Recommended)

### Option A — Automatic (render.yaml)
1. Push this repo to GitHub
2. Go to render.com → New → Blueprint
3. Connect your GitHub repo
4. Render reads `render.yaml` and creates everything automatically

### Option B — Manual
1. Render → New Web Service → connect GitHub repo
2. Build command: `npm install`
3. Start command: `node src/server.js`
4. Environment: Node 20
5. Add PostgreSQL database → copy `DATABASE_URL` to env vars
6. Add all other env vars from `.env.example`

## Environment Variables Required
See `.env.example` for full list.

**Minimum required to start:**
```
JWT_SECRET=any-long-random-string
DATABASE_URL=postgresql://... (auto-provided by Render PostgreSQL)
NODE_ENV=production
```

## Run Database Schema
After deploying, run the schema in Render → PostgreSQL → Query:
```sql
-- Paste contents of database/migrations/001_schema.sql
```

Or in Render Shell:
```bash
node -e "
const {pool} = require('./src/config/database');
const fs = require('fs');
const sql = fs.readFileSync('./database/migrations/001_schema.sql','utf8');
pool.query(sql).then(()=>{console.log('Done!');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)});
"
```

## Make Yourself Admin
In Render Shell after registering:
```bash
node -e "
const {pool} = require('./src/config/database');
pool.query(\"UPDATE users SET is_admin=true WHERE phone='+265XXXXXXXXX'\")
.then(()=>{console.log('Admin granted!');process.exit(0)});
"
```

## API Endpoints
- `GET  /health` — health check
- `POST /api/v1/auth/register/initiate` — send OTP
- `POST /api/v1/auth/register/verify` — verify OTP & create account
- `POST /api/v1/auth/login` — login
- `POST /api/v1/auth/pin/set` — set 4-digit PIN
- `POST /api/v1/auth/pin/verify` — verify PIN (returns pin_token)
- `GET  /api/v1/wallet/balance` — get balance
- `POST /api/v1/wallet/deposit` — initiate deposit
- `POST /api/v1/wallet/withdraw` — request withdrawal (requires X-Pin-Token header)
- `POST /api/v1/betting/place` — place bet
- `GET  /api/v1/betting/tickets` — my tickets
- `GET  /api/v1/odds/events` — upcoming/live events
- `GET  /api/v1/odds/sports` — list of sports

## Demo Credit (Development Only)
```
POST /webhooks/demo/credit
Authorization: Bearer <token>
Body: { "amount": 50000 }
```
Credits MWK 50,000 to your wallet for testing. Disabled in production.
