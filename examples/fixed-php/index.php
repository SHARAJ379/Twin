<?php
// The same app as broken-php, with its three bugs actually fixed. The route
// shapes are identical on purpose - only where state lives changed.

$secret = getenv('SESSION_SECRET') ?: 'dev-secret-not-for-production';
$dataFile = getenv('DATA_FILE') ?: __DIR__ . '/data.json';
$uploadDir = getenv('UPLOAD_DIR') ?: __DIR__ . '/uploads';
foreach ([$uploadDir, dirname($dataFile)] as $dir) {
    if (!is_dir($dir)) mkdir($dir, 0777, true);
}

function json_response(int $status, array $body): void {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body);
    exit;
}

function read_json_body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

// FIXED: identity lives in a signed cookie, not a file on this instance's
// disk. Any instance given the same SESSION_SECRET can verify it, so login
// survives a switch.
function sign(string $secret, string $value): string {
    return $value . '.' . hash_hmac('sha256', $value, $secret);
}

function verify(string $secret, ?string $signed): ?string {
    if (!$signed) return null;
    $idx = strrpos($signed, '.');
    if ($idx === false) return null;
    $value = substr($signed, 0, $idx);
    $sig = substr($signed, $idx + 1);
    $expected = hash_hmac('sha256', $value, $secret);
    return hash_equals($expected, $sig) ? $value : null;
}

function require_session(string $secret): ?string {
    return verify($secret, $_COOKIE['sid'] ?? null);
}

// FIXED: items live at $dataFile - point every instance at the same shared
// path and they all see the same data. Plain read-modify-write, no
// cross-process locking: fine for a demo app, not a production-grade store.
function read_items(string $dataFile): array {
    if (!file_exists($dataFile)) return [];
    $data = json_decode(file_get_contents($dataFile), true);
    return is_array($data) ? $data : [];
}

$method = $_SERVER['REQUEST_METHOD'];
$path = strtok($_SERVER['REQUEST_URI'], '?');

if ($method === 'GET' && $path === '/health') {
    http_response_code(200);
    exit;
}

if ($method === 'POST' && $path === '/signup') {
    $body = read_json_body();
    if (empty($body['email']) || empty($body['password'])) {
        json_response(400, ['error' => 'email and password required']);
    }
    json_response(201, ['email' => $body['email']]);
}

if ($method === 'POST' && $path === '/login') {
    $body = read_json_body();
    if (empty($body['email']) || empty($body['password'])) {
        json_response(400, ['error' => 'email and password required']);
    }
    setcookie('sid', sign($secret, $body['email']), ['httponly' => true, 'path' => '/']);
    json_response(200, ['email' => $body['email']]);
}

if ($method === 'GET' && $path === '/me') {
    $email = require_session($secret);
    if (!$email) json_response(401, ['error' => 'not authenticated']);
    json_response(200, ['email' => $email]);
}

if ($method === 'POST' && $path === '/items') {
    if (!require_session($secret)) json_response(401, ['error' => 'not authenticated']);
    $body = read_json_body();
    if (empty($body['name'])) json_response(400, ['error' => 'name required']);
    $item = ['id' => bin2hex(random_bytes(16)), 'name' => $body['name']];
    $items = read_items($dataFile);
    $items[] = $item;
    file_put_contents($dataFile, json_encode($items)); // FIXED: dataFile is a shared path, not local-only
    json_response(201, $item);
}

if ($method === 'GET' && preg_match('#^/items/([^/]+)$#', $path, $m)) {
    if (!require_session($secret)) json_response(401, ['error' => 'not authenticated']);
    foreach (read_items($dataFile) as $item) {
        if ($item['id'] === $m[1]) json_response(200, $item);
    }
    json_response(404, ['error' => 'not found']);
}

if ($method === 'POST' && $path === '/upload') {
    if (!require_session($secret)) json_response(401, ['error' => 'not authenticated']);
    if (empty($_FILES['file'])) json_response(400, ['error' => 'file required']);
    $filename = bin2hex(random_bytes(16)) . '-' . basename($_FILES['file']['name']);
    move_uploaded_file($_FILES['file']['tmp_name'], $uploadDir . '/' . $filename); // FIXED: uploadDir is a shared path
    json_response(201, ['filename' => $filename]);
}

if ($method === 'GET' && preg_match('#^/uploads/([^/]+)$#', $path, $m)) {
    if (!require_session($secret)) json_response(401, ['error' => 'not authenticated']);
    $safeName = basename($m[1]);
    $filePath = $uploadDir . '/' . $safeName;
    if (!file_exists($filePath)) json_response(404, ['error' => 'not found']);
    http_response_code(200);
    header('Content-Type: application/octet-stream');
    readfile($filePath);
    exit;
}

json_response(404, ['error' => 'not found']);
