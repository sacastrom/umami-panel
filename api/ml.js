export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const mlPath = req.query.path;
  if (!mlPath) return res.status(400).json({ error: 'No path' });

  const url = 'https://api.mercadolibre.com' + mlPath;

  try {
    const opts = {
      method: req.method === 'PUT' ? 'PUT' : 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    };
    if (req.method === 'PUT' && req.body) {
      opts.body = JSON.stringify(req.body);
    }
    const r = await fetch(url, opts);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
