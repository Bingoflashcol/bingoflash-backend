
const express = require('express');
const { loadDB, saveDB } = require('./db');
const { requireAdmin, requireAdminOrEventPin } = require('./auth');

const router = express.Router();

// Protege endpoints administrativos (configuración, estado, export, etc.)
// Admin token-only endpoints
router.use('/admin/ping', requireAdmin);
// Event-admin endpoints: allow ADMIN_TOKEN OR PIN por evento
router.use('/admin/events/:eventId', requireAdminOrEventPin);

// Health/ping protegido para validar ADMIN_TOKEN desde el frontend.
router.get('/admin/ping', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Verifica PIN de admin por evento (para login por PIN). No modifica estado.
// Requiere X-Event-Pin correcto (o ADMIN_TOKEN).
router.get('/admin/events/:eventId/pin/verify', (req, res) => {
  res.json({ ok: true, eventId: req.params.eventId, ts: new Date().toISOString() });
});

// Cambiar/establecer PIN del evento.
// Requiere ADMIN_TOKEN o PIN actual (vía X-Event-Pin). Si el evento no tiene PIN, se requiere ADMIN_TOKEN para establecerlo.
router.put('/admin/events/:eventId/pin', (req, res) => {
  const { eventId } = req.params;
  const { new_pin } = req.body || {};
  if (!new_pin || String(new_pin).trim().length < 4) {
    return res.status(400).json({ error: 'new_pin requerido (mínimo 4 caracteres)' });
  }
  const db = loadDB();
  const ev = Array.isArray(db.events) ? db.events.find(e => String(e.id).toUpperCase() === String(eventId).toUpperCase()) : null;
  if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });

  if (!ev.admin_pin) {
    const token = (process.env.ADMIN_TOKEN || '').trim();
    const h = (req.get('Authorization') || '').trim();
    const provided = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : h;
    // Si no hay ADMIN_TOKEN configurado (modo dev/local), permitimos establecer el PIN.
    if (token && provided !== token) {
      return res.status(401).json({ error: 'Para establecer el PIN por primera vez se requiere ADMIN_TOKEN' });
    }
  }

  ev.admin_pin = String(new_pin).trim();
  saveDB(db);
  res.json({ ok: true, eventId, updated: true });
});



// Calcula cuántos cartones se han generado para un evento (breakdown)
// - online: cartones emitidos por órdenes PAID/TICKETS_ISSUED (db.tickets)
// - manual: cartones generados desde el panel (state.generated) que NO corresponden a tickets online
// Nota: en algunos flujos antiguos, state.generated puede ser un array de IDs (números/strings) sin metadatos.
// En ese caso, los tickets online suelen estar ya incluidos ahí. Para evitar doble conteo usamos:
//   manual = max(0, generatedCount - online)
function computeSoldCardsBreakdown(db, eventId) {
  if (!db || !Array.isArray(db.orders) || !Array.isArray(db.tickets)) {
    return { online: 0, manual: 0, total: 0 };
  }
  const ordersForEvent = db.orders.filter(o => o.event_id === eventId && (['PAID','TICKETS_ISSUED'].includes(o.status)));
  const orderIds = new Set(ordersForEvent.map(o => o.id));
  const tickets = db.tickets.filter(t => orderIds.has(t.order_id));
  const online = tickets.length;

  const st = (db.event_states && db.event_states[eventId] && db.event_states[eventId].state) ? db.event_states[eventId].state : null;
  const gen = (st && Array.isArray(st.generated)) ? st.generated : [];

  let manual = 0;
  if (gen.length > 0 && typeof gen[0] === 'object' && gen[0] !== null) {
    // Formato nuevo: objetos.
    // IMPORTANT: algunas versiones guardan objetos de ventas ONLINE sin order_id (p.ej. {id, cols, buyer, source:'ONLINE'}).
    // Si contamos todo lo que no tiene order_id como "manual", se duplica el total (online + manual).
    // Por eso excluimos objetos marcados como online y, además, tratamos de detectar online por id.
    const onlineIds = new Set(tickets.map(t => String(t && t.id)));
    const isOnlineGen = (g) => {
      if (!g) return false;
      if (g.order_id) return true;
      const src = String(g.source || g.origin || '').toUpperCase();
      if (src === 'ONLINE') return true;
      const id = (g.id != null) ? String(g.id) : (g.ticket_id != null ? String(g.ticket_id) : '');
      return id ? onlineIds.has(id) : false;
    };
    manual = gen.filter(g => !isOnlineGen(g)).length;
  } else {
    // Formato legacy: IDs primitivos (sin order_id) -> evitar doble conteo
    manual = Math.max(0, gen.length - online);
  }

  return { online, manual, total: online + manual };
}

