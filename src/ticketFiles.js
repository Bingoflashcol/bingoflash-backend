
const fs = require('fs');
const path = require('path');
// IMPORTANTE:
// Deshabilitamos la generación de PDF porque está causando problemas.
// La landing genera los cartones en JPG directamente en el navegador (ZIP),
// usando la grilla (cols) que queda guardada en la base de datos.
// Si más adelante quieres volver a habilitar PDF, puedes reactivar PDFKit.
// const PDFDocument = require('pdfkit');

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'http://localhost:4000').trim();
const FILES_ROOT = (process.env.FILES_PATH && process.env.FILES_PATH.trim())
  ? process.env.FILES_PATH.trim()
  : path.join(__dirname, '..', 'files');

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Genera los archivos físicos (PDF/JPG) para un cartón
 * @param {Object} params
 * @param {string} params.eventId
 * @param {Object} params.order
 * @param {number} params.cardIndex
 * @param {number[][]} params.cols  // columnas BINGO con centro libre = 0
 */
async function createTicketFilesForCols({ eventId, order, cardIndex, cols }) {
  eventId = eventId || 'default';
  const baseDir = path.join(FILES_ROOT, eventId, order.id);
  ensureDirSync(baseDir);

  // No generamos archivos aquí (ni PDF ni JPG). Solo aseguramos el directorio.
  // El front (portal.html) genera JPG en el navegador al momento de descargar.
  return { pdfUrl: null, jpgUrl: null };
}

module.exports = {
  createTicketFilesForCols
};
