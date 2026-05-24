import { createSign } from 'node:crypto';

async function googleToken() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!creds?.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly',
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

    const {
      sku, title, description, price, stock,
      brand, categoryId, weight, depth, width, height, fileId
    } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ ok: false, error: 'Falta título' });
    if (!price)         return res.status(400).json({ ok: false, error: 'Falta precio' });

    const tn = async (path, method = 'GET', body) => {
      const r = await fetch(`https://api.tiendanube.com/v1/${storeId}${path}`, {
        method,
        headers: {
          'Authentication': `bearer ${tnToken}`,
          'User-Agent': 'Umami Panel (umamishopba@gmail.com)',
          'Content-Type': 'application/json'
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const text = await r.text();
      try { return { status: r.status, data: JSON.parse(text) }; }
      catch (_) { return { status: r.status, data: { error: 'parse_error', raw: text.slice(0, 200) } }; }
    };

    // ── 1. Crear producto ───────────────────────────────────
    const productBody = {
      name: { es: title.trim().slice(0, 100) },
      description: { es: (description || title).trim() },
      published: true,
      variants: [{
        price: String(Number(price).toFixed(2)),
        stock_management: true,
        stock: Number(stock) || 3,
        ...(sku ? { sku: String(sku).trim() } : {}),
        ...(weight ? { weight: String(weight) } : {}),
        ...(depth  ? { depth:  String(depth)  } : {}),
        ...(width  ? { width:  String(width)  } : {}),
        ...(height ? { height: String(height) } : {})
      }],
      ...(brand ? { brand: String(brand).trim() } : {}),
      ...(categoryId ? { categories: [Number(categoryId)] } : {})
    };

    const createRes = await tn('/products', 'POST', productBody);
    if (createRes.status >= 400 || !createRes.data?.id) {
      return res.status(200).json({
        ok: false,
        error: `TN ${createRes.status}: ${createRes.data?.description || createRes.data?.message || JSON.stringify(createRes.data).slice(0, 200)}`
      });
    }
    const product = createRes.data;
    const productId = product.id;
    const variantId = product.variants?.[0]?.id || null;

    // ── 2. Subir imagen desde Drive (silencioso si falla) ──
    let imageId = null;
    let imageWarn = null;
    if (fileId) {
      try {
        const gToken = await googleToken();
        if (gToken) {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 5000);
          const imgRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            { headers: { Authorization: `Bearer ${gToken}` }, signal: ctrl.signal }
          );
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            const ct = imgRes.headers.get('content-type') || 'image/jpeg';
            const ext = ct.includes('png') ? 'png' : 'jpg';
            const b64 = buf.toString('base64');
            const imgPost = await tn(`/products/${productId}/images`, 'POST', {
              attachment: b64,
              filename: `${sku || 'img'}.${ext}`,
              position: 1
            });
            if (imgPost.data?.id) imageId = imgPost.data.id;
            else imageWarn = imgPost.data?.description || imgPost.data?.message || 'no se pudo subir la imagen';
          } else {
            imageWarn = `Drive ${imgRes.status}`;
          }
        }
      } catch (e) {
        imageWarn = e.message;
      }
    }

    res.status(200).json({
      ok: true,
      productId,
      variantId,
      imageId,
      imageWarn,
      handle: product.handle?.es || null
    });

  } catch (err) {
    res.status(200).json({ ok: false, error: 'Fatal: ' + err.message });
  }
}
