// jsonblob.com を永続ストレージとして使用（無料・設定不要）
const BLOB_URL = process.env.GAME_STATE_BLOB_URL || 'https://jsonblob.com/api/jsonBlob/019e2fb9-da82-74a2-afd2-f3b7379d40c0';
const BACKUP_BLOB_URL = process.env.GAME_STATE_BACKUP_BLOB_URL || 'https://jsonblob.com/api/jsonBlob/019e302d-0420-7932-8a87-b41a0dfbf5b5';
const PT_PER = 80;
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_BACKUPS = 48;

async function loadCurrentState() {
  const r = await fetch(BLOB_URL, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) return null;
  return r.json();
}

function normalizeGameState(data, current) {
  if (!data || data._reset) return data;
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
  repairZeroAwardState(data);
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

function stripBackups(data) {
  if (!data || typeof data !== 'object') return data;
  const copy = JSON.parse(JSON.stringify(data));
  delete copy._backups;
  return copy;
}

function validBackups(backups) {
  return Array.isArray(backups)
    ? backups.filter((b) => b && b.id && b.savedAt && b.state && b.state.board && b.state.teams)
    : [];
}

async function loadBackupEntries(current) {
  const fallback = validBackups(current && current._backups);
  try {
    const r = await fetch(BACKUP_BLOB_URL, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return fallback;
    const json = await r.json();
    const stored = validBackups(Array.isArray(json) ? json : json.backups);
    if (!stored.length) return fallback;
    const seen = new Set();
    return [...stored, ...fallback].filter((b) => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    }).slice(0, MAX_BACKUPS);
  } catch (e) {
    return fallback;
  }
}

async function saveBackupEntries(backups) {
  const clean = validBackups(backups).slice(0, MAX_BACKUPS);
  await fetch(BACKUP_BLOB_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ backups: clean, updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

function createBackupEntry(state, savedAt, reason) {
  if (!state || state._reset || !state.board || !state.teams) return null;
  const clean = stripBackups(state);
  return {
    id: savedAt,
    savedAt,
    reason,
    gameDate: clean.gameDate || clean.debugDate || clean.lastDate || '',
    teamPts: clean.teams.map((t) => Number(t && t.pts || 0)),
    state: clean,
  };
}

function attachPeriodicBackup(data, current, nowIso, backups) {
  backups = validBackups(backups);
  if (!current || current._reset || !current.board || !current.teams) {
    data._backups = backups.slice(0, MAX_BACKUPS);
    return;
  }

  const lastBackupAt = backups.length ? Date.parse(backups[0].savedAt) : 0;
  const shouldBackup = !lastBackupAt || Date.parse(nowIso) - lastBackupAt >= BACKUP_INTERVAL_MS;
  const entry = shouldBackup
    ? createBackupEntry(current, nowIso, 'periodic')
    : null;

  data._backups = (entry ? [entry, ...backups] : backups).slice(0, MAX_BACKUPS);
}

function backupList(data) {
  return validBackups(data && data._backups).map((b) => ({
    id: b.id,
    savedAt: b.savedAt,
    reason: b.reason || 'periodic',
    gameDate: b.gameDate || '',
    teamPts: Array.isArray(b.teamPts) ? b.teamPts : [],
  }));
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
      const backups = await loadBackupEntries(current);
      if (data && data._restoreBackup) {
        const target = backups.find((b) => b.id === data._restoreBackup);
        if (!target) {
          return res.status(404).json({ success: false, error: 'backup not found' });
        }
        const nowIso = new Date().toISOString();
        const beforeRestore = createBackupEntry(current, nowIso, 'before-restore');
        const restored = stripBackups(target.state);
        restored._backups = (beforeRestore ? [beforeRestore, ...backups] : backups).slice(0, MAX_BACKUPS);
        restored._restoredFromBackup = target.id;
        restored.updated_at = nowIso;
        const r = await fetch(BLOB_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(restored),
        });
        if (!r.ok) throw new Error('blob restore failed: ' + r.status);
        await saveBackupEntries(restored._backups);
        return res.status(200).json({ success: true, data: restored, backups: backupList(restored) });
      }
      if (isInvalidDateWrite(data, current)) {
        return res.status(409).json({ success: false, error: 'stale or invalid game-date write rejected' });
      }
      normalizeGameState(data, current);
      if (isPointRollbackWrite(data, current)) {
        return res.status(409).json({ success: false, error: 'point rollback write rejected' });
      }
      if (isUnexpectedPointIncreaseWrite(data, current)) {
        return res.status(409).json({ success: false, error: 'same-day point increase write rejected' });
      }
      const nowIso = new Date().toISOString();
      attachPeriodicBackup(data, current, nowIso, backups);
      data.updated_at = nowIso;
      const r = await fetch(BLOB_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error('blob write failed: ' + r.status);
      await saveBackupEntries(data._backups);
      return res.status(200).json({ success: true, backups: backupList(data) });
    } else {
      const r = await fetch(BLOB_URL, {
        headers: { 'Accept': 'application/json' },
      });
      const data = r.ok ? await r.json() : null;
      const backups = await loadBackupEntries(data);
      if (req.query && req.query.backups === '1') {
        return res.status(200).json({ success: true, backups: backupList({ _backups: backups }) });
      }
      if (!data) return res.status(200).json({ success: false, error: 'No saved state' });
      data._backups = backups;
      const repaired = repairZeroAwardState(data);
      if (repaired) {
        data.updated_at = new Date().toISOString();
        await fetch(BLOB_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(data),
        }).catch(() => {});
      }
      return res.status(200).json({ success: true, data });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
