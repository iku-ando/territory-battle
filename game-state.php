<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }
// /tmp は常に書き込み可能。EC2再起動で消えるが通常は問題なし
$stateFile = '/tmp/game-state.json';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = file_get_contents('php://input');
    $data = json_decode($body, true);
    if ($data === null) { echo json_encode(['success' => false, 'error' => 'Invalid JSON']); exit; }
    $data['updated_at'] = date('Y-m-d H:i:s');
    $ok = file_put_contents($stateFile, json_encode($data));
    echo json_encode(['success' => ($ok !== false)]);
} else {
    if (!file_exists($stateFile)) { echo json_encode(['success' => false, 'error' => 'No saved state']); exit; }
    $raw = file_get_contents($stateFile);
    $data = json_decode($raw, true);
    echo json_encode(['success' => true, 'data' => $data]);
}
