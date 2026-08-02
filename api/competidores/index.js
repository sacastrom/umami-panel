import { getSupabaseAdmin, setCors } from '../_lib/supabaseAdmin.js';

// El nickname ya no se valida contra ML al crear el competidor (el endpoint de
// busqueda por nickname esta bloqueado - ver api/_lib/mercadolibre.js). El
// seller_id se completa solo cuando se trackea la primera publicacion
// (ver [...rest].js -> handleAddItem).

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supa = getSupabaseAdmin();

  if (req.method === 'GET') {
    const { data, error } = await supa
      .from('competidores')
      .select('*')
      .order('fecha_alta', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const nickname = String(req.body?.nickname || '').trim();
    if (!nickname) return res.status(400).json({ error: 'Falta nickname' });

    const { data: existente } = await supa
      .from('competidores')
      .select('id')
      .eq('nickname', nickname)
      .maybeSingle();
    if (existente) return res.status(409).json({ error: 'Ese competidor ya esta cargado' });

    const { data, error } = await supa
      .from('competidores')
      .insert({ nickname, seller_id: null })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: 'Metodo no permitido' });
}
