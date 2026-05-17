import { createSign } from 'node:crypto';

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets';

async function googleToken() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!creds?.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({
    iss: creds.client_email, scope: SCOPES,
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const mlToken = (req.headers.authorization || '').replace('Bearer ', '');
  if (!mlToken) return res.status(401).json({ ok: false, error: 'No ML token' });

  const { sku, title, price, listingType, fileId, categoryDefault, sheetRow, sheetId } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ ok: false, error: 'Falta título' });
  if (!price)         return res.status(400).json({ ok: false, error: 'Falta precio' });

  const gToken = await googleToken();
  let pictureId = null, pictureWarn = null;

  // ── Paso 1: Subir imagen desde Drive ───────────────────
  if (fileId && gToken) {
    try {
      const imgRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${gToken}` } }
      );
      if (!imgRes.ok) throw new Error(`Drive status ${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const ct  = imgRes.headers.get('content-type') || 'image/jpeg';
      const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpg';
      const bound = 'UmamiPub' + Date.now().toString(36);
      const body  = Buffer.concat([
        Buffer.from(`--${bound}\r\nContent-Disposition: form-data; name="file"; filename="img.${ext}"\r\nContent-Type: ${ct}\r\n\r\n`),
        buf,
        Buffer.from(`\r\n--${bound}--`)
      ]);
      const picRes  = await fetch('https://api.mercadolibre.com/pictures/items/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mlToken}`,
          'Content-Type': `multipart/form-data; boundary=${bound}`
        },
        body
      });
      const picData = await picRes.json();
      if (picData.id) pictureId = picData.id;
      else pictureWarn = picData.message || 'No se obtuvo picture_id';
    } catch (e) {
      pictureWarn = e.message;
    }
  }

  // ── Paso 2: Detectar categoría ─────────────────────────
  let categoryId = categoryDefault || 'MLA5726';
  try {
    const r = await fetch(
      `https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=${encodeURIComponent(title)}&limit=1`,
      { headers: { Authorization: `Bearer ${mlToken}` } }
    );
    const d = await r.json();
    if (Array.isArray(d) && d[0]?.category_id) categoryId = d[0].category_id;
  } catch (_) {}

  // ── Paso 2.5: Buscar user_product_id en catálogo ML ──────
  let userProductId = null;
  let catalogDebug  = 'no-search';
  try {
    const queries = sku ? [sku, title.slice(0, 40)] : [title.slice(0, 40)];
    for (const q of queries) {
      const r1 = await fetch(
        `https://api.mercadolibre.com/products/search?site_id=MLA&q=${encodeURIComponent(q)}&limit=3`,
        { headers: { Authorization: `Bearer ${mlToken}` } }
      );
      const d1 = await r1.json();
      if (d1.results?.[0]?.id) {
        userProductId = d1.results[0].id;
        catalogDebug = `prod:${userProductId}`;
        break;
      }
      const r2 = await fetch(
        `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=5`,
        { headers: { Authorization: `Bearer ${mlToken}` } }
      );
      const d2 = await r2.json();
      const hit = (d2.results || []).find(x => x.catalog_product_id);
      if (hit?.catalog_product_id) {
        userProductId = hit.catalog_product_id;
        catalogDebug = `site:${userProductId}`;
        break;
      }
    }
  } catch (e) { catalogDebug = 'err:' + e.message; }

  // ── Paso 3: Crear publicación ──────────────────────────
  // family_name en Title Case (ML rechaza ALL CAPS)
  const familyName = title.trim()
    .replace(/\s+\d+\s*(ml|gr|kg|g|l|cc|un|und)\.?\s*$/i, '').trim()
    .toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).slice(0, 60)
    || title.trim().slice(0, 30).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  const mlPost = (body) => fetch('https://api.mercadolibre.com/items', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mlToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const attempts = [];
  const tryPost = async (label, body) => {
    const d = await (await mlPost(body)).json();
    const detail = d.id ? 'OK' : JSON.stringify({ msg: d.message, cause: d.cause });
    attempts.push(`[${label}] ${detail}`);
    return d;
  };

  // Campos base (sin family_name ni user_product_id)
  const base = () => ({
    title:              title.trim().slice(0, 60),
    price:              Number(price),
    category_id:        categoryId,
    currency_id:        'ARS',
    available_quantity: 3,
    buying_mode:        'buy_it_now',
    listing_type_id:    listingType || 'gold_special',
    condition:          'not_specified',
    sale_terms: [{ id: 'WARRANTY_TYPE', value_name: 'Sin garantía' }],
    ...(sku       ? { seller_custom_field: sku }      : {}),
    ...(pictureId ? { pictures: [{ id: pictureId }] } : {})
  });

  let itemData = { id: null };

  // Intento A: user_product_id del catálogo (SIN family_name) — flujo correcto
  if (userProductId) {
    itemData = await tryPost(`A-upid(${catalogDebug})`, { ...base(), user_product_id: userProductId });
  }

  // Intento B: family_name Title Case + not_specified
  if (!itemData.id) {
    itemData = await tryPost('B-family-ns', { ...base(), family_name: familyName });
  }

  // Intento C: family_name + condition new
  if (!itemData.id) {
    itemData = await tryPost('C-family-new', { ...base(), family_name: familyName, condition: 'new' });
  }

  // Intento D: categoría fallback MLA5726
  if (!itemData.id && categoryId !== (categoryDefault || 'MLA5726')) {
    categoryId = categoryDefault || 'MLA5726';
    const bodyD = userProductId
      ? { ...base(), user_product_id: userProductId }
      : { ...base(), family_name: familyName };
    itemData = await tryPost('D-fallback', bodyD);
  }

  if (!itemData.id) {
    return res.status(200).json({
      ok: false,
      error: `Intentos: ${attempts.join(' | ')}`,
      details: itemData
    });
  }

  const mla = itemData.id;

  // ── Paso 4: Agregar descripción ────────────────────────
  try {
    await fetch(`https://api.mercadolibre.com/items/${mla}/description`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mlToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plain_text: `${title}.\n\nProducto importado de Asia Oriental. Excelente calidad y relación precio-producto.\n\nConsultas por chat de MercadoLibre.`
      })
    });
  } catch (_) {}

  // ── Paso 5: Escribir MLA en la Sheet ──────────────────
  if (gToken && sheetRow && sheetId) {
    try {
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/PRODUCTOS!A${sheetRow}?valueInputOption=RAW`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [[mla]] })
        }
      );
    } catch (_) {}
  }

  res.status(200).json({
    ok: true, mla, categoryId, pictureId,
    ...(pictureWarn ? { pictureWarn } : {})
  });
}
