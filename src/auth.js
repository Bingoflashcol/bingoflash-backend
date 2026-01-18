function getAdminToken(){
  return (process.env.ADMIN_TOKEN || '').trim();
}

function requireAdmin(req, res, next){
  const token = getAdminToken();
  // Dev-friendly: if ADMIN_TOKEN is not set, allow all.
  if (!token) return next();

  const h = (req.get('Authorization') || '').trim();
  const x = (req.get('X-Admin-Token') || '').trim();

  let provided = '';
  if (h.toLowerCase().startsWith('bearer ')) provided = h.slice(7).trim();
  else if (h) provided = h;
  else if (x) provided = x;

  if (provided && provided === token) return next();
  return res.status(401).json({ error: 'No autorizado' });
}


const { loadDB } = require('./db');

function getEventPin(db, eventId){
  if (!db || !Array.isArray(db.events)) return null;
  const ev = db.events.find(e => String(e.id).toUpperCase() === String(eventId).toUpperCase());
  return ev ? (ev.admin_pin || null) : null;
}

// Permite acceso si el request trae ADMIN_TOKEN correcto O (para endpoints por-evento) trae X-Event-Pin correcto.
function requireAdminOrEventPin(req, res, next){
  const token = getAdminToken();
  // DEV: si NO hay ADMIN_TOKEN configurado, permitimos cambiar/establecer PIN via PUT /pin sin exigir PIN previo.
  // En producción, configura ADMIN_TOKEN para proteger esta ruta.
  if (!token && req.method === 'PUT' && /\/pin\/?$/.test(String(req.path || ''))) {
    return next();
  }
  const h = (req.get('Authorization') || '').trim();
  const x = (req.get('X-Admin-Token') || '').trim();

  let providedAdmin = '';
  if (h.toLowerCase().startsWith('bearer ')) providedAdmin = h.slice(7).trim();
  else if (h) providedAdmin = h;
  else if (x) providedAdmin = x;

  if (token && providedAdmin && providedAdmin === token) return next();

  // Si ADMIN_TOKEN no está configurado en dev, permitimos para no bloquear.
  if (!token){
    return next();
  }

  const eventId = (req.params && (req.params.eventId || req.params.id)) || req.get('X-Event-Id') || (req.body && req.body.event_id);
  const pinHeader = (req.get('X-Event-Pin') || '').trim();
  if (!eventId) return res.status(401).json({ error: 'No autorizado' });

  const db = loadDB();
  const expected = getEventPin(db, eventId);
  // Si no hay PIN configurado: solo permitimos crear uno a través de PUT .../pin
  if (!expected) {
    const isCreatePin = req.method === 'PUT' && /\/pin\/?$/.test(String(req.path || ''));
    if (isCreatePin) return next();
    return res.status(401).json({ error: 'PIN_NOT_SET' });
  }

  if (!pinHeader) return res.status(401).json({ error: 'PIN_REQUIRED' });

  if (String(pinHeader) === String(expected)) return next();
  return res.status(401).json({ error: 'PIN_INVALID' });
}

module.exports = { requireAdmin, requireAdminOrEventPin };

