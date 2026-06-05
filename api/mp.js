// Proxy para Mercado Pago (fee_details por payment)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const mpPath = req.query.path;
  if (!mpPath) return res.status(400).json({ error: 'No path' });

  const url = 'https://api.mercadopago.com' + mpPath;
  try {
    const r = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch(_) { res.status(r.status).json({ error: 'parse_error', raw: text.slice(0,200) }); }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
