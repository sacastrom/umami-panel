import { createSign } from 'node:crypto';

const FOLDER_ID = '1-S1H97R9MObFuvT802tRkNHtwLIZHomU';

async function googleToken(scope) {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!creds?.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no configurado');
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({
    iss: creds.client_email, scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
  })).toString('base64url');
  const s = createSign('RSA-SHA256');
  s.update(`${hdr}.${pay}`);
  const jwt = `${hdr}.${pay}.${s.sign(creds.private_key, 'base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Google token error: ' + JSON.stringify(d));
  return d.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = await googleToken('https://www.googleapis.com/auth/drive.readonly');
    const result = {};
    let pageToken = '';
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', `'${FOLDER_ID}' in parents and trashed = false`);
      url.searchParams.set('fields', 'nextPageToken,files(id,name)');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      for (const f of d.files || []) {
        result[f.name.replace(/\.[^.]+$/, '').trim().toUpperCase()] = f.id;
      }
      pageToken = d.nextPageToken || '';
    } while (pageToken);
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
