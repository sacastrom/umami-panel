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

// Endpoint publico de busqueda, sin token de aplicacion.
export async function mlResolveSellerIdByNickname(nickname) {
  const url = `${ML_BASE}/sites/MLA/search?nickname=${encodeURIComponent(nickname)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ML search fallo (${r.status})`);
  const data = await r.json();
  const first = data.results?.[0];
  if (!first?.seller?.id) return null;
  return { sellerId: String(first.seller.id), nickname: first.seller.nickname || nickname };
}

export async function mlSearchSellerPage(sellerId, offset, limit = 50) {
  const url = `${ML_BASE}/sites/MLA/search?seller_id=${encodeURIComponent(sellerId)}&offset=${offset}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ML search fallo (${r.status})`);
  return r.json(); // { results: [...], paging: { total, offset, limit } }
}
