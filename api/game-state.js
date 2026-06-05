// Durable storage:
// 1. Vercel KV / Upstash Redis REST (recommended for production)
// 2. JSONBlob fallback (temporary only; blobs have disappeared during operation)
const STORAGE_KEY = process.env.GAME_STATE_KEY || 'territory-battle:game-state';
const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const LEGACY_BLOB_URL = process.env.GAME_STATE_BLOB_URL || 'https://jsonblob.com/api/jsonBlob/019e3d9a-f01b-71a5-9719-1d90e4778bde';
const REQUIRE_DURABLE_STORE =
  process.env.REQUIRE_DURABLE_GAME_STATE === '1' ||
  (process.env.VERCEL === '1' && process.env.ALLOW_LEGACY_GAME_STATE !== '1');
const BACKUP_LIST_KEY = `${STORAGE_KEY}:backups`;
const BACKUP_KEY_PREFIX = `${STORAGE_KEY}:backup:`;
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_BACKUPS = 72;
const PT_PER = 80;

function hasDurableStore() {
  return !!(KV_REST_API_URL && KV_REST_API_TOKEN);
}

async function kvCommand(command) {
  const r = await fetch(KV_REST_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error('kv command failed: ' + r.status);
  const json = await r.json();
  if (json && json.error) throw new Error('kv command failed: ' + json.error);
  return json ? json.result : null;
}

async function loadFromDurableStore() {
  if (!hasDurableStore()) return null;
  const raw = await kvCommand(['GET', STORAGE_KEY]);
  if (!raw) return null;
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  removeLegacySnapshotMetadata(data);
  return data;
}

async function saveToDurableStore(data) {
  if (!hasDurableStore()) return false;
  await kvCommand(['SET', STORAGE_KEY, JSON.stringify(data)]);
  return true;
}

async function loadFromLegacyBlob() {
  const r = await fetch(LEGACY_BLOB_URL, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) return null;
  const data = await r.json();
  removeLegacySnapshotMetadata(data);
  return data;
}

async function saveToLegacyBlob(data) {
  const r = await fetch(LEGACY_BLOB_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error('legacy blob write failed: ' + r.status);
}

async function loadCurrentState() {
  const durable = await loadFromDurableStore();
  if (durable) return durable;

  const legacy = await loadFromLegacyBlob().catch(() => null);
  if (legacy && hasDurableStore()) {
    await saveToDurableStore(legacy).catch(() => {});
  }
  return legacy;
}

async function saveCurrentState(data) {
  if (await saveToDurableStore(data)) return 'kv';
  if (REQUIRE_DURABLE_STORE) {
    throw new Error('durable game state storage is not configured');
  }
  await saveToLegacyBlob(data);
  return 'legacy-jsonblob';
}

function isBackupableState(data) {
  return !!(data && !data._reset && data.board && data.teams);
}

async function loadBackupList() {
  if (!hasDurableStore()) return [];
  const rows = await kvCommand(['LRANGE', BACKUP_LIST_KEY, 0, MAX_BACKUPS - 1]);
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    try {
      return typeof row === 'string' ? JSON.parse(row) : row;
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

async function saveBackupSnapshot(data, reason = 'auto') {
  if (!hasDurableStore() || !isBackupableState(data)) return null;
  const now = new Date();
  const key = BACKUP_KEY_PREFIX + now.toISOString();
  const snapshot = JSON.parse(JSON.stringify(data));
  snapshot._backupCreatedAt = now.toISOString();
  snapshot._backupReason = reason;
  await kvCommand(['SET', key, JSON.stringify(snapshot)]);
  const cells = Array.isArray(data.board)
    ? data.board.reduce((sum, row) => sum + row.filter((cell) => cell >= 0).length, 0)
    : 0;
  const meta = {
    key,
    created_at: now.toISOString(),
    reason,
    gameDate: data.gameDate || data.debugDate || data.lastDate || '',
    lastAwardDate: data.lastAwardDate || '',
    cells,
  };
  await kvCommand(['LPUSH', BACKUP_LIST_KEY, JSON.stringify(meta)]);
  await kvCommand(['LTRIM', BACKUP_LIST_KEY, 0, MAX_BACKUPS - 1]);
  return meta;
}

async function createHourlyBackupIfNeeded(current, incoming) {
  if (!hasDurableStore()) return null;
  const target = isBackupableState(current) ? current : incoming;
  if (!isBackupableState(target)) return null;
  const backups = await loadBackupList().catch(() => []);
  const latest = backups[0];
  const latestAt = latest && Date.parse(latest.created_at || '');
  if (latestAt && Date.now() - latestAt < BACKUP_INTERVAL_MS) return null;
  return saveBackupSnapshot(target, backups.length ? 'hourly' : 'initial');
}

async function restoreBackup(key, current) {
  if (!hasDurableStore()) throw new Error('durable game state storage is not configured');
  if (!key || typeof key !== 'string' || !key.startsWith(BACKUP_KEY_PREFIX)) {
    throw new Error('invalid backup key');
  }
  const raw = await kvCommand(['GET', key]);
  if (!raw) throw new Error('backup not found');
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  removeLegacySnapshotMetadata(data);
  data._restoredFromBackup = key;
  data.updated_at = new Date().toISOString();
  await saveBackupSnapshot(current, 'before-restore').catch(() => {});
  await saveToDurableStore(data);
  return data;
}

function removeLegacySnapshotMetadata(data) {
  if (!data || typeof data !== 'object') return data;
  delete data._backups;
  delete data._backupHeartbeatAt;
  delete data._restoredFromBackup;
  return data;
}

function normalizeGameState(data, current) {
  if (!data || data._reset) return data;
  removeLegacySnapshotMetadata(data);
  if (!data.board || !data.teams) return data;

  const gameDate =
    data.gameDate ||
    (data.debugMode && data.debugDate) ||
    (current && current.gameStart === data.gameStart && current.gameDate) ||
    data.gameStart ||
    data.lastDate ||
    data.debugDate;

  if (gameDate) {
    data.gameDate = gameDate;
    data.lastDate = gameDate;
    data.debugDate = gameDate;
  }
  data.awardedDates = data.awardedDates || {};
  if (data.lastAwardDate) data.awardedDates[data.lastAwardDate] = true;
  return data;
}

function inferAwardedPoints(team) {
  const mins = Number(team.talkMins || 0);
  const carry = Number(team.talkCarry ?? team.carry ?? 0);
  if (mins <= 0) return 0;
  for (let pts = 0; pts <= 24; pts += 1) {
    const previousCarry = pts * PT_PER + carry - mins;
    if (previousCarry >= 0 && previousCarry < PT_PER) return pts;
  }
  return Math.max(0, Math.floor(mins / PT_PER));
}

function repairZeroAwardState(data) {
  if (!data || !data.teams || !data.lastAwardDate) return false;
  const allPtsZero = data.teams.every((t) => (t.pts || 0) <= 0);
  const allAwardZero = data.teams.every((t) => (t.awardedToday || 0) <= 0);
  const hasTalkData = data.teams.some((t) => (t.talkMins || 0) > 0);
  if (!allPtsZero || !allAwardZero || !hasTalkData) return false;

  let repaired = false;
  data.teams.forEach((team) => {
    const awarded = inferAwardedPoints(team);
    if (awarded > 0) {
      team.awardedToday = awarded;
      team.pts = awarded;
      repaired = true;
    }
  });
  if (repaired) {
    data._repairedZeroPtsAt = new Date().toISOString();
  }
  return repaired;
}

function isInvalidDateWrite(data, current) {
  if (!data || data._reset || !data.board || !data.teams) return false;
  if (current && current._savedAt && data._savedAt && data._savedAt < current._savedAt) {
    return true;
  }
  const gameDate =
    data.gameDate ||
    (data.debugMode && data.debugDate) ||
    (current && current.gameStart === data.gameStart && current.gameDate) ||
    data.gameStart ||
    data.lastDate ||
    data.debugDate;
  if (!gameDate || !data.lastAwardDate) return false;
  if (data.lastAwardDate === gameDate) return false;
  const sameGame = current && current.gameStart === data.gameStart;
  const currentGameDate = current && (current.gameDate || current.debugDate || current.lastDate);
  return sameGame && currentGameDate && data.lastAwardDate !== currentGameDate;
}

function isStaleBaseWrite(data, current) {
  if (!data || data._reset || !data.board || !data.teams || !current || !current.board || !current.teams) {
    return false;
  }
  if (data._restoreBackup) return false;
  if (data.gameStart && current.gameStart && data.gameStart !== current.gameStart) return false;
  const currentUpdatedAt = current.updated_at || '';
  if (!currentUpdatedAt) return false;
  const baseUpdatedAt = data._baseUpdatedAt || data.updated_at || '';
  return !baseUpdatedAt || baseUpdatedAt !== currentUpdatedAt;
}

function isPointRollbackWrite(data, current) {
  if (!data || data._reset || !data.board || !data.teams || !current || !current.board || !current.teams) {
    return false;
  }
  const dataDate = data.gameDate || data.debugDate || data.lastDate;
  const currentDate = current.gameDate || current.debugDate || current.lastDate;
  if (!dataDate || dataDate !== currentDate) return false;
  if (data.gameStart && current.gameStart && data.gameStart !== current.gameStart) return false;
  if (data.lastAwardDate === dataDate && current.lastAwardDate !== currentDate) return false;

  const sameBoard = JSON.stringify(data.board) === JSON.stringify(current.board);
  if (!sameBoard) return false;

  const currentHasPoints = current.teams.some((t) => (t.pts || 0) > 0);
  const incomingAllZero = data.teams.every((t) => (t.pts || 0) <= 0);
  if (currentHasPoints && incomingAllZero) return true;

  const currentAwarded = current.teams.some((t) => (t.awardedToday || 0) > 0);
  const incomingAwardZero = data.teams.every((t) => (t.awardedToday || 0) <= 0);
  if (currentAwarded && incomingAwardZero) return true;

  return false;
}

function isUnexpectedPointIncreaseWrite(data, current) {
  if (!data || data._reset || !data.board || !data.teams || !current || !current.board || !current.teams) {
    return false;
  }
  const dataDate = data.gameDate || data.debugDate || data.lastDate;
  const currentDate = current.gameDate || current.debugDate || current.lastDate;
  if (!dataDate || dataDate !== currentDate) return false;
  if (data.gameStart && current.gameStart && data.gameStart !== current.gameStart) return false;
  if (data.lastAwardDate === dataDate && current.lastAwardDate !== currentDate) return false;

  const sameBoard = JSON.stringify(data.board) === JSON.stringify(current.board);
  if (!sameBoard) return false;

  return data.teams.some((team, i) => {
    const incomingPts = Number(team && team.pts || 0);
    const currentPts = Number(current.teams[i] && current.teams[i].pts || 0);
    return incomingPts > currentPts;
  });
}

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
      const current = await loadCurrentState().catch(() => null);
      if (data && data._restoreBackup) {
        const restored = await restoreBackup(data._restoreBackup, current);
        return res.status(200).json({ success: true, data: restored, storage: 'kv' });
      }
      if (isInvalidDateWrite(data, current)) {
        return res.status(409).json({ success: false, error: 'stale or invalid game-date write rejected' });
      }
      if (isStaleBaseWrite(data, current)) {
        return res.status(409).json({ success: false, error: 'stale game-state write rejected' });
      }
      normalizeGameState(data, current);
      if (isPointRollbackWrite(data, current)) {
        return res.status(409).json({ success: false, error: 'point rollback write rejected' });
      }
      if (isUnexpectedPointIncreaseWrite(data, current)) {
        return res.status(409).json({ success: false, error: 'same-day point increase write rejected' });
      }
      data.updated_at = new Date().toISOString();
      await createHourlyBackupIfNeeded(current, data).catch(() => {});
      const storage = await saveCurrentState(data);
      return res.status(200).json({ success: true, storage, updated_at: data.updated_at });
    } else {
      if (req.query && req.query.backups === '1') {
        const backups = await loadBackupList();
        return res.status(200).json({ success: true, backups, storage: hasDurableStore() ? 'kv' : 'legacy-jsonblob' });
      }
      const data = await loadCurrentState();
      if (!data) return res.status(200).json({ success: false, error: 'No saved state' });
      return res.status(200).json({ success: true, data, storage: hasDurableStore() ? 'kv' : 'legacy-jsonblob' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
