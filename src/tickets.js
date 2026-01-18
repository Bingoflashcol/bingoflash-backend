
const { v4: uuidv4 } = require('uuid');
const { loadDB, saveDB } = require('./db');
const { createTicketFilesForCols } = require('./ticketFiles');

// Serial (visible) estilo app: BF-<EVENT>-00001-ABCD
// Nota: la app web (assets/exporter/combos.js) usa base36 con padding 5.
function makeSerial(eventId, seq) {
  const up = String(eventId || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);
  const base36 = (Number(seq) || 0)
    .toString(36)
    .toUpperCase()
    .padStart(5, '0');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `BF-${up}-${base36}-${rand}`;
}

// Rango de columnas BINGO (75 bolas)
const COLS = [
  [1, 15],   // B
  [16, 30],  // I
  [31, 45],  // N
  [46, 60],  // G
  [61, 75]   // O
];

// Toma n números únicos aleatorios del rango [a, b] y los ordena
function sampleRange(a, b, n) {
  const pool = [];
  for (let v = a; v <= b; v++) pool.push(v);

  const picked = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  picked.sort((x, y) => x - y);
  return picked;
}

// Genera una grilla completa de 5x5 columnas (con centro libre = 0)
function genCols() {
  const cols = COLS.map(([a, b]) => sampleRange(a, b, 5));
  // Centro libre en la columna N (índice 2), fila 2
  cols[2][2] = 0;
  return cols;
}

// Firma única de una grilla (para evitar repetir cartones en un evento)
function sign(cols) {
  const flat = [];
  for (let ci = 0; ci < 5; ci++) {
    for (let ri = 0; ri < 5; ri++) {
      flat.push(cols[ci][ri] | 0);
    }
  }
  return JSON.stringify(flat);
}

// Genera cartones reales (grillas + archivos PDF/JPG) para una orden ya pagada
async function generateTicketsForOrder(order) {
  const db = loadDB();
  if (!db.tickets) db.tickets = [];

  // Aplica comisión/estadísticas del vendedor UNA sola vez por orden.
  // Se guarda una bandera en la orden para que los webhooks/reintentos no dupliquen conteos.
  function applyVendorStatsOnce(orderRow, totalCards){
    try{
      if (!orderRow || !orderRow.vendor_id) return;
      if (orderRow.vendor_stats_applied) return;

      const eventId = orderRow.event_id;
      if (!db.event_states || !db.event_states[eventId] || !db.event_states[eventId].state) return;
      const st = db.event_states[eventId].state;
      if (!st.vendors || typeof st.vendors !== 'object') return;

      const v = st.vendors[orderRow.vendor_id];
      if (!v) return;
      if (!v.stats || typeof v.stats !== 'object') v.stats = {};

      const combos = (orderRow.combos_count|0) || 0;
      const amount = Number(orderRow.amount_cop) || 0;
      const pct = Number(v.commissionPct || v.comisionPct || 0) || 0;

      v.stats.combos = (v.stats.combos|0) + combos;
      v.stats.cartones = (v.stats.cartones|0) + ((totalCards|0) || 0);
      v.stats.ventas_cop = (Number(v.stats.ventas_cop) || 0) + amount;
      v.stats.comision = (Number(v.stats.comision) || 0) + (amount * (pct/100));

      orderRow.vendor_stats_applied = true;
    }catch(_){ /* no romper generación */ }
  }

  // Idempotencia: si ya existen cartones para esta orden, no duplicar.
  const existingForOrder = db.tickets.filter(t => t.order_id === order.id);
  if (existingForOrder.length > 0) {
    // Asegurar que la comisión/estadística del vendedor quede aplicada aunque el webhook se repita.
    const orderRow = Array.isArray(db.orders) ? db.orders.find(o => o && o.id === order.id) : null;
    if (orderRow) {
      applyVendorStatsOnce(orderRow, existingForOrder.length);
      saveDB(db);
    }
    return { totalCards: existingForOrder.length, idempotent: true };
  }

  // Secuencia persistente por evento para que el serial coincida con el generador manual
  if (!db.event_ticket_seq) db.event_ticket_seq = {};
  const seqStart = (db.event_ticket_seq[order.event_id] | 0);
  let seqCursor = seqStart;

  const combos = order.combos_count || 1;
  const comboSize = order.combo_size || 6;
  const totalCards = combos * comboSize;
  const now = new Date().toISOString();
  const eventId = order.event_id;
  if (!eventId) {
    throw new Error('order.event_id requerido para generar cartones');
  }

  // Construir set de firmas ya usadas para este evento
  const existing = new Set();
  for (const t of db.tickets) {
    if (t.event_id === eventId && t.cols_signature) {
      existing.add(t.cols_signature);
    }
  }

  let created = 0;
  let safety = totalCards * 20; // límite para evitar bucles infinitos

  while (created < totalCards && safety > 0) {
    safety--;

    const cols = genCols();
    const sig = sign(cols);

    if (existing.has(sig)) continue; // repetido, buscar otro

    existing.add(sig);

    const ticketId = uuidv4();
    const cardIndex = created;

    // Serial visible (lo que se imprime en la parte inferior del cartón)
    seqCursor += 1;
    const serial = makeSerial(eventId, seqCursor);

    let pdfUrl = null;
    let jpgUrl = null;
    try {
      const files = await createTicketFilesForCols({
        eventId,
        order,
        cardIndex,
        cols
      });
      if (files) {
        pdfUrl = files.pdfUrl || null;
        jpgUrl = files.jpgUrl || null;
      }
    } catch (err) {
      console.error('Error generando archivos para cartón', order.id, cardIndex + 1, err);
    }

    db.tickets.push({
      id: ticketId,
      serial,
      order_id: order.id,
      event_id: eventId,
      buyer_name: order.buyer_name || null,
      buyer_phone: order.buyer_phone || null,
      buyer_email: order.buyer_email || null,
      vendor_id: order.vendor_id || null,
      vendor_name: order.vendor_name || null,
      card_index: cardIndex,
      cols,                // Grilla real BINGO 75
      cols_signature: sig, // Para auditoría / evitar duplicados
      pdf_url: pdfUrl,
      jpg_url: jpgUrl,
      created_at: now
    });

    created++;
  }

  // Persistimos el último consecutivo por evento
  db.event_ticket_seq[eventId] = seqCursor;

  // Marcar comisión/estadística de vendedor
  const orderRow = Array.isArray(db.orders) ? db.orders.find(o => o && o.id === order.id) : null;
  if (orderRow) {
    applyVendorStatsOnce(orderRow, created);
  }

  saveDB(db);
  return { totalCards: created };
}

module.exports = {
  generateTicketsForOrder
};
