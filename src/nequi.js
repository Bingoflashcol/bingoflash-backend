function createNequiPayment({ orderId, amount, buyerPhone }) {
  const paymentUrl = `https://nequi-falso/${orderId}`;
  const nequiRef = `NEQ-${orderId}`;
  return { paymentUrl, nequiRef };
}

function verifyNequiWebhook(req) {
  // De momento siempre aceptamos el webhook (simulado)
  return true;
}

module.exports = {
  createNequiPayment,
  verifyNequiWebhook
};