// Compat: para lugares que esperan un número total
function computeSoldCards(db, eventId) {
  return computeSoldCardsBreakdown(db, eventId).total;
}

// --- Estado persistente del panel (fuente de verdad) ---
router.get('/admin/events/:eventId/state', (req, res) => {
  const { eventId } = req.params;
  const db = loadDB();
  const entry = db.event_states && db.event_states[eventId];
  res.json({
    event_id: eventId,
    updated_at: entry ? entry.updated_at : null,
    state: entry ? entry.state : null
  });
});

router.put('/admin/events/:eventId/state', (req, res) => {
  const { eventId } = req.params;
  const { state } = req.body || {};
  const db = loadDB();
  if (!db.event_states || typeof db.event_states !== 'object') db.event_states = {};

  // Permitimos borrar estado enviando null.
  if (state !== null && (typeof state !== 'object' || Array.isArray(state))) {
    return res.status(400).json({ error: 'Campo "state" debe ser un objeto o null' });
  }

  db.event_states[eventId] = {
    state: state,
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json({ ok: true, event_id: eventId, updated_at: db.event_states[eventId].updated_at });
});

// Calcula si las ventas deben estar bloqueadas (manual + 15 min antes de cantada)
function computeSalesLockedEffective(event) {
  if (!event) return false;
  const manualLocked = !!event.sales_locked;

  let autoLocked = false;
  const cantadaAt = event.cantada_at;
  if (cantadaAt) {
    const ts = Date.parse(cantadaAt);
    if (!Number.isNaN(ts)) {
      const now = Date.now();
      const fifteen = 15 * 60 * 1000;
      if (now >= (ts - fifteen)) {
        autoLocked = true;
      }
    }
  }

  return manualLocked || autoLocked;
}

// Config pública para la landing
router.get('/config/:eventId', (req, res) => {
  const { eventId } = req.params;
  const db = loadDB();

  const event = db.events.find(e => e.id === eventId);
  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  const offers = db.offers.filter(o => o.event_id === eventId);
  const soldBreakdown = computeSoldCardsBreakdown(db, eventId);
  const soldCards = soldBreakdown.total;
  // Prefer explicit target_cards (meta) over auto_target_cards.
  // auto_target_cards may be leftover from older versions and can cause wrong % in landing.
  const targetCards = (typeof event.target_cards === 'number')
    ? event.target_cards
    : (typeof event.auto_target_cards === 'number' ? event.auto_target_cards : null);

  const salesLockedEffective = computeSalesLockedEffective(event);

  const payloadEvent = Object.assign({}, event, {
    sold_cards: soldCards,
    online_sold_cards: soldBreakdown.online,
    manual_sold_cards: soldBreakdown.manual,
    target_cards: targetCards,
    sales_locked_effective: salesLockedEffective
  });

  res.json({
    event: payloadEvent,
    offers
  });
});

// Config completa para admin
router.get('/admin/events/:eventId', (req, res) => {
  const { eventId } = req.params;
  const db = loadDB();

  const event = db.events.find(e => e.id === eventId);
  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  const offers = db.offers.filter(o => o.event_id === eventId);
  const soldBreakdown = computeSoldCardsBreakdown(db, eventId);
  const soldCards = soldBreakdown.total;
  const targetCards = (typeof event.target_cards === 'number')
    ? event.target_cards
    : (typeof event.auto_target_cards === 'number' ? event.auto_target_cards : null);

  const salesLockedEffective = computeSalesLockedEffective(event);

  const payloadEvent = Object.assign({}, event, {
    sold_cards: soldCards,
    online_sold_cards: soldBreakdown.online,
    manual_sold_cards: soldBreakdown.manual,
    target_cards: targetCards,
    sales_locked_effective: salesLockedEffective
  });

  res.json({
    event: payloadEvent,
    offers
  });
});

// Tickets (cartones) del evento para sincronizar con la app (auditoría / detector de ganadores)
// Devuelve SOLO tickets de órdenes PAID.
router.get('/admin/events/:eventId/tickets', (req, res) => {
  const { eventId } = req.params;
  const db = loadDB();

  if (!db || !Array.isArray(db.orders) || !Array.isArray(db.tickets)) {
    return res.json({ tickets: [] });
  }

  const ordersForEvent = db.orders.filter(o => o.event_id === eventId && (['PAID','TICKETS_ISSUED'].includes(o.status)));
  if (!ordersForEvent.length) {
    return res.json({ tickets: [] });
  }

  const orderIds = new Set(ordersForEvent.map(o => o.id));
  const tickets = db.tickets
    .filter(t => t.event_id === eventId && orderIds.has(t.order_id))
    .map(t => ({
      id: t.id,
      serial: t.serial,
      order_id: t.order_id,
      event_id: t.event_id,
      buyer_name: t.buyer_name,
      buyer_phone: t.buyer_phone,
      buyer_email: t.buyer_email,
      card_index: t.card_index,
      cols: t.cols,
      cols_signature: t.cols_signature,
      created_at: t.created_at
    }));

  res.json({ tickets });
});

// Resumen de participantes (para overlay de Participantes / Top compradores)
// Devuelve SOLO órdenes PAID, agregadas por comprador (teléfono+nombre).
router.get('/admin/events/:eventId/participants', (req, res) => {
  const { eventId } = req.params;
  const db = loadDB();

  if (!db || !Array.isArray(db.orders)) {
    return res.json({ participants: [] });
  }

  const orders = db.orders.filter(o => o && o.event_id === eventId && (['PAID','TICKETS_ISSUED'].includes(o.status)));
  if (!orders.length) {
    return res.json({ participants: [] });
  }

  const map = new Map();
  for (const o of orders) {
    const name = (o.buyer_name ? String(o.buyer_name) : '').trim();
    const phone = (o.buyer_phone ? String(o.buyer_phone) : '').trim();
    const email = (o.buyer_email ? String(o.buyer_email) : '').trim();
    const combos = (o.combos_count|0) || 0;
    const comboSize = (o.combo_size|0) || 6;
    const paidAt = o.paid_at || o.created_at || null;
    const vendorId = o.vendor_id || null;
    const vendorName = o.vendor_name || null;
    const key = (phone ? `tel:${phone}` : `name:${name.toLowerCase()}`);
    if (!map.has(key)) {
      map.set(key, {
        name,
        phone,
        email: email || null,
        combos: 0,
        combo_size: comboSize,
        paid_at: paidAt,
        orders: 0,
        vendor_id: vendorId,
        vendor_name: vendorName
      });
    }
    const cur = map.get(key);
    cur.combos += combos;
    cur.orders += 1;

    // Preferimos conservar el vendedor si existe (último que pagó)
    if (vendorId) {
      cur.vendor_id = vendorId;
      cur.vendor_name = vendorName;
    }
    // Mantener el combo_size del evento si llega mezclado
    if (!cur.combo_size && comboSize) cur.combo_size = comboSize;
    // Mantener el último pago (más reciente)
    try {
      const a = Date.parse(cur.paid_at || '') || 0;
      const b = Date.parse(paidAt || '') || 0;
      if (b > a) cur.paid_at = paidAt;
    } catch (_) {}
    // Rellenar nombre/phone/email si el primero venía vacío
    if (!cur.name && name) cur.name = name;
    if (!cur.phone && phone) cur.phone = phone;
    if (!cur.email && email) cur.email = email;
  }

  const participants = Array.from(map.values()).map(p => ({
    name: p.name,
    phone: p.phone,
    email: p.email,
    vendorId: p.vendor_id || null,
    vendorName: p.vendor_name || null,
    combos: p.combos,
    individuales: 0,
    status: 'pago',
    combo_size: p.combo_size || 6,
    total_cards: (p.combos|0) * ((p.combo_size|0) || 6),
    paid_at: p.paid_at,
    orders: p.orders
  }));

  res.json({ participants });
});


// Obtiene datos del evento + ofertas (para panel de configuración)
// Requiere ADMIN_TOKEN o PIN del evento (middleware requireAdminOrEventPin ya aplica)
router.get('/admin/events/:eventId', (req, res) => {
  const { eventId } = req.params;
  const db = loadDB();

  const event = db.events.find(e => e.id === eventId);
  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  const offers = db.offers.filter(o => o.event_id === eventId);
  const soldBreakdown = computeSoldCardsBreakdown(db, eventId);
  const soldCards = soldBreakdown.total;
  const targetCards = (typeof event.target_cards === 'number')
    ? event.target_cards
    : (typeof event.auto_target_cards === 'number' ? event.auto_target_cards : null);

  const salesLockedEffective = computeSalesLockedEffective(event);

  const payloadEvent = Object.assign({}, event, {
    sold_cards: soldCards,
    online_sold_cards: soldBreakdown.online,
    manual_sold_cards: soldBreakdown.manual,
    target_cards: targetCards,
    sales_locked_effective: salesLockedEffective
  });

  res.json({ event: payloadEvent, offers });
});

// Actualiza datos generales del evento desde el admin
router.put('/admin/events/:eventId', (req, res) => {
  const { eventId } = req.params;
  const {
    name,
    date_time,
    location,
    description,
    flyer_url,
    is_active,
    combo_size,
    price_carton,
    price_combo,
    auto_target_cards,
    cantada_at,
    sales_locked,
    theme
  } = req.body || {};

  const db = loadDB();
  let event = db.events.find(e => e.id === eventId);

  if (!event) {
    event = {
      id: eventId,
      name: '',
      date_time: null,
      combo_size: 6,
      price_carton: 0
    };
    db.events.push(event);
  }

  if (typeof name === 'string') event.name = name;
  if (typeof date_time === 'string' || date_time === null) event.date_time = date_time;
  if (typeof location === 'string') event.location = location;
  if (typeof description === 'string') event.description = description;
  if (typeof flyer_url === 'string') event.flyer_url = flyer_url;
  if (typeof combo_size === 'number' && !Number.isNaN(combo_size)) event.combo_size = combo_size;
  if (typeof price_carton === 'number' && !Number.isNaN(price_carton)) event.price_carton = price_carton;
  if (typeof price_combo === 'number' && !Number.isNaN(price_combo)) event.price_combo = price_combo;
  if (typeof auto_target_cards === 'number' && !Number.isNaN(auto_target_cards)) event.auto_target_cards = auto_target_cards;
  if (typeof cantada_at === 'string' || cantada_at === null) event.cantada_at = cantada_at;
  if (typeof is_active === 'boolean') event.is_active = is_active;
  if (typeof sales_locked === 'boolean') event.sales_locked = sales_locked;
  // Tema opcional para personalizar la landing por evento
  if (theme && typeof theme === 'object') {
    event.theme = theme;
  }

  saveDB(db);

  const soldBreakdown = computeSoldCardsBreakdown(db, eventId);
  const soldCards = soldBreakdown.total;
  const targetCards = (typeof event.target_cards === 'number')
    ? event.target_cards
    : (typeof event.auto_target_cards === 'number' ? event.auto_target_cards : null);
  const salesLockedEffective = computeSalesLockedEffective(event);

  const payloadEvent = Object.assign({}, event, {
    sold_cards: soldCards,
    online_sold_cards: soldBreakdown.online,
    manual_sold_cards: soldBreakdown.manual,
    target_cards: targetCards,
    sales_locked_effective: salesLockedEffective
  });

  res.json({ event: payloadEvent });
});

// Reemplaza todas las ofertas de un evento
router.put('/admin/events/:eventId/offers', (req, res) => {
  const { eventId } = req.params;
  const { offers } = req.body || {};

  if (!Array.isArray(offers)) {
    return res.status(400).json({ error: 'Campo "offers" debe ser un arreglo' });
  }

  const db = loadDB();
  const event = db.events.find(e => e.id === eventId);
  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  // Quitamos ofertas actuales del evento
  db.offers = db.offers.filter(o => o.event_id !== eventId);

  // Normalizamos las nuevas ofertas
  const normalized = offers.map((o, index) => ({
    id: o.id || `of_${eventId}_${Date.now()}_${index}`,
    event_id: eventId,
    label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : `Combo ${index + 1}`,
    combos_count: Number(o.combos_count || o.combos || 1),
    price_cop: Number(o.price_cop || o.price || 0),
    // Personalización opcional de cada botón en la landing
    button_color: typeof o.button_color === 'string' ? o.button_color : null,
    button_text_color: typeof o.button_text_color === 'string' ? o.button_text_color : null,
    price_text_color: typeof o.price_text_color === 'string' ? o.price_text_color : null,
    note_text_color: typeof o.note_text_color === 'string' ? o.note_text_color : null,
    badge_text: typeof o.badge_text === 'string' ? o.badge_text : null
  }));

  db.offers.push(...normalized);
  saveDB(db);

  res.json({ offers: normalized });
});

module.exports = router;
