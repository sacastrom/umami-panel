const ML_BASE = 'https://api.mercadolibre.com';

export function mapLogisticType(logisticType) {
  switch (logisticType) {
    case 'fulfillment': return 'FULL';
    case 'self_service': return 'FLEX';
    case 'cross_docking':
    case 'xd_drop_off':
    case 'drop_off': return 'COLECTA';
    default: return logisticType || 'DESCONOCIDO';
  }
}

function authHeaders(token) {
  return token ? { Authorization: 'Bearer ' + token } : {};
}

// Extrae el codigo de publicacion (MLA123456789) de un link completo
// (ej: articulo.mercadolibre.com.ar/MLA-123456789-titulo, con guion en la URL)
// o de un codigo pegado tal cual (sin guion).
export function parseItemId(input) {
  const m = String(input || '').toUpperCase().match(/MLA-?\d+/);
  return m ? m[0].replace('-', '') : null;
}

// IMPORTANTE: /sites/{site}/search (busqueda por nickname o seller_id) devuelve
// 403 desde 2025 incluso con token valido - es una restriccion de ML, confirmada
// contra la API real y reportada por otros desarrolladores. Por eso NO enumeramos
// el catalogo completo de un competidor; en cambio, se trackean publicaciones
// puntuales via el multi-get /items?ids=... (de a 20, mismo patron que ya usa
// el resto del panel en fetchMLData/loadSinStock), que si sigue funcionando.
export async function mlGetItemsByIds(ids, token) {
  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20).join(',');
    const url = `${ML_BASE}/items?ids=${batch}&attributes=id,title,price,sold_quantity,seller_id,shipping,status`;
    const r = await fetch(url, { headers: authHeaders(token) });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`ML items fallo (${r.status}): ${body.slice(0, 300)}`);
    }
    const data = await r.json();
    for (const entry of data) {
      if (entry.code === 200) out.push(entry.body);
    }
  }
  return out;
}
