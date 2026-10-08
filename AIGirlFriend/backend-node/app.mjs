import { createServer } from "node:http";
import { readFile, stat, realpath, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { passwordHash, verifyPassword, secureEqual, validateProductionConfig } from "./auth.mjs";
import { createTextClient, parseReply, partialReplyText } from "./ai-client.mjs";
import { createImageService, imageOptions, imagePrompt } from "./images.mjs";
import { createCatalog, catalogMetadata, effectiveProfile, personalPreference } from "./catalog.mjs";
import { xlsx } from "./xlsx.mjs";
import { createVoiceService, TTS_ENV_KEYS, DEFAULT_TTS_ENV_FILE } from "./cosyvoice.mjs";
import { buildCompanionMessages } from "./dialogue-prompt.mjs";
import { createAttachmentStore, normalizeImage, MAX_UPLOAD_BYTES, MAX_IMAGES_PER_MESSAGE } from "./attachments.mjs";
import { createVisionClient } from "./vision.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function loadEnv(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (/^["']/.test(value)) { const q = value[0], end = value.indexOf(q, 1); value = end >= 1 ? value.slice(1, end) : value.slice(1); }
    else value = value.replace(/\s+#.*$/, "").trim();
    values[match[1]] = value;
  }
  return values;
}
const truthy = value => ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const safe = (value, fallback = {}) => { try { return JSON.parse(value || ""); } catch { return fallback; } };
const identifier = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const publicUser = value => ({ id: value.id, account: value.account, balance: value.balance });

