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

// ML bloquea (403) las llamadas no autenticadas a /search desde IPs de datacenter,
// asi que estas funciones necesitan el token del usuario logueado (mismo patron que api/ml.js).
function authHeaders(token) {
  return token ? { Authorization: 'Bearer ' + token } : {};
}

export async function mlResolveSellerIdByNickname(nickname, token) {
  const url = `${ML_BASE}/sites/MLA/search?nickname=${encodeURIComponent(nickname)}`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) throw new Error(`ML search fallo (${r.status})`);
  const data = await r.json();
  const first = data.results?.[0];
  if (!first?.seller?.id) return null;
  return { sellerId: String(first.seller.id), nickname: first.seller.nickname || nickname };
}

export async function mlSearchSellerPage(sellerId, offset, limit = 50, token) {
  const url = `${ML_BASE}/sites/MLA/search?seller_id=${encodeURIComponent(sellerId)}&offset=${offset}&limit=${limit}`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) throw new Error(`ML search fallo (${r.status})`);
  return r.json(); // { results: [...], paging: { total, offset, limit } }
}
