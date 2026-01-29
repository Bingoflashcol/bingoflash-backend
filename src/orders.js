const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { loadDB, saveDB } = require('./db');
const { createNequiPayment, verifyNequiWebhook } = require('./nequi');
const { generateTicketsForOrder } = require('./tickets');
const { requireAdmin } = require('./auth');

const router = express.Router();

// Protege endpoints administrativos (órdenes manuales, marcar pagos, listados, etc.)
router.use('/admin', requireAdmin);


const ORDER_STATUS = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAID: 'PAID',
  TICKETS_ISSUED: 'TICKETS_ISSUED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
};

function nowISO(){ return new Date().toISOString(); }

function isApprovedStatus(s){
  return s === ORDER_STATUS.PAID || s === ORDER_STATUS.TICKETS_ISSUED;
}

function expirePendingOrders(db){
  const ttlMin = Number(process.env.ORDER_PENDING_TTL_MINUTES || 30);
  const nowMs = Date.now();
  let changed = false;

  if (!Array.isArray(db.orders)) return false;

  for (const o of db.orders){
    if (!o || o.status !== ORDER_STATUS.PENDING_PAYMENT) continue;

    // Si no hay expires_at, lo calculamos para no dejar órdenes zombie
    if (!o.expires_at) {
      const created = Date.parse(o.created_at) || nowMs;
      o.expires_at = new Date(created + ttlMin*60*1000).toISOString();
      changed = true;
      continue;
    }

    const expMs = Date.parse(o.expires_at);
    if (!Number.isFinite(expMs)) continue;

    if (expMs <= nowMs) {
      o.status = ORDER_STATUS.EXPIRED;
      o.expired_at = nowISO();
      changed = true;
    }
  }

  if (changed) saveDB(db);
  return changed;
}

function normStr(v){
  return (v == null ? '' : String(v)).trim();
}

