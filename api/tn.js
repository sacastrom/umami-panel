export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Intercambio de código por token
  if (req.query.action === 'token') {
    if (req.method !== 'POST') return res.status(405).end();
    const { code } = req.body;
    const CLIENT_ID     = process.env.TN_CLIENT_ID;
    const CLIENT_SECRET = process.env.TN_CLIENT_SECRET;
    try {
      const r = await fetch('https://www.tiendanube.com/apps/authorize/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code
        })
      });
      const data = await r.json();
      if (!r.ok) return res.status(400).json(data);
      return res.status(200).json(data);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Proxy general a la API de TN
  const token   = (req.headers.authorization || '').replace('Bearer ', '');
  const storeId = req.headers['x-store-id'];
  const tnPath  = req.query.path;

  if (!token)   return res.status(401).json({ error: 'No token' });
  if (!storeId) return res.status(400).json({ error: 'No store id' });
  if (!tnPath)  return res.status(400).json({ error: 'No path' });

  const url = `https://api.tiendanube.com/v1/${storeId}${tnPath}`;

  try {
    const opts = {
      method: req.method === 'PUT' ? 'PUT' : 'GET',
      headers: {
        'Authentication': `bearer ${token}`,
        'User-Agent': 'Umami Panel (umamishopba@gmail.com)',
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
