const fs = require('fs');
const path = require('path');

const DB_PATH = (process.env.DB_PATH && process.env.DB_PATH.trim())
  ? process.env.DB_PATH.trim()
  : path.join(__dirname, '..', 'bingo-db.json');

function ensureParentDir(filePath){
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getSeed() {
  return {
      events: [
        {
          id: 'VIERNES',
          name: 'Bingo Flash Tradicional',
          date_time: null,
          combo_size: 6,
          price_carton: 0,
          admin_pin: null
        }
      ],
      offers: [
        { id: 'c1', event_id: 'VIERNES', label: '1 combo',  combos_count: 1,  price_cop: 6000 },
        { id: 'c2', event_id: 'VIERNES', label: '2 combos', combos_count: 2,  price_cop: 12000 },
        { id: 'c5', event_id: 'VIERNES', label: '5 combos', combos_count: 5,  price_cop: 28000 },
        { id: 'c10',event_id: 'VIERNES', label: '10 combos', combos_count: 10, price_cop: 50000 }
      ],
      orders: [],
      tickets: [],
      // Map para idempotencia (pagos/órdenes): { [key]: { order_id, created_at } }
      idempotency: {},
      // Estado persistente por evento (fuente de verdad del panel).
      // event_states: { [eventId]: { state: <obj>, updated_at: <iso> } }
      event_states: {}
    };
}

function ensureDBFile() {
  ensureParentDir(DB_PATH);
  if (!fs.existsSync(DB_PATH)) {
    const seed = {
      events: [
        {
          id: 'VIERNES',
          name: 'Bingo Flash Tradicional',
          date_time: null,
          combo_size: 6,
          price_carton: 0,
          admin_pin: null
        }
      ],
      offers: [
        { id: 'c1', event_id: 'VIERNES', label: '1 combo',  combos_count: 1,  price_cop: 6000 },
        { id: 'c2', event_id: 'VIERNES', label: '2 combos', combos_count: 2,  price_cop: 12000 },
        { id: 'c5', event_id: 'VIERNES', label: '5 combos', combos_count: 5,  price_cop: 28000 },
        { id: 'c10',event_id: 'VIERNES', label: '10 combos', combos_count: 10, price_cop: 50000 }
      ],
      orders: [],
      tickets: [],
      // Map para idempotencia (pagos/órdenes): { [key]: { order_id, created_at } }
      idempotency: {},
      // Estado persistente por evento (fuente de verdad del panel).
      // event_states: { [eventId]: { state: <obj>, updated_at: <iso> } }
      event_states: {}
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2), 'utf8');
  }
}

function loadDB() {
  ensureDBFile();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // If the JSON gets corrupted (e.g., abrupt shutdown), keep a backup and start fresh.
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = DB_PATH + `.corrupt.${ts}.bak`;
      fs.copyFileSync(DB_PATH, backupPath);
    } catch (_) {}
    // Re-seed DB
    ensureParentDir(DB_PATH);
    fs.writeFileSync(DB_PATH, JSON.stringify(getSeed(), null, 2), 'utf8');
    return getSeed();
  }
}


function saveDB(db) {
  // Atomic write: write to temp file then rename, reduces risk of corruption.
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmpPath, DB_PATH);
}


module.exports = {
  loadDB,
  saveDB,
  DB_PATH
};
