// The same app as broken-express, with its three bugs actually fixed. The
// route shapes are identical on purpose - only where state lives changed.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const cookieParser = require("cookie-parser");
const express = require("express");
const multer = require("multer");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || "dev-secret-not-for-production";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

// FIXED: identity lives in a signed cookie, not server memory. Any instance
// that's given the same SESSION_SECRET can verify it, so login survives a switch.
function sign(value) {
  const sig = crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
  return `${value}.${sig}`;
}

function verify(signed) {
  if (typeof signed !== "string") return undefined;
  const idx = signed.lastIndexOf(".");
  if (idx === -1) return undefined;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
  return value;
}

// FIXED: items live at DATA_FILE - point every instance at the same shared
// path (or swap this for a real database) and they all see the same data.
// Plain read-modify-write, no cross-process locking: fine for a demo app,
// not a production-grade store.
function readItems() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}
function writeItems(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items));
}

const app = express();
app.use(express.json());
app.use(cookieParser());

const upload = multer({ dest: UPLOAD_DIR }); // FIXED: UPLOAD_DIR is a shared path, not local-only

app.get("/health", (_req, res) => res.sendStatus(200));

app.post("/signup", (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  res.status(201).json({ email });
});

app.post("/login", (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  res.cookie("sid", sign(email), { httpOnly: true });
  res.status(200).json({ email });
});

function requireSession(req, res, next) {
  const email = verify(req.cookies?.sid);
  if (email === undefined) return res.status(401).json({ error: "not authenticated" });
  req.email = email;
  next();
}

app.get("/me", requireSession, (req, res) => res.status(200).json({ email: req.email }));

app.post("/items", requireSession, (req, res) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  const items = readItems();
  const item = { id: crypto.randomUUID(), name };
  items.push(item);
  writeItems(items);
  res.status(201).json(item);
});

app.get("/items/:id", requireSession, (req, res) => {
  const item = readItems().find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  res.status(200).json(item);
});

app.post("/upload", requireSession, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required" });
  res.status(201).json({ filename: req.file.filename });
});

app.get("/uploads/:filename", requireSession, (req, res) => {
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "not found" });
  res.sendFile(filePath);
});

app.listen(PORT, () => {
  console.log(`fixed-express listening on ${PORT}`);
});
