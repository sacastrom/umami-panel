import { getSupabaseAdmin, setCors } from '../_lib/supabaseAdmin.js';
import { mlGetItemsByIds, mapLogisticType, parseItemId } from '../_lib/mercadolibre.js';

// Consolida items / [id] (DELETE) / [id]/items (POST) / [id]/sync (POST) en una
// sola funcion. Vercel Hobby limita a 12 Serverless Functions por deployment.

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rest = Array.isArray(req.query.rest) ? req.query.rest : [];

  if (rest.length === 1 && rest[0] === 'items') return handleItems(req, res);
  if (rest.length === 1) return handleDelete(req, res, rest[0]);
  if (rest.length === 2 && rest[1] === 'sync') return handleSync(req, res, rest[0]);
  if (rest.length === 2 && rest[1] === 'items') return handleAddItem(req, res, rest[0]);

  return res.status(404).json({ error: 'Ruta no encontrada' });
}

async function handleItems(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Metodo no permitido' });
  }

  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Falta ids' });

  const supa = getSupabaseAdmin();
  const out = [];

  for (const competidorId of ids) {
    const { data: ultimo } = await supa
      .from('competidor_items')
      .select('fecha_snapshot')
      .eq('competidor_id', competidorId)
      .order('fecha_snapshot', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!ultimo) continue;

    const { data: filas, error } = await supa
      .from('competidor_items')
      .select('*')
      .eq('competidor_id', competidorId)
      .eq('fecha_snapshot', ultimo.fecha_snapshot)
      .order('sold_quantity', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    out.push(...(filas || []));
  }

  return res.status(200).json(out);
}

async function handleDelete(req, res, id) {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE, OPTIONS');
    return res.status(405).json({ error: 'Metodo no permitido' });
  }
  const supa = getSupabaseAdmin();
  // competidor_items y matches_manuales se borran por ON DELETE CASCADE
  const { error } = await supa.from('competidores').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

// Trackea una publicacion puntual del competidor (link o codigo MLA...).
async function handleAddItem(req, res, competidorId) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Metodo no permitido' });
  }
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const itemId = parseItemId(req.body?.input);
  if (!itemId) {
    return res.status(400).json({ error: 'No se reconoce un codigo de publicacion (ej: MLA123456789) en lo que pegaste' });
  }

  const supa = getSupabaseAdmin();
  const { data: competidor, error: errCompetidor } = await supa
    .from('competidores')
    .select('*')
    .eq('id', competidorId)
    .single();
  if (errCompetidor || !competidor) return res.status(404).json({ error: 'Competidor no encontrado' });

  let items;
  try {
    items = await mlGetItemsByIds([itemId], token);
  } catch (e) {
    return res.status(502).json({ error: 'Error consultando Mercado Libre: ' + e.message });
  }
  const item = items[0];
  if (!item) return res.status(404).json({ error: 'No se encontro esa publicacion (puede estar pausada, eliminada, o el codigo esta mal)' });

  if (competidor.seller_id && String(item.seller_id) !== String(competidor.seller_id)) {
    return res.status(409).json({
      error: `Esa publicacion pertenece a otro vendedor (seller_id ${item.seller_id}), no a "${competidor.nickname}"`,
    });
  }
  if (!competidor.seller_id) {
    await supa.from('competidores').update({ seller_id: String(item.seller_id) }).eq('id', competidorId);
  }

  const today = new Date().toISOString().slice(0, 10);
  const { data: row, error } = await supa
    .from('competidor_items')
    .upsert({
      competidor_id: competidorId,
      item_id: item.id,
      titulo: item.title,
      precio: item.price,
      sold_quantity: item.sold_quantity ?? 0,
      envio_tipo: mapLogisticType(item.shipping?.logistic_type),
      fecha_snapshot: today,
    }, { onConflict: 'competidor_id,item_id,fecha_snapshot' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json(row);
}

// Refresca el snapshot de HOY para todas las publicaciones ya trackeadas de
// este competidor (no descubre publicaciones nuevas: eso se hace a mano con
// handleAddItem, porque la busqueda por seller_id esta bloqueada por ML).
async function handleSync(req, res, competidorId) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Metodo no permitido' });
  }
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const supa = getSupabaseAdmin();
  const { data: competidor, error: errCompetidor } = await supa
    .from('competidores')
    .select('*')
    .eq('id', competidorId)
    .single();
  if (errCompetidor || !competidor) return res.status(404).json({ error: 'Competidor no encontrado' });

  const { data: existentes, error: errExistentes } = await supa
    .from('competidor_items')
    .select('item_id')
    .eq('competidor_id', competidorId);
  if (errExistentes) return res.status(500).json({ error: errExistentes.message });

  const today = new Date().toISOString().slice(0, 10);
  const itemIds = [...new Set((existentes || []).map(r => r.item_id))];
  if (!itemIds.length) {
    return res.status(200).json({
      ok: true, competidor: competidor.nickname, items: 0, fecha_snapshot: today,
      nota: 'Todavia no trackeas ninguna publicacion de este competidor - usa el boton 📎',
    });
  }

  let items;
  try {
    items = await mlGetItemsByIds(itemIds, token);
  } catch (e) {
    return res.status(502).json({ error: 'Error consultando Mercado Libre: ' + e.message });
  }

  const rows = items.map(item => ({
    competidor_id: competidorId,
    item_id: item.id,
    titulo: item.title,
    precio: item.price,
    sold_quantity: item.sold_quantity ?? 0,
    envio_tipo: mapLogisticType(item.shipping?.logistic_type),
    fecha_snapshot: today,
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supa
      .from('competidor_items')
      .upsert(rows.slice(i, i + 500), { onConflict: 'competidor_id,item_id,fecha_snapshot' });
    if (error) return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ ok: true, competidor: competidor.nickname, items: rows.length, fecha_snapshot: today });
}
