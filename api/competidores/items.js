import { getSupabaseAdmin, setCors } from '../_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
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
