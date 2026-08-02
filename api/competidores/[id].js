import { getSupabaseAdmin, setCors } from '../_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Falta id' });

  if (req.method === 'DELETE') {
    const supa = getSupabaseAdmin();
    // competidor_items y matches_manuales se borran por ON DELETE CASCADE
    const { error } = await supa.from('competidores').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'DELETE, OPTIONS');
  return res.status(405).json({ error: 'Metodo no permitido' });
}
