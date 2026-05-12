const EC2_URL = 'http://ec2-54-160-151-114.compute-1.amazonaws.com/game-state.php';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      const body = JSON.stringify(req.body);
      const r = await fetch(EC2_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await r.json();
      return res.status(200).json(data);
    } else {
      const r = await fetch(EC2_URL);
      const data = await r.json();
      return res.status(200).json(data);
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
