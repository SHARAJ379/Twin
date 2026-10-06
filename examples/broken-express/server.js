// A minimal Express app, deliberately broken the way a vibe-coded app
// commonly is: it works perfectly as one process on localhost, and silently
// loses data the moment more than one instance is running. See
// TWIN_CONTEXT.md §2 for the full list of patterns this demonstrates.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const cookieParser = require("cookie-parser");
const express = require("express");
const multer = require("multer");

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// BROKEN: both live only in this process's memory. A second instance (or a
// restart of this one) starts with these empty — that's the bug Twin finds.
const sessions = {}; // sessionId -> { email }
const items = []; // { id, name }

const app = express();
app.use(express.json());
app.use(cookieParser());

const upload = multer({ dest: UPLOAD_DIR }); // BROKEN: files land on *this* instance's local disk only

app.get("/health", (_req, res) => res.sendStatus(200));

app.post("/signup", (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  res.status(201).json({ email });
});

app.post("/login", (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  const sessionId = crypto.randomUUID();
  sessions[sessionId] = { email };
  res.cookie("sid", sessionId, { httpOnly: true });
  res.status(200).json({ email });
});

function requireSession(req, res, next) {
  const session = sessions[req.cookies?.sid];
  if (!session) return res.status(401).json({ error: "not authenticated" });
  req.session = session;
  next();
}

app.get("/me", requireSession, (req, res) => res.status(200).json(req.session));

app.post("/items", requireSession, (req, res) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  const item = { id: crypto.randomUUID(), name };
  items.push(item);
  res.status(201).json(item);
});

app.get("/items/:id", requireSession, (req, res) => {
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  res.status(200).json(item);
});

app.post("/upload", requireSession, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required" });
  res.status(201).json({ filename: req.file.filename });
});

app.get("/uploads/:filename", requireSession, (req, res) => {
  const safeName = path.basename(req.params.filename); // no path traversal, even in a broken demo app
  const filePath = path.join(UPLOAD_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "not found" });
  res.sendFile(filePath);
});

app.listen(PORT, () => {
  console.log(`broken-express listening on ${PORT}`);
});
