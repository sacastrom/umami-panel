import { createSign } from 'node:crypto';

async function googleToken() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!creds?.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
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

  try {
    const mlToken = (req.headers.authorization || '').replace('Bearer ', '');
    if (!mlToken) return res.status(401).json({ ok: false, error: 'No ML token' });

    const {
      sku, title, price, listingType, categoryDefault, sheetRow, sheetId,
      familyName: userFamilyName, brand, stock, condition: userCondition,
      warranty, warrantyTime, description: userDescription
    } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ ok: false, error: 'Falta título' });
    if (!price)         return res.status(400).json({ ok: false, error: 'Falta precio' });

    const ml = (path, body) => fetch(`https://api.mercadolibre.com${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${mlToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    }).then(r => r.json());

    // ── 1. Detectar categoría ─────────────────────────────
    let categoryId = categoryDefault || 'MLA5726';
    try {
      const d = await ml(`/sites/MLA/domain_discovery/search?q=${encodeURIComponent(title)}&limit=1`);
      if (Array.isArray(d) && d[0]?.category_id) categoryId = d[0].category_id;
    } catch (_) {}

    // ── 2. Buscar catalog_product_id por EAN/SKU ────────────
    // NOTA: user_product_id es asignado automáticamente por ML (OUTPUT, no INPUT)
    // catalog_product_id = ID del catálogo de ML para vincular el item
    let catalogProductId = null;
    if (sku) {
      try {
        const d = await ml(`/products/search?site_id=MLA&q=${encodeURIComponent(sku)}&limit=1`);
        if (d.results?.[0]?.id) catalogProductId = d.results[0].id;
      } catch (_) {}
    }

    // ── 3. family_name (usuario o auto-generado del título) ─
    const familyName = (userFamilyName || '').trim()
      || title.trim()
           .replace(/\s+\d+\s*(ml|gr|kg|g|l|cc|un|und)\.?\s*$/i, '').trim()
           .toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).slice(0, 60)
      || title.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).slice(0, 30);

    // ── 4. Crear publicación ──────────────────────────────
    const warrantyValue = warranty || 'Sin garantía';
    const saleTerms = [{ id: 'WARRANTY_TYPE', value_name: warrantyValue }];
    if (warrantyValue !== 'Sin garantía' && warrantyTime) {
      saleTerms.push({ id: 'WARRANTY_TIME', value_name: warrantyTime });
    }
    const attrs = [];
    if (brand) attrs.push({ id: 'BRAND', value_name: brand });

    const baseBody = {
      title:              title.trim().slice(0, 60),
      price:              Number(price),
      category_id:        categoryId,
      currency_id:        'ARS',
      available_quantity: Number(stock) || 3,
      buying_mode:        'buy_it_now',
      listing_type_id:    listingType || 'gold_special',
      condition:          userCondition || 'not_specified',
      sale_terms:         saleTerms,
      ...(sku         ? { seller_custom_field: sku } : {}),
      ...(attrs.length ? { attributes: attrs }        : {})
    };

    const attempts = [];
    const tryItem = async (label, extra) => {
      const body = { ...baseBody, ...extra };
      const d = await ml('/items', body);
      const detail = d.id ? 'OK' : `${d.message || 'error'} cause=${JSON.stringify(d.cause)}`;
      attempts.push(`[${label}] ${detail}`);
      return d;
    };

    let item = { id: null };

    // A: catalog_product_id + family_name (documentación: ambos juntos para items de catálogo)
    if (catalogProductId) {
      item = await tryItem('A-cat+fam', { catalog_product_id: catalogProductId, family_name: familyName });
    }
    // B: family_name + condition:new (probar con new)
    if (!item.id) {
      item = await tryItem('B-fam-new', { family_name: familyName, condition: 'new' });
    }
    // C: family_name + condition:not_specified
    if (!item.id) {
      item = await tryItem('C-fam-ns', { family_name: familyName });
    }
    // D: fallback MLA5726 + family_name
    if (!item.id && categoryId !== (categoryDefault || 'MLA5726')) {
      categoryId = categoryDefault || 'MLA5726';
      baseBody.category_id = categoryId;
      item = await tryItem('D-fallback', { family_name: familyName });
    }

    if (!item.id) {
      return res.status(200).json({
        ok: false,
        error: `Intentos: ${attempts.join(' | ')}`,
        debug: { familyName, categoryId, catalogProductId, sentBody: baseBody }
      });
    }

    const mla = item.id;

    // ── 5. Descripción ────────────────────────────────────
    try {
      const descText = userDescription?.trim()
        || `${title}.\n\nProducto importado de Asia Oriental. Excelente calidad.\n\nConsultas por chat.`;
      await ml(`/items/${mla}/description`, { plain_text: descText });
    } catch (_) {}

    // ── 6. Escribir MLA en Sheet ──────────────────────────
    if (sheetRow && sheetId) {
      try {
        const gToken = await googleToken();
        if (gToken) {
          await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/PRODUCTOS!A${sheetRow}?valueInputOption=RAW`,
            {
              method: 'PUT',
              headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ values: [[mla]] })
            }
          );
        }
      } catch (_) {}
    }

    res.status(200).json({ ok: true, mla, categoryId, attempts });

  } catch (err) {
    res.status(200).json({ ok: false, error: 'Fatal: ' + err.message });
  }
}