export async function createApplication(options = {}) {
  const root = resolve(options.root || ROOT);
  // Only read the explicitly authorised TTS settings; unrelated pet application secrets stay separate.
  const sourceTts = loadEnv(options.ttsEnvFile || process.env.COSYVOICE_ENV_FILE || DEFAULT_TTS_ENV_FILE);
  const visionKeys = ["DASHSCOPE_VISION_API_KEY", "AI_VISION_BASE_URL", "AI_VISION_MODEL", "AI_VISION_TIMEOUT_MS", "COMPANION_ATTACHMENTS_DIR"];
  const sourceVision = loadEnv(options.visionEnvFile || process.env.VISION_ENV_FILE || resolve(root, ".vision.env"));
  const env = { ...Object.fromEntries(TTS_ENV_KEYS.filter(key => Object.hasOwn(sourceTts, key)).map(key => [key, sourceTts[key]])), ...Object.fromEntries(visionKeys.filter(key => Object.hasOwn(sourceVision, key)).map(key => [key, sourceVision[key]])), ...loadEnv(resolve(root, ".env")), ...process.env, ...options.env };
  const localDev = truthy(env.LOCAL_DEV);
  const jwtSecret = env.JWT_SECRET || "change-this-secret", adminPassword = env.ADMIN_PASSWORD || "admin123456", paySecret = env.PAY_CALLBACK_SECRET || "dev-pay-secret";
  validateProductionConfig(env);
  const dbPath = resolve(root, env.DB_PATH || "app.db"); await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS verify_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, code TEXT NOT NULL, expire_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, captcha_token_hash TEXT);
    CREATE TABLE IF NOT EXISTS captcha_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE NOT NULL, code_hash TEXT NOT NULL, expire_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, verified_at TEXT);
    CREATE TABLE IF NOT EXISTS recharge_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, order_no TEXT UNIQUE NOT NULL, amount REAL NOT NULL, points INTEGER NOT NULL, pay_type TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT);
    CREATE TABLE IF NOT EXISTS wallet_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, change_points INTEGER NOT NULL, balance_after INTEGER NOT NULL, log_type TEXT NOT NULL, remark TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS login_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, account TEXT NOT NULL, success INTEGER NOT NULL, ip TEXT, user_agent TEXT, message TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, action TEXT NOT NULL, cost_points INTEGER NOT NULL, success INTEGER NOT NULL, prompt TEXT, error TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS generation_records (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, action TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, prompt TEXT, cost_points INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS companion_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, character_name TEXT NOT NULL, relationship TEXT NOT NULL, user_preference TEXT, profile_json TEXT, search_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, preset_key TEXT);
    CREATE TABLE IF NOT EXISTS companion_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, profile_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, media_json TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS companion_image_tasks (task_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, profile_id INTEGER NOT NULL, assistant_message_id INTEGER NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, message TEXT, progress INTEGER NOT NULL DEFAULT 0, api_started INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_ms INTEGER NOT NULL, reply_json TEXT NOT NULL, options_json TEXT NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS companion_credit_holds (hold_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, points INTEGER NOT NULL, expires_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS companion_audio_generations (assistant_message_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, profile_id INTEGER NOT NULL, status TEXT NOT NULL, filename TEXT, model TEXT, duration_seconds REAL, sha256 TEXT, charged_points INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS companion_attachments (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, profile_id INTEGER NOT NULL, mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, thumbnail_sha256 TEXT NOT NULL, message_id INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS companion_vision_observations (user_message_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, profile_id INTEGER NOT NULL, summary TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_companion_attachments_owner ON companion_attachments(user_id,profile_id,message_id);
    CREATE INDEX IF NOT EXISTS idx_companion_credit_holds_user ON companion_credit_holds(user_id, expires_ms);
    CREATE INDEX IF NOT EXISTS idx_companion_messages_user_profile_id ON companion_messages(user_id, profile_id, id);
    CREATE INDEX IF NOT EXISTS idx_generation_records_user_id_id ON generation_records(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_logs_user_id_id ON wallet_logs(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_login_logs_user_id_id ON login_logs(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_login_logs_account_id ON login_logs(account, id DESC);
    CREATE INDEX IF NOT EXISTS idx_recharge_orders_user_id_id ON recharge_orders(user_id, id DESC);`);
  for (const [table, column] of [["verify_codes", "captcha_token_hash"], ["companion_profiles", "preset_key"]]) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(x => x.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_companion_profiles_user_updated ON companion_profiles(user_id, updated_at DESC, id DESC)");
  const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: env.APP_TIMEZONE || env.TZ || "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const now = (offset = 0) => dateFormat.format(new Date(Date.now() + offset));
  const transaction = callback => { db.exec("BEGIN IMMEDIATE"); try { const result = callback(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const signToken = payload => {
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${head}.${body}.${createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest("base64url")}`;
  };
  const claims = request => {
    try {
      const token = String(request.headers.authorization || ""); if (!token.startsWith("Bearer ")) return null;
      const [head, body, signature, extra] = token.slice(7).trim().split(".");
      if (extra || safe(Buffer.from(head, "base64url").toString()).alg !== "HS256" || !secureEqual(signature || "", createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest("base64url"))) return null;
      const value = JSON.parse(Buffer.from(body, "base64url").toString());
      return !Number.isFinite(value.exp) || value.exp <= Date.now() / 1000 || (value.nbf && value.nbf > Date.now() / 1000) ? null : value;
    } catch { return null; }
  };
  const user = request => { const id = identifier(claims(request)?.user_id); return id ? db.prepare("SELECT * FROM users WHERE id=?").get(id) : null; };
  const allowedOrigins = new Set(String(env.CORS_ORIGINS || "http://127.0.0.1:8000,http://localhost:8000").split(",").map(x => x.trim()).filter(Boolean));
  const cors = (request, response) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type"); response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  };
  const send = (res, status, value, headers = {}) => {
    if (res.destroyed || res.writableEnded) return;
    const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    res.writeHead(status, { "Content-Type": Buffer.isBuffer(value) ? "application/octet-stream" : "application/json; charset=utf-8", "Content-Length": body.length, ...headers }); res.end(body);
  };
  const ok = (res, value) => send(res, 200, value), fail = (res, message, status = 200, extra = {}) => send(res, status, { success: false, message, ...extra });
  const readBody = async request => {
    if (Number(request.headers["content-length"]) > 1024 * 1024) throw Object.assign(new Error("请求正文过大"), { status: 413 });
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw Object.assign(new Error("请求正文过大"), { status: 413 }); chunks.push(chunk); }
    if (!chunks.length) return {};
    try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw Object.assign(new Error("请求 JSON 格式错误"), { status: 400 }); }
  };
  const presetsPath = resolve(root, env.COMPANION_PRESETS_FILE || "companion_presets.json");
  const catalog = createCatalog(presetsPath), presets = catalog.list, findPreset = catalog.find;
  const voiceService = createVoiceService({ env, root });
  const allowedTypes = profile => {
    const p = findPreset(profile?.preset_key);
    if (!p || p.media_enabled === false) return ["text"];
    const types = (p.allowed_types || ["text", "image", "video", "audio"]).filter(x => ["text", "image", "video", "audio"].includes(x));
    // The existing production presets predate voice enrollment and declare text/image only.
    // Enable the newly enrolled capability from this role's current dedicated voice mapping.
    return voiceService.voice(p.key).voice_available ? [...new Set([...types, "audio"])] : types;
  };
  const currentProfile = p => effectiveProfile(p, findPreset(p?.preset_key));
  const profileVoice = profile => {
    const preset = findPreset(profile?.preset_key);
    if (profile?.catalog_available === false || !preset || preset.media_enabled === false) return { voice_available: false, voice_status: "unavailable", voice_reason: "该角色尚未配置专属音色" };
    const { voice_available, voice_status, voice_reason } = voiceService.voice(preset.key);
    // Never spread a provider descriptor into public profiles: its internal ID is not a profile ID.
    return { voice_available, voice_status, voice_reason };
  };
  const profileSummary = row => { const p = currentProfile(row), types = allowedTypes(p); return { id: p.id, character_name: p.character_name, relationship: p.relationship, search_summary: p.search_summary, preset_key: p.preset_key || "", ...catalogMetadata(p), ...profileVoice(p), catalog_available: p.catalog_available, allowed_types: types, media_enabled: types.some(x => x !== "text"), created_at: p.created_at, updated_at: p.updated_at }; };
  const getProfile = (uid, pid) => pid ? db.prepare("SELECT * FROM companion_profiles WHERE id=? AND user_id=?").get(identifier(pid), uid) : db.prepare("SELECT * FROM companion_profiles WHERE user_id=? ORDER BY id DESC LIMIT 1").get(uid);
  const saveMessage = (uid, pid, role, content, media = {}) => {
    const result = db.prepare("INSERT INTO companion_messages(user_id,profile_id,role,content,media_json,created_at) VALUES(?,?,?,?,?,?)").run(uid, pid, role, content, JSON.stringify(media), now()); db.prepare("UPDATE companion_profiles SET updated_at=? WHERE id=? AND user_id=?").run(now(), pid, uid); return Number(result.lastInsertRowid);
  };
  const heldPoints = (uid, excluding = "") => Number(db.prepare("SELECT coalesce(sum(points),0) AS points FROM companion_credit_holds WHERE user_id=? AND expires_ms>? AND hold_id<>?").get(uid, Date.now(), excluding).points);
  const availableBalance = uid => Number(db.prepare("SELECT balance FROM users WHERE id=?").get(uid)?.balance || 0) - heldPoints(uid);
  const reserveChat = (uid, wantAudio) => transaction(() => {
    db.prepare("DELETE FROM companion_credit_holds WHERE expires_ms<=?").run(Date.now());
    const available = availableBalance(uid); if (available < 5) throw new Error("余额不足，或余额正在用于其他请求，本次聊天需要 5 点");
    const audio = wantAudio && available >= 10, holdId = randomUUID();
    const expires = Date.now() + Math.max(600000, (Number(env.AI_TEXT_TIMEOUT_MS || env.AI_TIMEOUT_MS) || 180000) + (Number(env.AI_IMAGE_TIMEOUT_MS) || 240000) + voiceService.timeoutMs + 120000);
    db.prepare("INSERT INTO companion_credit_holds(hold_id,user_id,points,expires_ms) VALUES(?,?,?,?)").run(holdId, uid, audio ? 10 : 5, expires);
    return { holdId, audio };
  });
  const wallet = (uid, cost, type, remark, callback, ownHold = "") => transaction(() => {
    if (!db.prepare("UPDATE users SET balance=balance-? WHERE id=? AND balance>=?").run(cost, uid, cost + heldPoints(uid, ownHold)).changes) throw new Error(`余额不足，本次需要 ${cost} 点`);
    const balance = db.prepare("SELECT balance FROM users WHERE id=?").get(uid).balance;
    db.prepare("INSERT INTO wallet_logs(user_id,change_points,balance_after,log_type,remark,created_at) VALUES(?,?,?,?,?,?)").run(uid, -cost, balance, type, remark, now()); return callback(balance);
  });
  const logAI = (uid, action, cost, success, prompt, error = null) => db.prepare("INSERT INTO ai_logs(user_id,action,cost_points,success,prompt,error,created_at) VALUES(?,?,?,?,?,?,?)").run(uid, action, cost, success ? 1 : 0, prompt, error, now());
  const logLogin = (request, account, uid, success, message) => db.prepare("INSERT INTO login_logs(user_id,account,success,ip,user_agent,message,created_at) VALUES(?,?,?,?,?,?,?)").run(uid || null, account, success ? 1 : 0, request.socket.remoteAddress || "", String(request.headers["user-agent"] || "").slice(0, 500), message, now());
  const textAI = createTextClient({ key: env.AI_API_KEY, baseUrl: env.AI_BASE_URL, mode: env.AI_TEXT_API_MODE, endpoint: env.AI_TEXT_ENDPOINT, timeoutMs: Number(env.AI_TEXT_TIMEOUT_MS || env.AI_TIMEOUT_MS) || 180000, tokenField: env.AI_TEXT_TOKEN_FIELD || "max_tokens", temperature: env.AI_TEXT_TEMPERATURE !== "off" });
  const vision = createVisionClient(env), attachments = createAttachmentStore({ root, directory: env.COMPANION_ATTACHMENTS_DIR });
  const claimedAttachments = new Map(), uploadControllers = new Map(), activeUploads = new Set();
  const imageService = createImageService({ env, root }), imageControllers = new Map(), imageQueue = [], chatControllers = new Map(), activeChats = new Set(); let closing = false;

  async function createProfile(uid, data) {
    const requestedKey = String(data.preset_key || "").trim(), preset = findPreset(requestedKey), name = String(preset?.character_name || data.character_name || "").trim().slice(0, 100);
    if (requestedKey && !preset) throw new Error("该预设角色已移除或不存在，请从角色目录重新选择");
    if (!name) throw new Error("请填写 AI 要扮演的角色身份");
    const relationship = String(preset?.relationship || data.relationship || "恋人").trim().slice(0, 20), key = preset?.key || "";
    const existing = preset
      ? db.prepare("SELECT * FROM companion_profiles WHERE user_id=? AND preset_key=? AND relationship=? ORDER BY id DESC LIMIT 1").get(uid, key, relationship)
      : db.prepare("SELECT * FROM companion_profiles WHERE user_id=? AND lower(trim(character_name))=lower(trim(?)) AND relationship=? AND ifnull(preset_key,'')='' ORDER BY id DESC LIMIT 1").get(uid, name, relationship);
    const suppliedPreference = Object.hasOwn(data, "user_preference"), preference = preset
      ? personalPreference({ user_preference: suppliedPreference ? String(data.user_preference || "").trim().slice(0, 4000) : existing?.user_preference, profile_json: existing?.profile_json }, preset)
      : String(data.user_preference || "").trim().slice(0, 4000);
    let profileData = preset || { character_name: name, relationship, user_preference: preference, role_prompt: `扮演${name}，与用户是${relationship}。${preference}`, profile_source: "user" };
    let summary = preset?.search_summary || preset?.summary || preference || `角色：${name}；与用户的关系：${relationship}。请保持角色身份与语气一致。`;
    if (!preset && env.AI_PROFILE_GENERATION !== "off") {
      const raw = await textAI([{ role: "system", content: '你是中文陪伴角色建档助手。根据模型已有知识与用户提供设定建立可执行角色提示词。已知作品人物须贴近原作性格、价值观、经历、人物关系、称呼与说话习惯，不虚构重大原作事实。原创角色有充分设定也可以建立。角色名太泛、同名角色或背景不足时要求补充来源作品、背景、性格与说话方式。只输出 JSON：{"status":"ready 或 needs_more_info","concise_message":"简短说明","role_prompt":"详细中文人设提示词，至少40字"}。' }, { role: "user", content: `角色名：${name}\n与用户关系：${relationship}\n补充设定：${preference || "无"}` }], { model: env.AI_COMPANION_MODEL || env.AI_NOVEL_MODEL, maxTokens: 1200 });
      const generated = safe(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      if (generated.status !== "ready" || String(generated.role_prompt || "").trim().length < 40) throw Object.assign(new Error(generated.concise_message || "请补充角色来源、背景、性格和说话方式后建立身份。"), { need_more_info: true });
      summary = String(generated.role_prompt).trim(); profileData = { ...profileData, role_prompt: summary, profile_source: "chat_model" };
    }
    let id;
    if (existing) { id = existing.id; db.prepare("UPDATE companion_profiles SET character_name=?,relationship=?,user_preference=?,profile_json=?,search_summary=?,preset_key=?,updated_at=? WHERE id=? AND user_id=?").run(name, relationship, preference, JSON.stringify(profileData), summary, key, now(), id, uid); }
    else id = Number(db.prepare("INSERT INTO companion_profiles(user_id,character_name,relationship,user_preference,profile_json,search_summary,preset_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(uid, name, relationship, preference, JSON.stringify(profileData), summary, key, now(), now()).lastInsertRowid);
    const types = allowedTypes({ preset_key: key });
    return { success: true, profile_id: id, profile: { ...profileData, ...profileVoice({ preset_key: key }), id, allowed_types: types, media_enabled: types.some(type => type !== "text") }, search_summary: summary, reused: Boolean(existing) };
  }
  function checkCaptcha(token, code) {
    const row = db.prepare("SELECT * FROM captcha_codes WHERE token_hash=? ORDER BY id DESC LIMIT 1").get(hash(String(token || "").trim()));
    if (!row || row.used || row.expire_at < now()) throw new Error("图片验证码无效或已过期，请刷新后重试");
    if (!secureEqual(hash(String(code || "").trim().toUpperCase()), row.code_hash)) throw new Error("图片验证码错误"); db.prepare("UPDATE captcha_codes SET used=1,verified_at=? WHERE id=?").run(now(), row.id);
  }
  const turnstileEnabled = Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && !String(env.TURNSTILE_SITE_KEY).startsWith("your-") && !String(env.TURNSTILE_SECRET_KEY).startsWith("your-"));
  async function humanVerification(request, data) {
    if (localDev && truthy(env.DEV_SKIP_CAPTCHA)) return;
    if (!turnstileEnabled) return checkCaptcha(data.captcha_token, data.captcha_code);
    if (!String(data.turnstile_token || "").trim()) throw new Error("请先完成 Cloudflare 验证");
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: String(data.turnstile_token), remoteip: request.socket.remoteAddress || "" }), signal: AbortSignal.timeout(10000) });
    const value = await response.json(); if (!response.ok || !value.success) throw new Error("Cloudflare 验证失败，请重试");
  }
  const historyImageSignature = (uid, messageId, index) => createHmac("sha256", jwtSecret).update(`history-image|${uid}|${messageId}|${index}`).digest("base64url");
  const audioSignature = (uid, messageId, filename, expiry) => createHmac("sha256", jwtSecret).update(`companion-audio|${uid}|${messageId}|${filename}|${expiry}`).digest("base64url");
  function audioMedia(media, uid, messageId) {
    if (!Array.isArray(media?.audios)) return media;
    return { ...media, audios: media.audios.map(item => {
      const { file, ...publicItem } = item;
      if (!file) return publicItem;
      const expiry = Math.floor(Date.now() / 1000) + 86400;
      return { ...publicItem, url: `/api/companion/audio/${messageId}?expires=${expiry}&signature=${audioSignature(uid, messageId, file, expiry)}` };
    }) };
  }
  async function audioFile(request, res, url, messageId) {
    const expiry = Number(url.searchParams.get("expires")), signature = url.searchParams.get("signature") || "";
    if (!identifier(messageId) || !Number.isSafeInteger(expiry) || expiry <= Date.now() / 1000 || expiry > Date.now() / 1000 + 86460 || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return fail(res, "Not Found", 404);
    const row = db.prepare("SELECT a.* FROM companion_audio_generations a JOIN companion_messages m ON m.id=a.assistant_message_id AND m.user_id=a.user_id JOIN companion_profiles p ON p.id=m.profile_id AND p.user_id=m.user_id WHERE a.assistant_message_id=? AND a.status='done' AND a.charged_points=5").get(messageId);
    if (!row || !secureEqual(signature, audioSignature(row.user_id, messageId, row.filename, expiry))) return fail(res, "Not Found", 404);
    const loggedIn = user(request); if (loggedIn && loggedIn.id !== row.user_id) return fail(res, "Not Found", 404);
    let bytes; try { bytes = await voiceService.read(row.filename); } catch { return fail(res, "语音文件暂时无法读取", 404); }
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) return fail(res, "语音文件校验失败", 404);
    const etag = `"${row.sha256}"`, headers = { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=3600", ETag: etag, "Accept-Ranges": "bytes", "Content-Security-Policy": "default-src 'none'; sandbox" };
    if (request.headers["if-none-match"] === etag) return send(res, 304, Buffer.alloc(0), headers);
    if (request.headers.range && (!request.headers["if-range"] || request.headers["if-range"] === etag)) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range); let begin, end;
      if (range && (range[1] || range[2])) { begin = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2])); end = range[1] && range[2] ? Number(range[2]) : bytes.length - 1; end = Math.min(end, bytes.length - 1); }
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || begin > end || begin >= bytes.length) return send(res, 416, Buffer.alloc(0), { ...headers, "Content-Range": `bytes */${bytes.length}` });
      return send(res, 206, bytes.subarray(begin, end + 1), { ...headers, "Content-Range": `bytes ${begin}-${end}/${bytes.length}` });
    }
    return send(res, 200, bytes, headers);
  }
  const attachmentMetadata = row => ({ id: row.id, url: `/api/companion/attachments/${row.id}`, thumbnail_url: `/api/companion/attachments/${row.id}?variant=thumbnail`, mime_type: row.mime_type, width: row.width, height: row.height, size: row.size });
  const attachmentOwner = (id, uid) => db.prepare("SELECT a.* FROM companion_attachments a JOIN companion_profiles p ON p.id=a.profile_id AND p.user_id=a.user_id WHERE a.id=? AND a.user_id=?").get(id, uid);
  const attachmentLimits = uid => {
    const owned = db.prepare("SELECT COALESCE(SUM(size+102400),0) bytes,SUM(CASE WHEN message_id IS NULL THEN 1 ELSE 0 END) pending FROM companion_attachments WHERE user_id=?").get(uid);
    const total = db.prepare("SELECT COALESCE(SUM(size+102400),0) bytes FROM companion_attachments").get().bytes;
    return { owned, total };
  };
  function checkAttachmentQuota(uid, size = 0) {
    const { owned, total } = attachmentLimits(uid);
    if (owned.pending >= 12) throw Object.assign(new Error("待发送图片较多，请先发送或移除部分图片"), { status: 429 });
    if (owned.bytes + size + 102400 > 100 * 1024 * 1024 || total + size + 102400 > 512 * 1024 * 1024) throw Object.assign(new Error("图片存储空间不足，请稍后再试"), { status: 413 });
  }
  async function uploadAttachment(request, res, account, url) {
    if (!account) return fail(res, "请先登录", 401);
    const profile = getProfile(account.id, url.searchParams.get("profile_id"));
    if (!profile) return fail(res, "角色不存在或不属于当前账号", 404);
    if (!vision.configured) return fail(res, "图片识别暂未配置，请稍后再试", 503);
    if (Number(request.headers["content-length"]) > MAX_UPLOAD_BYTES) return fail(res, "图片不能超过 8MB", 413);
    if (uploadControllers.size >= 4) return fail(res, "正在处理其他图片，请稍后重试", 429);
    const controller = new AbortController(), aborted = () => controller.abort();
    uploadControllers.set(controller, { uid: account.id, pid: profile.id }); request.once("aborted", aborted);
    const closed = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", closed);
    let saved;
    try {
      for (const old of db.prepare("SELECT id FROM companion_attachments WHERE user_id=? AND message_id IS NULL AND created_at<? LIMIT 50").all(account.id, now(-86400000))) {
        if (claimedAttachments.has(old.id)) continue;
        await attachments.remove(old.id); db.prepare("DELETE FROM companion_attachments WHERE id=? AND message_id IS NULL").run(old.id);
      }
      checkAttachmentQuota(account.id);
      const normalized = await normalizeImage(request, { contentType: request.headers["content-type"], signal: controller.signal });
      controller.signal.throwIfAborted();
      saved = await attachments.save(normalized, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const row = transaction(() => {
        if (!getProfile(account.id, profile.id)) throw new Error("角色已切换或移除，请重新上传");
        checkAttachmentQuota(account.id, saved.size);
        db.prepare("INSERT INTO companion_attachments(id,user_id,profile_id,mime_type,width,height,size,sha256,thumbnail_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(saved.attachment_id, account.id, profile.id, saved.mime_type, saved.width, saved.height, saved.size, saved.sha256, saved.thumbnail_sha256, now());
        return attachmentOwner(saved.attachment_id, account.id);
      });
      return ok(res, { success: true, attachment: attachmentMetadata(row) });
    } catch (error) {
      if (saved) await attachments.remove(saved.attachment_id).catch(() => {});
      if (controller.signal.aborted) return fail(res, "图片上传已取消", 499);
      throw error;
    } finally { uploadControllers.delete(controller); request.off("aborted", aborted); res.off("close", closed); }
  }
  function trackedUpload(...args) { const pending = uploadAttachment(...args); activeUploads.add(pending); pending.finally(() => activeUploads.delete(pending)).catch(() => {}); return pending; }
  async function attachmentFile(request, res, account, url, id) {
    if (!account) return fail(res, "Not Found", 404);
    const row = attachmentOwner(id, account.id);
    if (!row || (!row.message_id && row.created_at < now(-86400000))) return fail(res, "Not Found", 404);
    if (request.method === "DELETE") {
      if (row.message_id || claimedAttachments.has(id)) return fail(res, "图片已发送或正在处理，不能从草稿中移除", 409);
      await attachments.remove(id); db.prepare("DELETE FROM companion_attachments WHERE id=? AND user_id=? AND message_id IS NULL").run(id, account.id);
      return ok(res, { success: true });
    }
    const variant = url.searchParams.get("variant") || "image";
    if (!["image", "thumbnail"].includes(variant)) return fail(res, "图片类型无效", 400);
    const file = await attachments.read(id, { variant });
    if (file.sha256 !== (variant === "thumbnail" ? row.thumbnail_sha256 : row.sha256)) return fail(res, "图片校验失败，请重新上传", 422);
    const headers = { "Content-Type": file.mime_type, "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline" };
    return send(res, 200, file.bytes, headers);
  }
  function historyMedia(raw, light, uid, messageId) {
    const media = audioMedia(safe(raw), uid, messageId);
    if (Array.isArray(media?.attachments)) {
      const owned = new Map(db.prepare("SELECT * FROM companion_attachments WHERE user_id=? AND message_id=?").all(uid, messageId).map(row => [row.id, row]));
      media.attachments = media.attachments.map(item => owned.get(item?.id)).filter(Boolean).map(attachmentMetadata);
    }
    if (!light || !media || !Array.isArray(media.images)) return media;
    for (const [index, item] of media.images.entries()) if (typeof item?.url === "string" && item.url.startsWith("data:image/")) {
      // Project a small, independently signed URL. Viewing history never resizes or rewrites legacy media.
      item.url = `/api/companion/history-image/${messageId}/${index}?signature=${historyImageSignature(uid, messageId, index)}`;
    }
    return media;
  }
  function historyImage(request, res, url, messageId, index) {
    const signature = url.searchParams.get("signature") || "";
    if (!identifier(messageId) || !Number.isSafeInteger(index) || index < 0 || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return fail(res, "Not Found", 404);
    // Reject forged links before reading potentially large media_json values.
    const owner = db.prepare("SELECT m.user_id FROM companion_messages m JOIN companion_profiles p ON p.id=m.profile_id AND p.user_id=m.user_id WHERE m.id=?").get(messageId);
    if (!owner || !secureEqual(signature, historyImageSignature(owner.user_id, messageId, index))) return fail(res, "Not Found", 404);
    const row = db.prepare("SELECT media_json FROM companion_messages WHERE id=?").get(messageId);
    const value = safe(row?.media_json)?.images?.[index]?.url;
    if (typeof value !== "string") return fail(res, "Not Found", 404);
    if (/^\/web\/assets\/generated_images\/\d{8}\/[a-f0-9-]{16,64}\.(?:png|jpe?g|webp|gif)$/i.test(value)) return staticFile(value, res);
    const encoded = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
    if (!encoded) return fail(res, "历史图片格式无法读取", 415);
    if (encoded[2].length > 48 * 1024 * 1024) return fail(res, "历史图片过大", 413);
    const bytes = Buffer.from(encoded[2], "base64");
    if (!bytes.length) return fail(res, "历史图片为空", 415);
    const type = encoded[1].toLowerCase().replace("image/jpg", "image/jpeg");
    const detectedType = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? "image/png"
      : bytes.subarray(0, 3).toString("hex") === "ffd8ff" ? "image/jpeg"
      : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii")) ? "image/gif"
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : "";
    if (!detectedType || detectedType !== type) return fail(res, "历史图片格式无法读取", 415);
    const etag = `"${createHash("sha256").update(bytes).digest("base64url")}"`;
    const headers = { "Content-Type": type, "Cache-Control": "private, max-age=86400", ETag: etag, "Content-Security-Policy": "default-src 'none'; sandbox" };
    if (String(request.headers["if-none-match"] || "").split(",").some(value => [etag, `W/${etag}`, "*"].includes(value.trim()))) return send(res, 304, Buffer.alloc(0), { ...headers, "Content-Length": bytes.length });
    return send(res, 200, bytes, headers);
  }
  async function history(res, account, url) {
    if (!account) return fail(res, "请先登录"); const profile = getProfile(account.id, url.searchParams.get("profile_id"));
    if (!profile) return ok(res, { success: true, profile: null, items: [], has_more: false, oldest_id: null, newest_id: null });
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(url.searchParams.get("limit"))) || 20)), after = identifier(url.searchParams.get("after_id")), before = identifier(url.searchParams.get("before_id"));
    let rows = db.prepare(`SELECT id,role,content,media_json,created_at FROM companion_messages WHERE user_id=? AND profile_id=? ${after ? "AND id>?" : before ? "AND id<?" : ""} ORDER BY id ${after ? "ASC" : "DESC"} LIMIT ?`).all(account.id, profile.id, ...((after || before) ? [after || before] : []), limit + 1);
    const hasMore = rows.length > limit; rows = rows.slice(0, limit); if (!after) rows.reverse();
    const light = ["light", "summary"].includes(url.searchParams.get("media_mode")), items = [];
    for (const row of rows) items.push({ id: row.id, role: row.role, content: row.content, media: historyMedia(row.media_json, light, account.id, row.id), created_at: row.created_at });
    return ok(res, { success: true, profile: profileSummary(profile), items, has_more: hasMore, oldest_id: rows[0]?.id || null, newest_id: rows.at(-1)?.id || null });
  }
  const taskPayload = task => ({ success: true, task_id: task.task_id, status: task.status, stage: task.stage, message: task.message || "", progress: task.progress, api_started: Boolean(task.api_started), elapsed_seconds: Math.floor((Date.now() - task.started_ms) / 1000), requested_size: safe(task.reply_json).media?.images?.[0]?.requested_size || "", media: audioMedia(safe(task.reply_json).media || {}, task.user_id, task.assistant_message_id), error: task.error || "", assistant_message_id: task.assistant_message_id, profile_id: task.profile_id });
  function queueImageTask(task) {
    if (closing || imageQueue.some(x => x.task_id === task.task_id) || imageControllers.has(task.task_id)) return;
    imageQueue.push(task); pumpImages();
  }
  function pumpImages() {
    const concurrency = Math.max(1, Math.min(8, Number(env.AI_IMAGE_CONCURRENCY) || 2));
    while (!closing && imageQueue.length && imageControllers.size < concurrency) {
      const task = imageQueue.shift();
      // Skip jobs removed by the user's clear-history action while still queued.
      if (!db.prepare("SELECT task_id FROM companion_image_tasks WHERE task_id=?").get(task.task_id)) continue;
      runImageTask(task).catch(error => {
        if (!closing) db.prepare("UPDATE companion_image_tasks SET status='error',stage='error',message='图片保存失败',error=?,updated_at=? WHERE task_id=?").run(String(error.message || "图片任务失败").slice(0, 300), now(), task.task_id);
      }).finally(() => { if (!closing) setImmediate(pumpImages); });
    }
  }
  async function runImageTask(task) {
    if (closing || imageControllers.has(task.task_id)) return;
    const controller = new AbortController(); imageControllers.set(task.task_id, controller);
    const reply = safe(task.reply_json), data = safe(task.options_json);
    db.prepare("UPDATE companion_image_tasks SET status='running',stage='prepare',updated_at=? WHERE task_id=?").run(now(), task.task_id);
    try {
      const storedProfile = getProfile(task.user_id, task.profile_id);
      if (!storedProfile) throw new Error("图片任务所属角色不存在");
      const profile = currentProfile(storedProfile), options = imageOptions(data);
      // Refresh identity after queue waits or process restarts; a former composed prompt is not a scene.
      for (const item of reply.media?.images || []) {
        item.scene_prompt = String(item.scene_prompt || reply.text || "自然的聊天场景").slice(0, 500);
        item.prompt = imagePrompt(profile, item, reply.text, options);
      }
      const media = await imageService.enrich(reply.media || {}, data, update => {
        if (closing) return; db.prepare("UPDATE companion_image_tasks SET stage=?,message=?,progress=?,api_started=?,updated_at=? WHERE task_id=?").run(update.stage || "api", update.message || "正在生成图片", Math.min(99, update.progress || 8), update.api_started === false ? 0 : 1, now(), task.task_id);
      }, controller.signal);
      if (closing) return;
      const failures = (media.images || []).filter(x => x.status === "error"), status = failures.length === (media.images || []).length && failures.length ? "error" : "done", error = failures.map(x => x.error_detail || x.error).join("；");
      transaction(() => { const stored = db.prepare("SELECT media_json FROM companion_messages WHERE id=? AND user_id=?").get(task.assistant_message_id, task.user_id); if (!stored) return; const latest = safe(stored.media_json), merged = { ...media, audios: latest.audios || [], ...(latest.audio_status ? { audio_status: latest.audio_status } : {}) }; db.prepare("UPDATE companion_messages SET media_json=? WHERE id=? AND user_id=?").run(JSON.stringify(merged), task.assistant_message_id, task.user_id); db.prepare("UPDATE companion_image_tasks SET status=?,stage=?,message=?,progress=?,reply_json=?,error=?,updated_at=? WHERE task_id=?").run(status, status, status === "done" ? "图片已完成" : "图片暂未返回", status === "done" ? 100 : 0, JSON.stringify({ text: reply.text, media: merged }), error, now(), task.task_id); });
    } finally { imageControllers.delete(task.task_id); }
  }
  function confirmedMediaFacts(uid, pid, history) {
    const ids = history.filter(row => row.role === "assistant").map(row => row.id);
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    // Use small owned task columns only; never load legacy inline image data or provider errors.
    const images = db.prepare(`SELECT assistant_message_id AS message_id,'image' AS type,CASE WHEN status='done' AND length(ifnull(error,''))>0 THEN 'partial' ELSE status END AS status FROM companion_image_tasks WHERE user_id=? AND profile_id=? AND assistant_message_id IN (${placeholders}) ORDER BY assistant_message_id DESC LIMIT 12`).all(uid, pid, ...ids);
    const audios = db.prepare(`SELECT assistant_message_id AS message_id,'audio' AS type,status FROM companion_audio_generations WHERE user_id=? AND profile_id=? AND assistant_message_id IN (${placeholders}) ORDER BY assistant_message_id DESC LIMIT 12`).all(uid, pid, ...ids);
    return [...images, ...audios];
  }
  async function chat(request, res, account, stream) {
    if (!account) return fail(res, "请先登录"); const data = await readBody(request);
    if (data.attachment_ids !== undefined && (!Array.isArray(data.attachment_ids) || data.attachment_ids.some(id => typeof id !== "string") || data.attachment_ids.length > MAX_IMAGES_PER_MESSAGE || new Set(data.attachment_ids).size !== data.attachment_ids.length)) return fail(res, "每条消息最多选择 3 张不同的图片", 400);
    const attachmentIds = data.attachment_ids || [], message = String(data.message || "").trim() || (attachmentIds.length ? "看看我发来的图片吧" : "");
    if (!message) return fail(res, "请输入要说的话"); if (message.length > 12000) return fail(res, "消息过长，请限制在 12000 字以内");
    let profile = getProfile(account.id, data.profile_id);
    if (!profile) { if (data.profile_id) return fail(res, "角色不存在或不属于当前账号"); const result = await createProfile(account.id, data); profile = getProfile(account.id, result.profile_id); }
    profile = currentProfile(profile);
    const attached = attachmentIds.map(id => attachmentOwner(id, account.id));
    if (attached.some(row => !row || row.profile_id !== profile.id)) return fail(res, "图片不存在或不属于当前角色，请重新上传", 404);
    if (attached.some(row => row.message_id || claimedAttachments.has(row.id))) return fail(res, "图片已发送或正在处理，请重新选择图片", 409);
    if (attached.some(row => row.created_at < now(-86400000))) return fail(res, "草稿图片已过期，请重新上传", 410);
    if (attached.length && !vision.configured) return fail(res, "图片识别暂未配置，请稍后再试", 503);
    const types = [...new Set(["text", ...(Array.isArray(data.reply_types) ? data.reply_types : ["text"]).filter(x => allowedTypes(profile).includes(x))])], previous = db.prepare("SELECT m.id,m.role,m.content,v.summary AS vision_summary FROM companion_messages m LEFT JOIN companion_vision_observations v ON v.user_message_id=m.id AND v.user_id=m.user_id AND v.profile_id=m.profile_id WHERE m.user_id=? AND m.profile_id=? ORDER BY m.id DESC LIMIT 12").all(account.id, profile.id).reverse();
    const wantsAudio = Array.isArray(data.reply_types) && data.reply_types.includes("audio"), voice = profileVoice(profile);
    const reservation = reserveChat(account.id, wantsAudio && voice.voice_available);
    for (const row of attached) claimedAttachments.set(row.id, reservation.holdId);
    let uid; try { uid = saveMessage(account.id, profile.id, "user", message); } catch (error) { for (const row of attached) claimedAttachments.delete(row.id); db.prepare("DELETE FROM companion_credit_holds WHERE hold_id=?").run(reservation.holdId); throw error; }
    const controller = new AbortController(), closed = () => { if (!res.writableEnded) controller.abort(); }; res.on("close", closed);
    chatControllers.set(reservation.holdId, { controller, uid: account.id, pid: profile.id });
    let heartbeat, emitted = "";
    const event = (name, value) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`); };
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" }); res.flushHeaders(); res.write(`:${" ".repeat(2048)}\n\n`); event("start", { profile_id: profile.id, character_name: profile.character_name, user_message_id: uid });
      heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, Number(env.SSE_HEARTBEAT_MS) || 15000); heartbeat.unref();
    }
    try {
      let observation = null;
      if (attached.length) {
        if (stream) event("media_status", { type: "vision", media_type: "vision", stage: "vision", message: "正在看你发来的图片" });
        const images = await Promise.all(attached.map(async row => {
          const file = await attachments.read(row.id, { variant: "image", signal: controller.signal });
          if (file.sha256 !== row.sha256) throw new Error("图片校验失败，请重新上传");
          return { bytes: file.bytes, mime_type: file.mime_type };
        }));
        observation = await vision.describe({ images, userText: message, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (stream) event("media_status", { type: "vision", media_type: "vision", stage: "reply", message: "图片看好了，正在回复你" });
      }
      const messages = buildCompanionMessages({ profile, history: previous, message, replyTypes: types, mediaFacts: confirmedMediaFacts(account.id, profile.id, previous), visionSummary: observation?.summary });
      const raw = await textAI(messages, { model: env.AI_COMPANION_MODEL || env.AI_NOVEL_MODEL, maxTokens: 1800, stream, signal: controller.signal, onDelta: (_delta, full) => { if (!stream) return; const text = partialReplyText(full); if (text.startsWith(emitted) && text.length > emitted.length) { event("delta", { text: text.slice(emitted.length) }); emitted = text; } } });
      if (controller.signal.aborted) throw new Error("请求已取消"); const parsed = parseReply(raw);
      if (stream && parsed.text.startsWith(emitted) && parsed.text.length > emitted.length) event("delta", { text: parsed.text.slice(emitted.length) });
      profile = currentProfile(getProfile(account.id, profile.id) || profile);
      const taskId = stream && types.includes("image") ? randomUUID().replaceAll("-", "") : "", reply = imageService.prepare(parsed, types, profile, data, taskId);
      // Model output cannot provide an audio URL or choose another character's voice.
      reply.media.audios = [];
      if (wantsAudio) reply.media.audio_status = reservation.audio ? { status: "running", message: "正在合成角色语音" } : voice.voice_available ? { status: "insufficient_balance", message: "余额不足，语音回复额外需要 5 点，已保留文字回复" } : { status: voice.voice_status, message: voice.voice_reason };
      if (!stream && types.includes("image")) reply.media = await imageService.enrich(reply.media, data, undefined, controller.signal);
      if (controller.signal.aborted) throw new Error("请求已取消");
      const payload = wallet(account.id, 5, "AI_COMPANION_CHAT", `AI对象聊天：${profile.character_name}`, balance => {
        const userMedia = attached.length ? { attachments: attached.map(attachmentMetadata) } : {};
        for (const row of attached) if (db.prepare("UPDATE companion_attachments SET message_id=? WHERE id=? AND user_id=? AND profile_id=? AND message_id IS NULL").run(uid, row.id, account.id, profile.id).changes !== 1) throw new Error("图片已移除，请重新上传");
        if (attached.length) {
          if (!db.prepare("UPDATE companion_messages SET media_json=? WHERE id=? AND user_id=? AND profile_id=?").run(JSON.stringify(userMedia), uid, account.id, profile.id).changes) throw new Error("对话已清空，请重新发送");
          db.prepare("INSERT INTO companion_vision_observations(user_message_id,user_id,profile_id,summary,model,created_at) VALUES(?,?,?,?,?,?)").run(uid, account.id, profile.id, observation.summary, observation.model, now());
        }
        const aid = saveMessage(account.id, profile.id, "assistant", reply.text, reply.media); logAI(account.id, "companion_chat", 5, true, message);
        if (reservation.audio) {
          db.prepare("UPDATE companion_credit_holds SET points=5 WHERE hold_id=?").run(reservation.holdId);
          db.prepare("INSERT INTO companion_audio_generations(assistant_message_id,user_id,profile_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(aid, account.id, profile.id, "running", now(), now());
        } else db.prepare("DELETE FROM companion_credit_holds WHERE hold_id=?").run(reservation.holdId);
        if (taskId) db.prepare("INSERT INTO companion_image_tasks(task_id,user_id,profile_id,assistant_message_id,status,stage,message,progress,api_started,created_at,updated_at,started_ms,reply_json,options_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(taskId, account.id, profile.id, aid, "pending", "prepare", "准备图片任务", 0, 0, now(), now(), Date.now(), JSON.stringify(reply), JSON.stringify({ image_quality: data.image_quality, image_aspect_ratio: data.image_aspect_ratio, image_tone: data.image_tone }));
        return { success: true, reply, profile_id: profile.id, user_message_id: uid, assistant_message_id: aid, cost: 5, cost_breakdown: { text: 5, audio: 0 }, balance, cloud_messages: [{ id: uid, role: "user", content: message, media: userMedia, created_at: now() }, { id: aid, role: "assistant", content: reply.text, media: reply.media, created_at: now() }] };
      }, reservation.holdId);
      if (taskId) { const task = db.prepare("SELECT * FROM companion_image_tasks WHERE task_id=?").get(taskId); if (stream) event("media_status", taskPayload(task)); setImmediate(() => queueImageTask(task)); }
      if (reservation.audio) {
        let audio;
        if (stream) event("media_status", { media_type: "audio", status: "running", message: "正在合成角色语音", assistant_message_id: payload.assistant_message_id });
        try {
          audio = await voiceService.synthesize(reply.text, profile.preset_key, controller.signal);
          if (closing || controller.signal.aborted) throw new Error("语音合成已取消，语音未扣点");
          payload.balance = wallet(account.id, 5, "AI_COMPANION_AUDIO", `角色语音：${profile.character_name}`, balance => {
            const stored = db.prepare("SELECT media_json FROM companion_messages WHERE id=? AND user_id=?").get(payload.assistant_message_id, account.id);
            if (!stored) throw new Error("聊天记录已清空，语音未扣点");
            const merged = { ...safe(stored.media_json), audios: [audio], audio_status: { status: "done", message: "角色语音已完成" } };
            if (!db.prepare("UPDATE companion_audio_generations SET status='done',filename=?,model=?,duration_seconds=?,sha256=?,charged_points=5,error=NULL,updated_at=? WHERE assistant_message_id=? AND user_id=? AND charged_points=0 AND status='running'").run(audio.file, audio.model, audio.duration_seconds, audio.sha256, now(), payload.assistant_message_id, account.id).changes) throw new Error("语音回复已处理，未重复扣点");
            db.prepare("UPDATE companion_messages SET media_json=? WHERE id=? AND user_id=?").run(JSON.stringify(merged), payload.assistant_message_id, account.id);
            db.prepare("DELETE FROM companion_credit_holds WHERE hold_id=?").run(reservation.holdId);
            logAI(account.id, "companion_audio", 5, true, null); return balance;
          }, reservation.holdId);
          payload.cost = 10; payload.cost_breakdown.audio = 5;
        } catch (error) {
          if (audio) await voiceService.discard(audio.file);
          transaction(() => {
            const stored = db.prepare("SELECT media_json FROM companion_messages WHERE id=? AND user_id=?").get(payload.assistant_message_id, account.id);
            if (stored) db.prepare("UPDATE companion_messages SET media_json=? WHERE id=? AND user_id=?").run(JSON.stringify({ ...safe(stored.media_json), audios: [], audio_status: { status: "failed", message: error.message } }), payload.assistant_message_id, account.id);
            db.prepare("UPDATE companion_audio_generations SET status='failed',error=?,updated_at=? WHERE assistant_message_id=? AND charged_points=0").run(error.message, now(), payload.assistant_message_id);
            db.prepare("DELETE FROM companion_credit_holds WHERE hold_id=?").run(reservation.holdId);
            logAI(account.id, "companion_audio", 0, false, null, error.message);
          });
        }
      }
      const stored = db.prepare("SELECT media_json FROM companion_messages WHERE id=? AND user_id=?").get(payload.assistant_message_id, account.id);
      if (stored) payload.reply.media = historyMedia(stored.media_json, false, account.id, payload.assistant_message_id);
      payload.cloud_messages[1].media = payload.reply.media;
      payload.balance = db.prepare("SELECT balance FROM users WHERE id=?").get(account.id).balance;
      if (stream) { event("done", payload); res.end(); } else ok(res, payload);
    } catch (error) { if (!closing) logAI(account.id, "companion_chat", 0, false, message, error.message); if (stream) { event("error", { message: error.message }); res.end(); } else fail(res, error.message); }
    finally { clearInterval(heartbeat); res.off("close", closed); for (const row of attached) if (claimedAttachments.get(row.id) === reservation.holdId) claimedAttachments.delete(row.id); db.prepare("DELETE FROM companion_credit_holds WHERE hold_id=?").run(reservation.holdId); chatControllers.delete(reservation.holdId); }
  }
  function trackedChat(...args) { const pending = chat(...args); activeChats.add(pending); pending.finally(() => activeChats.delete(pending)).catch(() => {}); return pending; }
  async function generateNovel(request, res, account, kind) {
    if (!account) return fail(res, "请先登录"); const data = await readBody(request), cost = kind === "outline" ? 20 : 30; if (availableBalance(account.id) < cost) return fail(res, `余额不足，本次需要 ${cost} 点`);
    const title = kind === "outline" ? "生成小说大纲" : `生成章节正文：${data.chapter_title || "第一章"}`, prompt = `请生成中文小说${kind === "outline" ? "大纲" : "章节正文"}。类型：${data.novel_type || ""}；主角：${data.protagonist || ""}；背景：${data.background || ""}；风格：${data.style || ""}；目标字数：${data.word_count || (kind === "outline" ? 2000 : 2500)}。${kind === "content" ? `大纲：${data.outline || ""}；章节标题：${data.chapter_title || "第一章"}；章节目标：${data.chapter_goal || ""}` : "包含世界观、角色设定、主线冲突和分卷章节规划。"}`;
    const controller = new AbortController(), closed = () => { if (!res.writableEnded) controller.abort(); }; res.on("close", closed);
    try {
      const content = await textAI([{ role: "system", content: "你是专业中文网文创作引擎，输出完整中文正文。" }, { role: "user", content: prompt }], { model: env.AI_NOVEL_MODEL || env.AI_COMPANION_MODEL, maxTokens: kind === "outline" ? 4000 : 5000, signal: controller.signal });
      if (controller.signal.aborted) throw new Error("请求已取消");
      const payload = wallet(account.id, cost, `AI_GENERATE_${kind.toUpperCase()}`, title, balance => { db.prepare("INSERT INTO generation_records(user_id,action,title,content,prompt,cost_points,created_at) VALUES(?,?,?,?,?,?,?)").run(account.id, `generate_${kind}`, title, content, prompt, cost, now()); logAI(account.id, `generate_${kind}`, cost, true, prompt); return { success: true, content, cost, balance }; }); ok(res, payload);
    } catch (error) { if (!closing) logAI(account.id, `generate_${kind}`, 0, false, prompt, error.message); fail(res, error.message); } finally { res.off("close", closed); }
  }
  function payOrder(order) {
    return transaction(() => {
      if (!db.prepare("UPDATE recharge_orders SET status='PAID',paid_at=? WHERE id=? AND status='PENDING'").run(now(), order.id).changes) return { success: true, message: "订单已处理", balance: db.prepare("SELECT balance FROM users WHERE id=?").get(order.user_id)?.balance };
      if (!db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(order.points, order.user_id).changes) throw new Error("订单用户不存在");
      const balance = db.prepare("SELECT balance FROM users WHERE id=?").get(order.user_id).balance; db.prepare("INSERT INTO wallet_logs(user_id,change_points,balance_after,log_type,remark,created_at) VALUES(?,?,?,?,?,?)").run(order.user_id, order.points, balance, "RECHARGE", `支付宝充值订单 ${order.order_no}`, now()); return { success: true, message: "充值成功", balance };
    });
  }
  const adminStats = () => ({ total_users: db.prepare("SELECT COUNT(*) n FROM users").get().n, total_balance: db.prepare("SELECT COALESCE(SUM(balance),0) n FROM users").get().n, total_messages: db.prepare("SELECT COUNT(*) n FROM companion_messages").get().n, total_orders: db.prepare("SELECT COUNT(*) n FROM recharge_orders").get().n, successful_logins: db.prepare("SELECT COUNT(*) n FROM login_logs WHERE success=1").get().n });
  const adminUsers = query => db.prepare(`SELECT u.id,u.account,u.balance,u.created_at,(SELECT COUNT(*) FROM companion_messages m WHERE m.user_id=u.id) message_count,(SELECT COUNT(*) FROM generation_records g WHERE g.user_id=u.id) generation_count,(SELECT MAX(created_at) FROM login_logs l WHERE l.user_id=u.id AND l.success=1) last_login FROM users u WHERE account LIKE ? ORDER BY id DESC LIMIT 300`).all(`%${String(query || "").trim()}%`);
  function adminDetail(uid, pid = 0) {
    const account = db.prepare("SELECT id,account,balance,created_at FROM users WHERE id=?").get(uid); if (!account) return null;
    const profiles = db.prepare("SELECT p.id,p.character_name,p.relationship,p.created_at,p.updated_at,COUNT(m.id) message_count FROM companion_profiles p LEFT JOIN companion_messages m ON m.profile_id=p.id AND m.user_id=p.user_id WHERE p.user_id=? GROUP BY p.id ORDER BY p.updated_at DESC,p.id DESC").all(uid), selected = profiles.some(x => x.id === pid) ? pid : 0;
    const messages = db.prepare(`SELECT m.id,m.profile_id,m.role,m.content,m.media_json,m.created_at,p.character_name,p.relationship FROM companion_messages m LEFT JOIN companion_profiles p ON p.id=m.profile_id WHERE m.user_id=? ${selected ? "AND m.profile_id=?" : ""} ORDER BY m.id DESC LIMIT 300`).all(uid, ...(selected ? [selected] : [])).map(row => { const media = safe(row.media_json); delete row.media_json; return { ...row, media: Object.keys(media).length ? { summary: "有媒体数据" } : {} }; });
    return { user: account, profiles, selected_profile_id: selected, messages, wallet_logs: db.prepare("SELECT * FROM wallet_logs WHERE user_id=? ORDER BY id DESC LIMIT 200").all(uid), login_logs: db.prepare("SELECT * FROM login_logs WHERE user_id=? OR account=? ORDER BY id DESC LIMIT 200").all(uid, account.account), generations: db.prepare("SELECT id,action,title,content,prompt,cost_points,created_at FROM generation_records WHERE user_id=? ORDER BY id DESC LIMIT 100").all(uid), orders: db.prepare("SELECT * FROM recharge_orders WHERE user_id=? ORDER BY id DESC LIMIT 100").all(uid) };
  }
  function adminExport(res) {
    const tables = [["users", ["id", "account", "balance", "created_at"], db.prepare("SELECT id,account,balance,created_at FROM users ORDER BY id").all()], ["orders", ["id", "user_id", "order_no", "amount", "points", "pay_type", "status", "created_at", "paid_at"], db.prepare("SELECT * FROM recharge_orders ORDER BY id DESC LIMIT 10000").all()], ["wallet_logs", ["id", "user_id", "change_points", "balance_after", "log_type", "remark", "created_at"], db.prepare("SELECT * FROM wallet_logs ORDER BY id DESC LIMIT 10000").all()], ["login_logs", ["id", "user_id", "account", "success", "ip", "user_agent", "message", "created_at"], db.prepare("SELECT * FROM login_logs ORDER BY id DESC LIMIT 10000").all()], ["messages", ["id", "user_id", "account", "character_name", "relationship", "role", "content", "media_json", "created_at"], db.prepare("SELECT m.id,m.user_id,u.account,p.character_name,p.relationship,m.role,m.content,m.media_json,m.created_at FROM companion_messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN companion_profiles p ON p.id=m.profile_id ORDER BY m.id DESC LIMIT 5000").all()], ["generations", ["id", "user_id", "action", "title", "content", "prompt", "cost_points", "created_at"], db.prepare("SELECT * FROM generation_records ORDER BY id DESC LIMIT 5000").all()]];
    return send(res, 200, xlsx(tables.map(([name, columns, rows]) => [name, [columns, ...rows.map(row => columns.map(c => typeof row[c] === "string" ? row[c].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, c === "media_json" ? 1000 : 3000) : row[c]))]])), { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="mihoyo-admin-${Date.now()}.xlsx"` });
  }
  const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2" };
  const isInside = (file, base) => { const rel = relative(base, file); return !rel.startsWith("..") && !isAbsolute(rel); };
  async function staticFile(path, res) {
    const rel = path === "/web" || path === "/web/" ? "index.html" : path.slice(5), pages = new Set(["index.html", "novel.html", "companion-chat.html", "admin-wechat.html"]), generated = rel.startsWith("assets/generated_images/");
    if (!pages.has(rel) && (!rel.startsWith("assets/") || !mime[extname(rel).toLowerCase()])) return fail(res, "Not Found", 404);
    if (rel.includes("\\") || rel.includes("\0") || rel.split("/").some(part => part === ".." || part.startsWith("."))) return fail(res, "Not Found", 404);
    const base = generated ? imageService.assetRoot : rel.startsWith("assets/") ? resolve(root, "assets") : root, file = generated ? resolve(base, rel.slice("assets/generated_images/".length)) : resolve(root, rel);
    if (!isInside(file, base)) return fail(res, "Not Found", 404);
    try { const [realFile, realBase] = await Promise.all([realpath(file), realpath(base)]); if (!isInside(realFile, realBase) || !(await stat(realFile)).isFile()) return fail(res, "Not Found", 404); return send(res, 200, await readFile(realFile), { "Content-Type": mime[extname(file).toLowerCase()], "Cache-Control": generated ? "public, max-age=31536000, immutable" : "no-cache" }); } catch { return fail(res, "Not Found", 404); }
  }
  async function handle(request, res) {
    cors(request, res); const url = new URL(request.url || "/", "http://localhost"); let path; try { path = decodeURIComponent(url.pathname); } catch { return fail(res, "URL 格式错误", 400); }
    if (request.method === "OPTIONS") return send(res, 204, Buffer.alloc(0));
    if (request.method === "GET" && path === "/") { res.writeHead(302, { Location: "/web/index.html" }); return res.end(); }
    if (request.method === "GET" && path === "/health") return ok(res, { success: true, service: "node-api", runtime: process.version, local_dev: localDev, tts: voiceService.health(), vision: { available: vision.configured, model: vision.model } });
    if (request.method === "GET" && (path === "/web" || path.startsWith("/web/"))) return staticFile(path, res);
    if (request.method === "GET" && path === "/api/auth/captcha") {
      const code = Array.from({ length: 4 }, () => "23456789"[randomInt(8)]).join(""), token = randomBytes(24).toString("base64url"); db.prepare("INSERT INTO captcha_codes(token_hash,code_hash,expire_at,used,created_at) VALUES(?,?,?,?,?)").run(hash(token), hash(code), now(600000), 0, now());
      const image = `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="50"><rect width="150" height="50" rx="8" fill="#f3efff"/><path d="M4 36L144 15M8 15L140 37" stroke="#b39ddb" fill="none"/><text x="75" y="34" text-anchor="middle" font-family="Arial" font-size="25" font-weight="700" letter-spacing="5" fill="#45316b">${code}</text></svg>`).toString("base64")}`;
      return ok(res, { success: true, token, image, expire_seconds: 600, ...(localDev ? { dev_code: code } : {}) });
    }
    if (request.method === "GET" && path === "/api/auth/turnstile-config") return ok(res, { success: true, enabled: turnstileEnabled, site_key: turnstileEnabled ? env.TURNSTILE_SITE_KEY : "" });
    if (request.method === "POST" && path === "/api/auth/send-code") {
      const data = await readBody(request), account = String(data.account || "").trim(); if (account.length < 3 || account.length > 100) return fail(res, "账号需要 3 至 100 位"); await humanVerification(request, data);
      const code = String(randomInt(100000, 1000000)), token = String(data.turnstile_token || data.captcha_token || "").trim(); db.prepare("INSERT INTO verify_codes(account,code,expire_at,used,created_at,captcha_token_hash) VALUES(?,?,?,?,?,?)").run(account, code, now(300000), 0, now(), hash(token));
      // Original registration shows a local verification code; no SMS/email provider is configured.
      return ok(res, { success: true, message: "请使用页面显示的注册验证码", dev_code: code });
    }
    if (request.method === "POST" && path === "/api/auth/register") {
      const data = await readBody(request), account = String(data.account || "").trim(), password = String(data.password || ""), token = String(data.turnstile_token || data.captcha_token || "").trim();
      if (account.length < 3 || account.length > 100) return fail(res, "账号需要 3 至 100 位"); if (password.length < 6 || password.length > 256) return fail(res, "密码需要 6 至 256 位"); if (!token) return fail(res, "请先完成人机验证并发送验证码"); if (db.prepare("SELECT id FROM users WHERE account=?").get(account)) return fail(res, "账号已存在");
      const codeRow = db.prepare("SELECT * FROM verify_codes WHERE account=? AND used=0 AND captcha_token_hash=? ORDER BY id DESC LIMIT 1").get(account, hash(token)); if (!codeRow || codeRow.expire_at < now()) return fail(res, "验证码不存在或已过期"); if (!secureEqual(String(data.code || "").trim(), codeRow.code)) return fail(res, "验证码错误");
      const digest = await passwordHash(password); transaction(() => { if (!db.prepare("UPDATE verify_codes SET used=1 WHERE id=? AND used=0").run(codeRow.id).changes) throw new Error("验证码已使用，请重新发送"); const uid = Number(db.prepare("INSERT INTO users(account,password_hash,balance,created_at) VALUES(?,?,?,?)").run(account, digest, 100, now()).lastInsertRowid); db.prepare("INSERT INTO wallet_logs(user_id,change_points,balance_after,log_type,remark,created_at) VALUES(?,?,?,?,?,?)").run(uid, 100, 100, "REGISTER_GIFT", "注册赠送 100 点", now()); }); return ok(res, { success: true, message: "注册成功，已赠送 100 点" });
    }
    if (request.method === "POST" && path === "/api/auth/login") {
      const data = await readBody(request), account = String(data.account || "").trim(); try { await humanVerification(request, data); } catch (error) { logLogin(request, account, null, false, error.message); throw error; }
      const row = db.prepare("SELECT * FROM users WHERE account=?").get(account); if (!row || !await verifyPassword(data.password, row.password_hash)) { logLogin(request, account, row?.id, false, "password mismatch"); return fail(res, "账号或密码错误"); }
      logLogin(request, account, row.id, true, "login success"); return ok(res, { success: true, token: signToken({ user_id: row.id, exp: Math.floor(Date.now() / 1000) + 604800 }), user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(row.id)) });
    }
    if (request.method === "POST" && path === "/api/admin/login") { const data = await readBody(request); return secureEqual(String(data.password || ""), adminPassword) ? ok(res, { success: true, token: signToken({ admin: true, exp: Math.floor(Date.now() / 1000) + (Number(env.ADMIN_TOKEN_EXPIRE_HOURS) || 12) * 3600 }) }) : fail(res, "管理员密码错误"); }
    if (path.startsWith("/api/admin/")) {
      if (claims(request)?.admin !== true) return fail(res, "管理员未登录或登录已过期");
      if (request.method === "GET" && path === "/api/admin/overview") return ok(res, { success: true, stats: adminStats() });
      if (request.method === "GET" && path === "/api/admin/bootstrap") { const rows = adminUsers(url.searchParams.get("q")); return ok(res, { success: true, stats: adminStats(), users: rows, detail: rows[0] ? adminDetail(rows[0].id) : null, synced_at: now() }); }
      if (request.method === "GET" && path === "/api/admin/users") return ok(res, { success: true, users: adminUsers(url.searchParams.get("q")) }); if (request.method === "GET" && path === "/api/admin/export.xlsx") return adminExport(res);
      if (request.method === "GET" && /^\/api\/admin\/user\/\d+$/.test(path)) { const detail = adminDetail(identifier(path.split("/").at(-1)), identifier(url.searchParams.get("profile_id"))); return detail ? ok(res, { success: true, ...detail }) : fail(res, "用户不存在"); } return fail(res, "Not Found", 404);
    }
    const account = user(request);
    if (request.method === "POST" && path === "/api/companion/attachments") return trackedUpload(request, res, account, url);
    if (["GET", "DELETE"].includes(request.method) && /^\/api\/companion\/attachments\/[a-f0-9-]{36}$/.test(path)) return attachmentFile(request, res, account, url, path.split("/").at(-1));
    if (request.method === "GET" && path === "/api/me") return account ? ok(res, { success: true, user: publicUser(account) }) : fail(res, "未登录");
    if (request.method === "GET" && path === "/api/ai/history") return account ? ok(res, { success: true, items: db.prepare("SELECT id,action,title,content,cost_points,created_at FROM generation_records WHERE user_id=? ORDER BY id DESC LIMIT 10").all(account.id) }) : fail(res, "请先登录");
    if (request.method === "POST" && path === "/api/ai/generate-outline") return generateNovel(request, res, account, "outline"); if (request.method === "POST" && path === "/api/ai/generate-content") return generateNovel(request, res, account, "content");
    if (request.method === "GET" && path === "/api/companion/presets") return account ? ok(res, { success: true, items: presets().map(p => ({ key: p.key, character_name: p.character_name || "", relationship: p.relationship || "恋人", summary: p.summary || p.search_summary || "", ...catalogMetadata(p), ...profileVoice({ preset_key: p.key }), catalog_available: true, allowed_types: allowedTypes({ preset_key: p.key }), media_enabled: p.media_enabled !== false })) }) : fail(res, "请先登录");
    if (request.method === "GET" && path === "/api/companion/profiles") return account ? ok(res, { success: true, items: db.prepare("SELECT * FROM companion_profiles WHERE user_id=? ORDER BY updated_at DESC,id DESC").all(account.id).map(profileSummary) }) : fail(res, "请先登录");
    if (request.method === "POST" && path === "/api/companion/profile") return account ? ok(res, await createProfile(account.id, await readBody(request))) : fail(res, "请先登录"); if (request.method === "GET" && path === "/api/companion/history") return history(res, account, url);
    if (request.method === "GET" && /^\/api\/companion\/history-image\/\d+\/\d+$/.test(path)) { const parts = path.split("/"); return historyImage(request, res, url, Number(parts.at(-2)), Number(parts.at(-1))); }
    if (request.method === "GET" && /^\/api\/companion\/audio\/\d+$/.test(path)) return audioFile(request, res, url, Number(path.split("/").at(-1)));
    if (request.method === "GET" && /^\/api\/companion\/image-task\/[a-zA-Z0-9-]{16,64}$/.test(path)) { if (!account) return fail(res, "请先登录"); const task = db.prepare("SELECT * FROM companion_image_tasks WHERE task_id=? AND user_id=?").get(path.split("/").at(-1), account.id); return task ? ok(res, taskPayload(task)) : fail(res, "图片任务不存在或不属于当前账号", 404); }
    if (request.method === "DELETE" && path === "/api/companion/messages") {
      if (!account) return fail(res, "请先登录"); const profile = getProfile(account.id, url.searchParams.get("profile_id")); if (!profile || !identifier(url.searchParams.get("profile_id"))) return fail(res, "角色不存在");
      for (const task of db.prepare("SELECT task_id FROM companion_image_tasks WHERE user_id=? AND profile_id=? AND status IN ('pending','running')").all(account.id, profile.id)) imageControllers.get(task.task_id)?.abort();
      for (const active of chatControllers.values()) if (active.uid === account.id && active.pid === profile.id) active.controller.abort();
      for (const [controller, owner] of uploadControllers) if (owner.uid === account.id && owner.pid === profile.id) controller.abort();
      const removedAttachments = db.prepare("SELECT id FROM companion_attachments WHERE user_id=? AND profile_id=?").all(account.id, profile.id);
      transaction(() => { db.prepare("DELETE FROM companion_messages WHERE user_id=? AND profile_id=?").run(account.id, profile.id); db.prepare("DELETE FROM companion_image_tasks WHERE user_id=? AND profile_id=?").run(account.id, profile.id); db.prepare("DELETE FROM companion_audio_generations WHERE user_id=? AND profile_id=?").run(account.id, profile.id); db.prepare("DELETE FROM companion_vision_observations WHERE user_id=? AND profile_id=?").run(account.id, profile.id); db.prepare("DELETE FROM companion_attachments WHERE user_id=? AND profile_id=?").run(account.id, profile.id); });
      await Promise.allSettled(removedAttachments.map(row => attachments.remove(row.id)));
      return ok(res, { success: true, message: "聊天记录已清空" });
    }
    if (request.method === "POST" && path === "/api/companion/chat") return trackedChat(request, res, account, false); if (request.method === "POST" && path === "/api/companion/chat/stream") return trackedChat(request, res, account, true);
    if (request.method === "POST" && path === "/api/pay/alipay/create-order") {
      if (!account) return fail(res, "请先登录"); const data = await readBody(request), amount = Number(data.amount), points = ({ "9.9": 1000, "39": 5000, "99": 15000 })[amount]; if (!points) return fail(res, "充值套餐不存在"); const no = `ALI${Date.now()}${randomInt(100000, 1000000)}`;
      db.prepare("INSERT INTO recharge_orders(user_id,order_no,amount,points,pay_type,status,created_at) VALUES(?,?,?,?,?,?,?)").run(account.id, no, amount, points, "ALIPAY", "PENDING", now()); return ok(res, { success: true, order_no: no, amount, points, pay_url: null, message: "订单已创建，正式支付需接入支付宝 SDK" });
    }
    if (request.method === "POST" && path === "/api/pay/alipay/mock-success") { if (!truthy(env.ALLOW_MOCK_PAYMENT)) return fail(res, "Not Found", 404); if (!account) return fail(res, "请先登录"); const data = await readBody(request), order = db.prepare("SELECT * FROM recharge_orders WHERE order_no=? AND user_id=?").get(String(data.order_no || ""), account.id); return order ? ok(res, payOrder(order)) : fail(res, "订单不存在"); }
    if (request.method === "POST" && path === "/api/pay/alipay/callback") {
      const data = await readBody(request), amount = Number(data.amount); if (!Number.isFinite(amount)) return fail(res, "订单金额无效");
      // Python float formatting signed '39.0'; prior Node clients signed '39'.
      const formats = [...new Set([String(amount), Number.isInteger(amount) ? `${amount}.0` : String(amount)])]; if (!formats.some(value => secureEqual(createHmac("sha256", paySecret).update(`${data.order_no}|${value}|${data.trade_no}`).digest("hex"), String(data.sign || "")))) return fail(res, "验签失败");
      const order = db.prepare("SELECT * FROM recharge_orders WHERE order_no=?").get(String(data.order_no || "")); if (!order) return fail(res, "订单不存在"); if (order.amount !== amount) return fail(res, "订单金额不一致"); return ok(res, payOrder(order));
    }
    return fail(res, "Not Found", 404);
  }
  const server = createServer((request, res) => { handle(request, res).catch(error => { if (res.headersSent) { if (!res.writableEnded) res.end(); return; } const internal = /SQLITE|database|UNIQUE constraint|constraint failed/i.test(error.message || ""); fail(res, internal ? "数据保存失败，请稍后重试" : error.message || "服务暂时不可用", error.status || (internal ? 500 : 200), error.need_more_info ? { need_more_info: true } : {}); }); });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 65000;
  server.on("clientError", (_error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
  async function listen(port = Number(env.PORT || env.NODE_API_PORT || 8000), host = env.HOST || "127.0.0.1") {
    await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolveListen(); }); });
    for (const task of db.prepare("SELECT * FROM companion_image_tasks WHERE status IN ('pending','running') ORDER BY started_ms").all()) setImmediate(() => queueImageTask(task)); return server.address();
  }
  async function close() {
    if (closing) return; closing = true; for (const controller of imageControllers.values()) controller.abort(); for (const active of chatControllers.values()) active.controller.abort(); for (const controller of uploadControllers.keys()) controller.abort(); server.closeIdleConnections();
    await new Promise(resolveClose => { server.close(resolveClose); const timeout = setTimeout(() => { server.closeAllConnections(); resolveClose(); }, 5000); timeout.unref(); }); await Promise.allSettled([...activeChats, ...activeUploads]); db.close();
  }
  return { server, db, dbPath, listen, close, signToken, env };
}
