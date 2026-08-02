import { getSupabaseAdmin, setCors } from '../_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supa = getSupabaseAdmin();

  if (req.method === 'GET') {
    const { data, error } = await supa.from('matches_manuales').select('*');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { producto_sku, competidor_id, competidor_item_id } = req.body || {};
    if (!producto_sku || !competidor_id || !competidor_item_id) {
      return res.status(400).json({ error: 'Faltan producto_sku, competidor_id o competidor_item_id' });
    }
    const { data, error } = await supa
      .from('matches_manuales')
      .upsert(
        { producto_sku, competidor_id, competidor_item_id, updated_at: new Date().toISOString() },
        { onConflict: 'producto_sku,competidor_id' }
      )
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === 'DELETE') {
    const { producto_sku, competidor_id } = req.query;
    if (!producto_sku || !competidor_id) {
      return res.status(400).json({ error: 'Faltan producto_sku o competidor_id' });
    }
    const { error } = await supa
      .from('matches_manuales')
      .delete()
      .eq('producto_sku', producto_sku)
      .eq('competidor_id', competidor_id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
  return res.status(405).json({ error: 'Metodo no permitido' });
}
