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
      warranty, warrantyTime, description: userDescription,
      pkgHeight, pkgWidth, pkgLength, pkgWeight, vat, importDuty
    } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ ok: false, error: 'Falta título' });
    if (!price)         return res.status(400).json({ ok: false, error: 'Falta precio' });

    const ml = async (path, body) => {
      const r = await fetch(`https://api.mercadolibre.com${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Authorization': `Bearer ${mlToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Umami-Panel/1.0'
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const text = await r.text();
      try { return JSON.parse(text); }
      catch(_) { return { error: 'parse_error', raw: text.slice(0, 200), status: r.status }; }
    };

    // ── 1. Detectar categoría ─────────────────────────────
    // MLA109936 = Alimentos y Bebidas > Bebidas (categoría hoja válida en MLA)
    let categoryId = categoryDefault && categoryDefault !== 'MLA5726'
      ? categoryDefault : 'MLA109936';
    try {
      // Limpiar título para búsqueda: sin punto final, sin unidades de medida
      const searchQ = title.trim().replace(/[.!?,]+$/, '').replace(/\s+\d+\s*(ml|gr|kg|g|l|cc)\.?\s*$/i, '').trim();
      const d = await ml(`/sites/MLA/domain_discovery/search?q=${encodeURIComponent(searchQ)}&limit=1`);
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
    // ML requiere WARRANTY_TIME junto con WARRANTY_TYPE cuando hay garantía
    const saleTerms = warrantyValue === 'Sin garantía'
      ? [{ id: 'WARRANTY_TYPE', value_name: 'Sin garantía' }]
      : [
          { id: 'WARRANTY_TYPE', value_name: warrantyValue },
          { id: 'WARRANTY_TIME', value_name: warrantyTime || '1 año' }
        ];
    const attrs = [];
    if (brand)       attrs.push({ id: 'BRAND', value_name: brand });
    if (vat)         attrs.push({ id: 'VALUE_ADDED_TAX', value_name: vat });
    if (importDuty)  attrs.push({ id: 'IMPORT_DUTY', value_name: importDuty });
    if (pkgHeight)   attrs.push({ id: 'seller_package_height', value_name: `${pkgHeight} cm`, value_struct: { number: Number(pkgHeight), unit: 'cm' } });
    if (pkgWidth)    attrs.push({ id: 'seller_package_width',  value_name: `${pkgWidth} cm`,  value_struct: { number: Number(pkgWidth),  unit: 'cm' } });
    if (pkgLength)   attrs.push({ id: 'seller_package_length', value_name: `${pkgLength} cm`, value_struct: { number: Number(pkgLength), unit: 'cm' } });
    if (pkgWeight)   attrs.push({ id: 'seller_package_weight', value_name: `${pkgWeight} g`,  value_struct: { number: Number(pkgWeight), unit: 'g'  } });

    // ML rechaza títulos en ALL CAPS — convertir a Title Case y limpiar puntuación final
    const mlTitle = title.trim()
      .replace(/[.!?,;:]+$/, '')
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase())
      .slice(0, 60);

    const baseBody = {
      // title NO se envía en el esquema UP — ML lo genera desde family_name + atributos
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
      const detail = d.id ? 'OK' : `${d.message || 'error'} | ${d.error || ''} cause=${JSON.stringify(d.cause)}`;
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
    // D: sin sale_terms (para aislar si ese campo causa el invalid_fields)
    if (!item.id) {
      const noST = { ...baseBody, family_name: familyName };
      delete noST.sale_terms;
      const dD = await ml('/items', noST);
      const detD = dD.id ? 'OK' : `${dD.message} cause=${JSON.stringify(dD.cause)}`;
      attempts.push(`[D-noST] ${detD}`);
      if (dD.id) item = dD;
    }
    // E: fallback MLA5726 + family_name
    if (!item.id && categoryId !== (categoryDefault || 'MLA5726')) {
      categoryId = categoryDefault || 'MLA5726';
      baseBody.category_id = categoryId;
      item = await tryItem('E-fallback', { family_name: familyName });
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
