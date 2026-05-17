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

  // ── Paso 3: Crear publicación ──────────────────────────
  // family_name es obligatorio en el nuevo esquema ML AR (campo top-level, no atributo)
  // Debe ser un texto genérico que agrupe variantes — usamos el título base
  const familyName = title.trim().replace(/\s+\d+\s*(ml|gr|kg|g|l|cc|un|und)\.?\s*$/i, '').trim().slice(0, 60) || title.trim().slice(0, 60);

  const buildBody = (extraAttrs = []) => {
    const base = {
      title: title.trim().slice(0, 60),
      family_name: familyName,
      price: Number(price),
      category_id: categoryId,
      currency_id: 'ARS',
      available_quantity: 3,
      buying_mode: 'buy_it_now',
      listing_type_id: listingType || 'gold_special',
      condition: 'new',
      sale_terms: [{ id: 'WARRANTY_TYPE', value_name: 'Sin garantía' }],
      ...(sku       ? { seller_custom_field: sku }      : {}),
      ...(pictureId ? { pictures: [{ id: pictureId }] } : {})
    };
    if (extraAttrs.length) base.attributes = extraAttrs;
    return base;
  };

  const mlPost = (body) => fetch('https://api.mercadolibre.com/items', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mlToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  let itemData = await (await mlPost(buildBody())).json();

  // Si falla → obtener atributos requeridos de la categoría y reintentar
  if (!itemData.id) {
    const hasRequiredError = itemData.cause?.some(
      c => c.code === 'body.required_fields' || c.code?.includes('required') || c.code?.includes('invalid')
    );
    if (hasRequiredError) {
      try {
        const attrRes = await fetch(
          `https://api.mercadolibre.com/categories/${categoryId}/attributes`,
          { headers: { Authorization: `Bearer ${mlToken}` } }
        );
        const attrs = await attrRes.json();
        const extraAttrs = (Array.isArray(attrs) ? attrs : [])
          .filter(a => a.tags?.required)
          .map(a => {
            // FAMILY_NAME usa el SKU como valor para que sea único
            if (a.id === 'FAMILY_NAME') return { id: a.id, value_name: (sku || title).trim().slice(0, 60) };
            return { id: a.id, value_name: a.values?.[0]?.name || 'No aplica' };
          });
        if (extraAttrs.length) {
          const retry2 = await (await mlPost(buildBody(extraAttrs))).json();
          if (retry2.id) itemData = retry2;
        }
      } catch (_) {}
    }

    // Fallback: categoría genérica MLA5726 si la detectada sigue fallando
    if (!itemData.id && categoryId !== (categoryDefault || 'MLA5726')) {
      categoryId = categoryDefault || 'MLA5726';
      const retry3 = await (await mlPost(buildBody())).json();
      if (retry3.id) itemData = retry3;
    }
  }

  if (!itemData.id) {
    const causes = (itemData.cause || []).map(c => c.message || c.code).join(' | ');
    return res.status(200).json({
      ok: false,
      error: causes || itemData.message || 'Error creando publicación',
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