function isValidEmail(email){
  if (!email) return true;
  const s = String(email).trim();
  // Simple, practical validation
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

function isValidPhone(phone){
  const s = normStr(phone);
  // Accept digits with optional spaces, +, -
  const digits = s.replace(/[^0-9]/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function getIdempotencyKey(req){
  const k = req.get('Idempotency-Key') || req.get('X-Idempotency-Key');
  return normStr(k) || null;
}

function resolveVendorForEvent(db, eventId, vendorCode){
  if (!vendorCode) return null;
  const entry = db.event_states && db.event_states[eventId];
  const st = entry && entry.state;
  const vendors = st && st.vendors ? st.vendors : null;
  if (!vendors || typeof vendors !== 'object') return null;

  const code = String(vendorCode).trim();
  for (const [id, v] of Object.entries(vendors)) {
    if (!v) continue;
    if (code === id || code === String(v.linkToken || '').trim()) {
      return {
        id,
        name: (v.name || v.nombre || '').toString().trim() || id,
        commissionPct: Number(v.commissionPct || v.comisionPct || 0) || 0
      };
    }
  }
  return null;
}

function bumpVendorStats(db, eventId, vendorId, cards, amountCop){
  if (!vendorId) return;
  if (!db.event_states || !db.event_states[eventId] || !db.event_states[eventId].state) return;
  const st = db.event_states[eventId].state;
  if (!st.vendors || typeof st.vendors !== 'object') st.vendors = {};
  const v = st.vendors[vendorId];
  if (!v) return;

  if (!v.stats || typeof v.stats !== 'object') v.stats = {};
  v.stats.cartones = (v.stats.cartones|0) + (cards|0);

  const pct = Number(v.commissionPct || v.comisionPct || 0) || 0;
  const add = (Number(amountCop) || 0) * (pct/100);
  v.stats.comision = (Number(v.stats.comision) || 0) + add;
}


// Crea orden "normal" (cliente en portal, pago en línea)
router.post('/orders', (req, res) => {
  const { eventId, offerId, buyerName, buyerPhone, buyerEmail, format, vendor } = req.body || {};

  if (!eventId || !offerId || !buyerName || !buyerPhone || !format) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  if (!isValidPhone(buyerPhone)) {
    return res.status(400).json({ error: 'Teléfono no válido' });
  }
  if (!isValidEmail(buyerEmail)) {
    return res.status(400).json({ error: 'Correo no válido' });
  }

  const db = loadDB();
  expirePendingOrders(db);
  const offer = db.offers.find(o => o.id === offerId && o.event_id === eventId);
  if (!offer) {
    return res.status(400).json({ error: 'Oferta no válida para este evento' });
  }

  const amount = offer.price_cop;

  // Idempotencia: si el front reintenta (o el usuario da doble clic), devolvemos la misma orden.
  const idemKey = getIdempotencyKey(req);
  if (idemKey) {
    if (!db.idempotency || typeof db.idempotency !== 'object') db.idempotency = {};
    const existing = db.idempotency[idemKey];
    if (existing && existing.order_id) {
      const prev = db.orders.find(o => o.id === existing.order_id);
      if (prev) {
        return res.json({
          orderId: prev.id,
          status: prev.status,
          amount: prev.amount_cop,
          paymentUrl: prev.payment_url || null,
          idempotent: true
        });
      }
    }
  }

  const orderId = uuidv4();
  const now = new Date().toISOString();

  const { paymentUrl, nequiRef } = createNequiPayment({
    orderId,
    amount,
    buyerPhone
  });

  const vendorInfo = resolveVendorForEvent(db, eventId, vendor);

  const event = db.events.find(e => e.id === eventId);
  const comboSize = event && event.combo_size ? event.combo_size : 6;

  const orderRow = {
    id: orderId,
    event_id: eventId,
    offer_id: offerId,
    buyer_name: buyerName,
    buyer_phone: buyerPhone,
    buyer_email: buyerEmail || null,
    vendor_code: vendor || null,
    vendor_id: vendorInfo ? vendorInfo.id : null,
    vendor_name: vendorInfo ? vendorInfo.name : null,
    format,
    amount_cop: amount,
    nequi_ref: nequiRef,
    payment_url: paymentUrl,
    status: 'PENDING',
    created_at: now,
    paid_at: null,
    expires_at: new Date(Date.now() + (Number(process.env.ORDER_PENDING_TTL_MINUTES || 30) * 60 * 1000)).toISOString(),
    payment_method: 'NEQUI',
    combos_count: offer.combos_count || 1,
    combo_size: comboSize
  };

  db.orders.push(orderRow);

  if (idemKey) {
    if (!db.idempotency || typeof db.idempotency !== 'object') db.idempotency = {};
    db.idempotency[idemKey] = { order_id: orderId, created_at: now };
  }

  saveDB(db);

  res.json({
    orderId,
    status: 'PENDING',
    amount,
    paymentUrl
  });
});

// Crea orden manual (tú cobras por fuera y la marcas como pagada)
router.post('/admin/manual-order', async (req, res) => {
  const {
    eventId,
    buyerName,
    buyerPhone,
    buyerEmail,
    format,
    paymentMethod,
    vendor,
    combos,
    comboSize
  } = req.body || {};

  if (!eventId || !buyerName || !buyerPhone || !format) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  if (!isValidPhone(buyerPhone)) {
    return res.status(400).json({ error: 'Teléfono no válido' });
  }
  if (!isValidEmail(buyerEmail)) {
    return res.status(400).json({ error: 'Correo no válido' });
  }

  const db = loadDB();
  const amount = 0; // si más adelante quieres, podemos enviar monto desde el front
  const orderId = uuidv4();
  const now = new Date().toISOString();

  const vendorInfo = resolveVendorForEvent(db, eventId, vendor);
  const order = {
    id: orderId,
    event_id: eventId,
    offer_id: null,
    buyer_name: buyerName,
    buyer_phone: buyerPhone,
    buyer_email: buyerEmail || null,
    vendor_code: vendor || null,
    vendor_id: vendorInfo ? vendorInfo.id : null,
    vendor_name: vendorInfo ? vendorInfo.name : null,
    format,
    amount_cop: amount,
    nequi_ref: null,
    status: ORDER_STATUS.PENDING_PAYMENT,
    created_at: now,
    paid_at: null,
    expires_at: new Date(Date.now() + (Number(process.env.ORDER_PENDING_TTL_MINUTES || 30) * 60 * 1000)).toISOString(),
    payment_method: paymentMethod || 'MANUAL',
    combos_count: combos || 1,
    combo_size: comboSize || 6
  };

  

  // Crear pago Nequi (simulado por ahora). En modo real, esto generará el checkout/ref real.
  const pay = createNequiPayment({ orderId, amount, buyerPhone });
  order.nequi_ref = pay && pay.nequiRef ? pay.nequiRef : null;

  db.orders.push(order);

  // Idempotencia: guardar relación idemKey -> orderId (si aplica)
  if (idemKey) {
    db.idempotency[idemKey] = { order_id: orderId, created_at: nowISO() };
  }

  saveDB(db);

  const paymentMode = (process.env.PAYMENT_MODE || 'SIMULATED').toUpperCase();
  if (paymentMode === 'SIMULATED') {
    // En modo simulado, aprobamos y emitimos inmediatamente para no romper el flujo actual.
    const db2 = loadDB();
    const o2 = db2.orders.find(o => o.id === orderId);
    if (o2 && o2.status === ORDER_STATUS.PENDING_PAYMENT) {
      o2.status = ORDER_STATUS.PAID;
      o2.paid_at = nowISO();
      saveDB(db2);
      try{
        await generateTicketsForOrder(o2);
        const db3 = loadDB();
        const o3 = db3.orders.find(o => o.id === orderId);
        if (o3) {
          o3.status = ORDER_STATUS.TICKETS_ISSUED;
          o3.tickets_issued_at = nowISO();
          saveDB(db3);
        }
      }catch(err){
        console.error('Error generando tickets (simulado)', orderId, err);
      }
    }
  }

  // Respuesta al cliente
  return res.json({
    orderId,
    nequiRef: order.nequi_ref,
    paymentUrl: pay && pay.paymentUrl ? pay.paymentUrl : null
  });

});

// Webhook de Nequi (simulado)
router.post('/payments/nequi-webhook', async (req, res) => {
  if (!verifyNequiWebhook(req)) {
    return res.status(401).json({ error: 'Firma Nequi no válida' });
  }

  const { nequiRef, status } = req.body || {};

  if (!nequiRef) {
    return res.status(400).json({ error: 'Falta nequiRef' });
  }

  const db = loadDB();
  expirePendingOrders(db);
  const order = db.orders.find(o => o.nequi_ref === nequiRef);
  if (!order) {
    return res.status(404).json({ error: 'Orden no encontrada' });
  }

  if (status === 'APPROVED' || status === 'PAID') {
    // Si ya está aprobada/emitida, no hacemos nada (webhook puede repetirse)
    if (isApprovedStatus(order.status)) {
      return res.json({ ok: true, idempotent: true });
    }
    // Si la orden expiró, no debería aprobarse.
    if (order.status === ORDER_STATUS.EXPIRED) {
      return res.status(409).json({ error: 'Orden expirada' });
    }

    const now = nowISO();
    order.status = ORDER_STATUS.PAID;
    order.paid_at = now;
    saveDB(db);

    try {
      await generateTicketsForOrder(order);

      const db2 = loadDB();
      const o2 = db2.orders.find(o => o.id === order.id);
      if (o2) {
        o2.status = ORDER_STATUS.TICKETS_ISSUED;
        o2.tickets_issued_at = nowISO();
        saveDB(db2);
      }
    } catch (err) {
      console.error('Error generando tickets para orden', order.id, err);
    }
  } else if (status === 'REJECTED' || status === 'FAILED') {
    order.status = ORDER_STATUS.FAILED;
    order.failed_at = nowISO();
    saveDB(db);
  }

  res.json({ ok: true });
});

// Info de una orden + tickets
router.get('/orders/:id', (req, res) => {
  const db = loadDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Orden no encontrada' });

  const tickets = db.tickets
    .filter(t => t.order_id === order.id)
    .sort((a, b) => a.card_index - b.card_index);

  res.json({ order, tickets });
});

// Buscar órdenes de un cliente por teléfono/correo
router.get('/orders', (req, res) => {
  const { phone, email, eventId } = req.query;
  // Este endpoint es PÚBLICO (para que la landing pueda "Buscar mis cartones").
  // Por eso devolvemos datos mínimos (sin exponer información interna del vendedor).
  if (!phone && !email) {
    return res.status(400).json({ error: 'Debe enviar phone o email' });
  }

  const db = loadDB();
  let rows = db.orders || [];

  if (phone) {
    rows = rows.filter(o => o.buyer_phone === phone);
  }
  if (email) {
    rows = rows.filter(o => o.buyer_email === email);
  }
  if (eventId) {
    rows = rows.filter(o => o.event_id === eventId);
  }

  rows = rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  // Respuesta sanitizada: lo necesario para listar compras y luego consultar /orders/:id
  const safe = rows.map(o => ({
    id: o.id,
    event_id: o.event_id,
    buyer_name: o.buyer_name,
    buyer_phone: o.buyer_phone,
    buyer_email: o.buyer_email || null,
    format: o.format,
    amount_cop: o.amount_cop,
    status: o.status,
    created_at: o.created_at,
    paid_at: o.paid_at || null,
    expires_at: o.expires_at || null,
    payment_method: o.payment_method || 'MANUAL',
    combos_count: o.combos_count || 1,
    combo_size: o.combo_size || 6
  }));

  res.json(safe);
});

// Marcar una orden como pagada y generar cartones (admin)
router.post('/admin/mark-paid', async (req, res) => {
  const { orderId } = req.body || {};

  if (!orderId) {
    return res.status(400).json({ error: 'Falta orderId' });
  }

  const db = loadDB();
  const order = db.orders.find(o => o.id === orderId);

  if (!order) {
    return res.status(404).json({ error: 'Orden no encontrada' });
  }

  // Si ya estaba pagada, solo devolvemos la info y tickets
  if (order.status === 'PAID') {
    const ticketsAlready = db.tickets
      .filter(t => t.order_id === order.id)
      .sort((a, b) => a.card_index - b.card_index);

    return res.json({
      order,
      tickets: ticketsAlready,
      alreadyPaid: true
    });
  }

  // Rellenar combos y tamaño de combo si hace falta
  let combosCount = order.combos_count || 1;
  let comboSize = order.combo_size || 6;

  if (order.offer_id) {
    const offer = db.offers.find(
      o => o.id === order.offer_id && o.event_id === order.event_id
    );
    if (offer) {
      combosCount = offer.combos_count || combosCount;
    }
  }

  const event = db.events.find(e => e.id === order.event_id);
  if (event && event.combo_size) {
    comboSize = event.combo_size;
  }

  order.combos_count = combosCount;
  order.combo_size = comboSize;
  order.status = 'PAID';
  order.paid_at = new Date().toISOString();
  saveDB(db);

  // Generar cartones
  try {
    await generateTicketsForOrder(order);
  } catch (err) {
    console.error('Error generando tickets para orden', order.id, err);
  }

  const db2 = loadDB();
  const tickets = db2.tickets
    .filter(t => t.order_id === order.id)
    .sort((a, b) => a.card_index - b.card_index);

  res.json({
    order,
    tickets
  });
});

module.exports = router;
