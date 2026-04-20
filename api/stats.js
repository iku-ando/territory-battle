export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { group_id, start, end } = req.query;
  const params = new URLSearchParams();
  if (group_id) params.append('group_id', group_id);
  if (start) params.append('start', start);
  if (end) params.append('end', end);

  try {
    const upstream = await fetch(
      `http://ec2-54-160-151-114.compute-1.amazonaws.com/group-stats.php?${params}`
    );
    const data = await upstream.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
