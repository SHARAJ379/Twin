<?php
// A minimal PHP app, deliberately broken the way a vibe-coded app commonly
// is: it works perfectly as one process on localhost, and silently loses
// data the moment more than one instance is running. PHP's built-in server
// re-executes this script per request, so "process memory" was never an
// option here - the bug is state written to this instance's own local disk.

$uploadDir = __DIR__ . '/uploads';   // BROKEN: workspace-relative, not shared
$sessionDir = __DIR__ . '/sessions'; // BROKEN: workspace-relative, not shared
$itemsFile = __DIR__ . '/items.json'; // BROKEN: workspace-relative, not shared
foreach ([$uploadDir, $sessionDir] as $dir) {
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

function require_session(string $sessionDir): ?string {
    $sid = $_COOKIE['sid'] ?? null;
    if (!$sid) return null;
    $path = $sessionDir . '/' . basename($sid) . '.json';
    if (!file_exists($path)) return null;
    $data = json_decode(file_get_contents($path), true);
    return $data['email'] ?? null;
}

function read_items(string $itemsFile): array {
    if (!file_exists($itemsFile)) return [];
    $data = json_decode(file_get_contents($itemsFile), true);
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
    $sid = bin2hex(random_bytes(16));
    file_put_contents($sessionDir . '/' . $sid . '.json', json_encode(['email' => $body['email']])); // BROKEN: local file write
    setcookie('sid', $sid, ['httponly' => true, 'path' => '/']);
    json_response(200, ['email' => $body['email']]);
}

if ($method === 'GET' && $path === '/me') {
    $email = require_session($sessionDir);
    if (!$email) json_response(401, ['error' => 'not authenticated']);
    json_response(200, ['email' => $email]);
}

if ($method === 'POST' && $path === '/items') {
    if (!require_session($sessionDir)) json_response(401, ['error' => 'not authenticated']);
    $body = read_json_body();
    if (empty($body['name'])) json_response(400, ['error' => 'name required']);
    $item = ['id' => bin2hex(random_bytes(16)), 'name' => $body['name']];
    $items = read_items($itemsFile);
    $items[] = $item;
    file_put_contents($itemsFile, json_encode($items)); // BROKEN: local file write, not env-configured
    json_response(201, $item);
}

if ($method === 'GET' && preg_match('#^/items/([^/]+)$#', $path, $m)) {
    if (!require_session($sessionDir)) json_response(401, ['error' => 'not authenticated']);
    foreach (read_items($itemsFile) as $item) {
        if ($item['id'] === $m[1]) json_response(200, $item);
    }
    json_response(404, ['error' => 'not found']);
}

if ($method === 'POST' && $path === '/upload') {
    if (!require_session($sessionDir)) json_response(401, ['error' => 'not authenticated']);
    if (empty($_FILES['file'])) json_response(400, ['error' => 'file required']);
    $filename = bin2hex(random_bytes(16)) . '-' . basename($_FILES['file']['name']);
    move_uploaded_file($_FILES['file']['tmp_name'], $uploadDir . '/' . $filename); // BROKEN: local uploads dir
    json_response(201, ['filename' => $filename]);
}

if ($method === 'GET' && preg_match('#^/uploads/([^/]+)$#', $path, $m)) {
    if (!require_session($sessionDir)) json_response(401, ['error' => 'not authenticated']);
    $safeName = basename($m[1]); // no path traversal, even in a broken demo app
    $filePath = $uploadDir . '/' . $safeName;
    if (!file_exists($filePath)) json_response(404, ['error' => 'not found']);
    http_response_code(200);
    header('Content-Type: application/octet-stream');
    readfile($filePath);
    exit;
}

json_response(404, ['error' => 'not found']);
