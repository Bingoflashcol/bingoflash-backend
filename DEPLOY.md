# Backend deployment notes (Bingo Flash Tradicional)

## Quick start (Render)
- Build command: `npm install`
- Start command: `npm start`
- Node: recommended >= 18

## Environment variables
Required:
- `NODE_ENV=production`
- `BASE_URL=https://api.bingoflashcol.com` (or your Render URL)
- `ALLOWED_ORIGINS=https://www.bingoflashcol.com,https://gerente-7hf.bingoflashcol.com`

Recommended:
- `RATE_LIMIT_PER_MIN=180`
- `JSON_LIMIT=2mb`
- `LOG_HTTP=1`

Storage (IMPORTANT):
- By default the backend stores data in a local JSON file (`DB_PATH`).
- On free/ephemeral hosting, local disk may be cleared on restart/redeploy.
  For real money operations, move to a real database (Postgres/Mongo).

Optional:
- `DB_PATH=/var/data/bingo-db.json` (only if you have persistent disk)

Payments:
- `PAYMENT_MODE=SIMULATED` (default in this project)
