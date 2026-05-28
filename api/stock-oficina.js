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

// Asegura que existe la hoja MOVIMIENTOS_OFICINA con headers
async function ensureMovimientosSheet(token, sheetId) {
  const meta = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.json());
  const exists = meta.sheets?.some(s => s.properties?.title === 'MOVIMIENTOS_OFICINA');
  if (exists) return;

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: 'MOVIMIENTOS_OFICINA' } } }]
      })
    }
  );
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/MOVIMIENTOS_OFICINA!A1:F1?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['TIMESTAMP','SKU','NOMBRE','DELTA','MOTIVO','STOCK_RESULTANTE']] })
    }
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { sheetId, sku, delta, motivo, productName } = req.body || {};
    if (!sheetId) return res.status(400).json({ ok: false, error: 'Falta sheetId' });
    if (!sku)     return res.status(400).json({ ok: false, error: 'Falta sku' });
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      return res.status(400).json({ ok: false, error: 'Delta inválido' });
    }

    const token = await googleToken();
    if (!token) return res.status(500).json({ ok: false, error: 'Sin token de Google' });

    // ── 1. Buscar fila por SKU en columna B
    const skuColRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/PRODUCTOS!B:B`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.json());
    const skuRows = skuColRes.values || [];
    let rowIdx = -1;
    for (let i = 1; i < skuRows.length; i++) {
      if (String(skuRows[i][0] || '').trim() === String(sku).trim()) { rowIdx = i; break; }
    }
    if (rowIdx === -1) return res.status(404).json({ ok: false, error: 'SKU no encontrado en la Sheet' });
    const sheetRow = rowIdx + 1; // 1-based

    // ── 2. Leer STOCK OFICINA actual (columna O = 15)
    const curRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/PRODUCTOS!O${sheetRow}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.json());
    const curVal = curRes.values?.[0]?.[0];
    const current = (curVal === undefined || curVal === '' || curVal === null) ? 0 : Number(curVal) || 0;
    const next = Math.max(0, current + delta);
    const realDelta = next - current; // por si tope en 0

    // ── 3. Actualizar STOCK OFICINA
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/PRODUCTOS!O${sheetRow}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[next]] })
      }
    );

    // ── 4. Asegurar hoja MOVIMIENTOS y appendear
    await ensureMovimientosSheet(token, sheetId);
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/MOVIMIENTOS_OFICINA!A:F:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          values: [[ts, sku, productName || '', realDelta, motivo || '', next]]
        })
      }
    );

    res.status(200).json({ ok: true, sku, stockOficina: next, delta: realDelta, row: sheetRow });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
}
