import { createSign } from 'node:crypto';

async function googleToken() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!creds?.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
  })).toString('base64url');
  const s = createSign('RSA-SHA256');
  s.update(`${hdr}.${pay}`);
  const jwt = `${hdr}.${pay}.${s.sign(creds.private_key, 'base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const d = await r.json();
  return d.access_token || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Store-Id');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const tnToken = (req.headers.authorization || '').replace('Bearer ', '');
    const storeId = req.headers['x-store-id'];
    if (!tnToken) return res.status(401).json({ ok: false, error: 'No TN token' });
    if (!storeId) return res.status(400).json({ ok: false, error: 'No store id' });

    const { productId, fileId, sku } = req.body || {};
    if (!productId) return res.status(400).json({ ok: false, error: 'Falta productId' });
    if (!fileId)    return res.status(400).json({ ok: false, error: 'Falta fileId' });

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // TN limita a ~2 req/s (bucket de 40) — ante 429 esperamos y reintentamos
    // en vez de dar la operación por perdida (mismo criterio que el retry de ML).
    const tn = async (path, method = 'GET', body, attempt = 0) => {
      const r = await fetch(`https://api.tiendanube.com/v1/${storeId}${path}`, {
        method,
        headers: {
          'Authentication': `bearer ${tnToken}`,
          'User-Agent': 'Umami Panel (umamishopba@gmail.com)',
          'Content-Type': 'application/json'
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (r.status === 429 && attempt < 5) {
        const retryAfter = parseFloat(r.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 800 * (attempt + 1));
        return tn(path, method, body, attempt + 1);
      }
      const text = await r.text();
      try { return { status: r.status, data: JSON.parse(text) }; }
      catch (_) { return { status: r.status, data: { error: 'parse_error', raw: text.slice(0, 200) } }; }
    };

    // 1. Descargar la imagen nueva desde Drive
    const gToken = await googleToken();
    if (!gToken) return res.status(200).json({ ok: false, error: 'Google Service Account no configurado' });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let imgRes;
    try {
      imgRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${gToken}` }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!imgRes.ok) return res.status(200).json({ ok: false, error: `Drive ${imgRes.status}` });
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
    const ext = ct.includes('png') ? 'png' : 'jpg';
    const b64 = buf.toString('base64');

    // 2. Borrar las imágenes actuales del producto en TN
    const existing = await tn(`/products/${productId}/images`, 'GET');
    if (Array.isArray(existing.data)) {
      for (const img of existing.data) {
        await tn(`/products/${productId}/images/${img.id}`, 'DELETE');
        await sleep(300);
      }
    }

    // 3. Subir la nueva imagen
    const imgPost = await tn(`/products/${productId}/images`, 'POST', {
      attachment: b64,
      filename: `${sku || 'img'}.${ext}`,
      position: 1
    });
    if (!imgPost.data?.id) {
      return res.status(200).json({
        ok: false,
        error: `TN ${imgPost.status}: ${imgPost.data?.description || imgPost.data?.message || JSON.stringify(imgPost.data).slice(0, 200)}`
      });
    }

    res.status(200).json({ ok: true, imageId: imgPost.data.id });
  } catch (err) {
    res.status(200).json({ ok: false, error: 'Fatal: ' + err.message });
  }
}
