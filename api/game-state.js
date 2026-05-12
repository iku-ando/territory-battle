// Vercel KV (Upstash) REST API を使用。npm パッケージ不要。
// 環境変数 KV_REST_API_URL / KV_REST_API_TOKEN は
// Vercel ダッシュボード → Storage → KV で作成・リンクすると自動設定される。

const KV_KEY = 'territory-battle-state';

async function kvGet() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${KV_KEY}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    if (!j.result) return null;
    return JSON.parse(j.result);
  } catch (e) { return null; }
}

async function kvSet(value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  try {
    const r = await fetch(`${url}/set/${KV_KEY}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(JSON.stringify(value)), // Upstash は文字列として保存
    });
    const j = await r.json();
    return j.result === 'OK';
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KV_REST_API_URL) {
    return res.status(503).json({ success: false, error: 'KV not configured. Set up Vercel KV in dashboard.' });
  }

  try {
    if (req.method === 'POST') {
      const data = req.body;
      data.updated_at = new Date().toISOString();
      const ok = await kvSet(data);
      return res.status(200).json({ success: ok });
    } else {
      const data = await kvGet();
      if (!data) return res.status(200).json({ success: false, error: 'No saved state' });
      return res.status(200).json({ success: true, data });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
