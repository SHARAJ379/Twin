# The same app as broken-ruby, with its three bugs actually fixed. The route
# shapes are identical on purpose - only where state lives changed.
require "fileutils"
require "json"
require "openssl"
require "securerandom"
require "socket"

PORT = (ENV["PORT"] || "3000").to_i
SECRET = ENV["SESSION_SECRET"] || "dev-secret-not-for-production"
DATA_FILE = ENV["DATA_FILE"] || File.join(__dir__, "data.json")
UPLOAD_DIR = ENV["UPLOAD_DIR"] || File.join(__dir__, "uploads")
FileUtils.mkdir_p(UPLOAD_DIR)
FileUtils.mkdir_p(File.dirname(DATA_FILE))

ITEMS_MUTEX = Mutex.new

# FIXED: identity lives in a signed cookie, not server memory. Any instance
# that's given the same SESSION_SECRET can verify it, so login survives a switch.
def sign(value)
  sig = OpenSSL::HMAC.hexdigest("SHA256", SECRET, value)
  "#{value}.#{sig}"
end

def verify(signed)
  return nil unless signed
  idx = signed.rindex(".")
  return nil unless idx
  value = signed[0...idx]
  sig = signed[(idx + 1)...]
  expected = OpenSSL::HMAC.hexdigest("SHA256", SECRET, value)
  return nil unless sig && expected.bytesize == sig.bytesize
  return nil unless OpenSSL.secure_compare(sig, expected)
  value
end

# FIXED: items live at DATA_FILE - point every instance at the same shared
# path and they all see the same data. Plain read-modify-write, no
# cross-process locking: fine for a demo app, not a production-grade store.
def read_items
  JSON.parse(File.read(DATA_FILE), symbolize_names: true)
rescue Errno::ENOENT, JSON::ParserError
  []
end

def write_items(items)
  File.write(DATA_FILE, JSON.generate(items))
end

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
  verify(cookies["sid"])
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
    status, h, b = json_response(200, { email: data["email"] })
    [status, h.merge("Set-Cookie" => "sid=#{sign(data["email"])}; HttpOnly; Path=/"), b]
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
    ITEMS_MUTEX.synchronize do
      items = read_items
      items << item
      write_items(items)
    end
    json_response(201, item)
  in ["GET", String => p] if p.start_with?("/items/")
    email = session_email(cookies)
    return json_response(401, { error: "not authenticated" }) unless email
    id = p.sub("/items/", "")
    item = ITEMS_MUTEX.synchronize { read_items.find { |i| i[:id] == id } }
    return json_response(404, { error: "not found" }) unless item
    json_response(200, item)
  in ["POST", "/upload"]
    email = session_email(cookies)
    return json_response(401, { error: "not authenticated" }) unless email
    boundary = headers["content-type"][/boundary=(.+)$/, 1]
    file = boundary && parse_multipart(body, boundary)
    return json_response(400, { error: "file required" }) unless file
    filename = "#{SecureRandom.hex(16)}-#{File.basename(file[:filename])}"
    File.binwrite(File.join(UPLOAD_DIR, filename), file[:content]) # FIXED: UPLOAD_DIR is a shared path, not local-only
    json_response(201, { filename: filename })
  in ["GET", String => p] if p.start_with?("/uploads/")
    email = session_email(cookies)
    return json_response(401, { error: "not authenticated" }) unless email
    safe_name = File.basename(p.sub("/uploads/", ""))
    file_path = File.join(UPLOAD_DIR, safe_name)
    return json_response(404, { error: "not found" }) unless File.exist?(file_path)
    [200, { "Content-Type" => "application/octet-stream" }, File.binread(file_path)]
  else
    json_response(404, { error: "not found" })
  end
end

server = TCPServer.new("127.0.0.1", PORT)
puts "fixed-ruby listening on #{PORT}"
loop do
  client = server.accept
  Thread.new(client) { |c| handle(c) }
end
