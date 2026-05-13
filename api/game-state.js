// jsonblob.com を永続ストレージとして使用（無料・設定不要）
const BLOB_URL = 'https://jsonblob.com/api/jsonBlob/019e20d9-7a39-71a3-b4eb-8983a660e2c5';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      const data = req.body;
      data.updated_at = new Date().toISOString();
      const r = await fetch(BLOB_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error('blob write failed: ' + r.status);
      return res.status(200).json({ success: true });
    } else {
      const r = await fetch(BLOB_URL, {
        headers: { 'Accept': 'application/json' },
      });
      if (!r.ok) return res.status(200).json({ success: false, error: 'No saved state' });
      const data = await r.json();
      return res.status(200).json({ success: true, data });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
