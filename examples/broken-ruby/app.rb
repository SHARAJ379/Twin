# A minimal HTTP app built on raw TCPServer (no gems - WEBrick isn't a
# default gem since Ruby 3.0, and this keeps the fixture dependency-free).
# Deliberately broken the way a vibe-coded app commonly is: it works
# perfectly as one process on localhost, and silently loses data the moment
# more than one instance is running.
require "json"
require "securerandom"
require "socket"

PORT = (ENV["PORT"] || "3000").to_i
UPLOAD_DIR = File.join(__dir__, "uploads") # BROKEN: relative to the app dir, lands on this instance's own local disk only
Dir.mkdir(UPLOAD_DIR) unless Dir.exist?(UPLOAD_DIR)

# BROKEN: both live only in this process's memory. A second instance (or a
# restart of this one) starts with these empty - that's the bug Twin finds.
$sessions = {} # sessionId -> email
$items = []    # { id:, name: }

def json_response(status, body)
  [status, { "Content-Type" => "application/json" }, JSON.generate(body)]
end

def parse_cookies(header)
  return {} unless header
  header.split(";").each_with_object({}) do |pair, acc|
    k, v = pair.strip.split("=", 2)
    acc[k] = v if k
  end
end

def session_email(cookies)
  $sessions[cookies["sid"]]
end

def parse_multipart(body, boundary)
  parts = body.split("--#{boundary}")
  parts.each do |part|
    next unless part.include?("Content-Disposition")
    header_end = part.index("\r\n\r\n")
    next unless header_end
    headers = part[0...header_end]
    content = part[(header_end + 4)...]
    content = content.chomp("\r\n") if content
    next unless headers.include?('name="file"')
    filename = headers[/filename="([^"]*)"/, 1] || "upload"
    return { filename: filename, content: content }
  end
  nil
end

def handle(client)
  request_line = client.gets
  return unless request_line
  method, path, = request_line.split(" ")

  headers = {}
  while (line = client.gets) && line != "\r\n"
    key, value = line.split(":", 2)
    headers[key.strip.downcase] = value.strip if key
  end

  body = ""
  if (len = headers["content-length"])
    body = client.read(len.to_i) || ""
  end

  cookies = parse_cookies(headers["cookie"])
  status, resp_headers, resp_body = route(method, path, headers, body, cookies)

  client.print "HTTP/1.1 #{status} X\r\n"
  resp_headers.each { |k, v| client.print "#{k}: #{v}\r\n" }
  client.print "Content-Length: #{resp_body.bytesize}\r\n"
  client.print "Connection: close\r\n\r\n"
  client.print resp_body
rescue StandardError => e
  warn "request error: #{e}"
ensure
  client.close
end

def route(method, path, headers, body, cookies)
  case [method, path]
  in ["GET", "/health"]
    [200, {}, ""]
  in ["POST", "/signup"]
    data = JSON.parse(body)
    return json_response(400, { error: "email and password required" }) if data["email"].nil? || data["password"].nil?
    json_response(201, { email: data["email"] })
  in ["POST", "/login"]
    data = JSON.parse(body)
    return json_response(400, { error: "email and password required" }) if data["email"].nil? || data["password"].nil?
    sid = SecureRandom.hex(16)
    $sessions[sid] = data["email"]
    status, h, b = json_response(200, { email: data["email"] })
    [status, h.merge("Set-Cookie" => "sid=#{sid}; HttpOnly; Path=/"), b]
  in ["GET", "/me"]
    email = session_email(cookies)
    return json_response(401, { error: "not authenticated" }) unless email
    json_response(200, { email: email })
  in ["POST", "/items"]
    email = session_email(cookies)
    return json_response(401, { error: "not authenticated" }) unless email
    data = JSON.parse(body)
    return json_response(400, { error: "name required" }) if data["name"].nil?
    item = { id: SecureRandom.hex(16), name: data["name"] }
    $items << item
    json_response(201, item)
  in ["GET", String => p] if p.start_with?("/items/")
    email = session_email(cookies)
    return json_response(401, { error: "not authenticated" }) unless email
    id = p.sub("/items/", "")
    item = $items.find { |i| i[:id] == id }
    return json_response(404, { error: "not found" }) unless item
    json_response(200, item)
  in ["POST", "/upload"]
    email = session_email(cookies)
    return json_response(401, { error: "not authenticated" }) unless email
    boundary = headers["content-type"][/boundary=(.+)$/, 1]
    file = boundary && parse_multipart(body, boundary)
    return json_response(400, { error: "file required" }) unless file
    filename = "#{SecureRandom.hex(16)}-#{File.basename(file[:filename])}"
    File.binwrite(File.join(UPLOAD_DIR, filename), file[:content]) # BROKEN: File.binwrite to a non-env-configured path
    json_response(201, { filename: filename })
  in ["GET", String => p] if p.start_with?("/uploads/")
    email = session_email(cookies)
    return json_response(401, { error: "not authenticated" }) unless email
    safe_name = File.basename(p.sub("/uploads/", "")) # no path traversal, even in a broken demo app
    file_path = File.join(UPLOAD_DIR, safe_name)
    return json_response(404, { error: "not found" }) unless File.exist?(file_path)
    [200, { "Content-Type" => "application/octet-stream" }, File.binread(file_path)]
  else
    json_response(404, { error: "not found" })
  end
end

server = TCPServer.new("127.0.0.1", PORT)
puts "broken-ruby listening on #{PORT}"
loop do
  client = server.accept
  Thread.new(client) { |c| handle(c) }
end
