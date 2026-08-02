import { getSupabaseAdmin, setCors } from '../_lib/supabaseAdmin.js';
import { mlResolveSellerIdByNickname } from '../_lib/mercadolibre.js';

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

    let resuelto;
    try {
      resuelto = await mlResolveSellerIdByNickname(nickname);
    } catch (e) {
      return res.status(502).json({ error: 'Error consultando Mercado Libre: ' + e.message });
    }
    if (!resuelto) {
      return res.status(422).json({ error: 'No se pudo resolver seller_id para ese nickname (sin publicaciones activas indexadas)' });
    }

    const { data, error } = await supa
      .from('competidores')
      .insert({ nickname: resuelto.nickname, seller_id: resuelto.sellerId })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: 'Metodo no permitido' });
}
