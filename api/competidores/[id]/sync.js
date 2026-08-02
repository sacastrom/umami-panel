import { getSupabaseAdmin, setCors } from '../../_lib/supabaseAdmin.js';
import { mlSearchSellerPage, mapLogisticType } from '../../_lib/mercadolibre.js';

const PAGE_LIMIT = 50;
const HARD_CAP_OFFSET = 1000; // ML no garantiza scroll confiable mas alla de esto via offset/limit
const THROTTLE_MS = 250;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Metodo no permitido' });
  }

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Falta id' });

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
