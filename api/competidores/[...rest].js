import { getSupabaseAdmin, setCors } from '../_lib/supabaseAdmin.js';
import { mlSearchSellerPage, mapLogisticType } from '../_lib/mercadolibre.js';

// Consolida items / [id] (DELETE) / [id]/sync (POST) en una sola funcion.
// Vercel Hobby limita a 12 Serverless Functions por deployment.

const PAGE_LIMIT = 50;
const HARD_CAP_OFFSET = 1000; // ML no garantiza scroll confiable mas alla de esto via offset/limit
const THROTTLE_MS = 250;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rest = Array.isArray(req.query.rest) ? req.query.rest : [];

  if (rest.length === 1 && rest[0] === 'items') return handleItems(req, res);
  if (rest.length === 1) return handleDelete(req, res, rest[0]);
  if (rest.length === 2 && rest[1] === 'sync') return handleSync(req, res, rest[0]);

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

async function handleSync(req, res, id) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Metodo no permitido' });
  }

  const supa = getSupabaseAdmin();
  const { data: competidor, error: errCompetidor } = await supa
    .from('competidores')
    .select('*')
    .eq('id', id)
    .single();
  if (errCompetidor || !competidor) return res.status(404).json({ error: 'Competidor no encontrado' });
  if (!competidor.seller_id) return res.status(400).json({ error: 'Competidor sin seller_id' });

  const today = new Date().toISOString().slice(0, 10);
  let offset = 0;
  let total = Infinity;
  const rows = [];

  try {
    while (offset < total && offset < HARD_CAP_OFFSET) {
      const page = await mlSearchSellerPage(competidor.seller_id, offset, PAGE_LIMIT);
      total = page.paging?.total ?? 0;
      for (const item of page.results || []) {
        rows.push({
          competidor_id: id,
          item_id: item.id,
          titulo: item.title,
          precio: item.price,
          sold_quantity: item.sold_quantity ?? 0,
          envio_tipo: mapLogisticType(item.shipping?.logistic_type),
          fecha_snapshot: today,
        });
      }
      offset += PAGE_LIMIT;
      if (offset < total && offset < HARD_CAP_OFFSET) {
        await new Promise(r => setTimeout(r, THROTTLE_MS));
      }
    }
  } catch (e) {
    return res.status(502).json({ error: 'Error consultando Mercado Libre: ' + e.message });
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supa
      .from('competidor_items')
      .upsert(rows.slice(i, i + 500), { onConflict: 'competidor_id,item_id,fecha_snapshot' });
    if (error) return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    ok: true,
    competidor: competidor.nickname,
    items: rows.length,
    total_reportado_por_ml: total,
    fecha_snapshot: today,
  });
}
