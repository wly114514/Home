import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { createHmac, pbkdf2Sync, createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import bcrypt from "bcryptjs";
import { createApplication } from "../server.mjs";
import { partialReplyText, apiEndpoint, consumeAIResponse, createTextClient } from "../ai-client.mjs";
import { verifyPassword, passwordHash, validateProductionConfig } from "../auth.mjs";
import { createCatalog, catalogMetadata, effectiveProfile } from "../catalog.mjs";
import { imagePrompt, imageOptions } from "../images.mjs";

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const encoded = value => value.toString("base64").replaceAll("+", ".").replace(/=+$/, "");

test("catalog refresh preserves independent prompts, legacy preference snapshots and removed-character history", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mihoyo-catalog-test-")), file = resolve(root, "catalog.json");
  const first = { key: "preset_02", character_name: "测试水之演员", relationship: "恋人", game: "genshin", game_title: "原神", rarity: 5, element: "水", region: "枫丹", avatar_url: "/web/assets/avatar.webp", portrait_url: "/web/assets/portrait.png", sources: ["https://example.test/official/actor"], user_preference: "旧目录默认角色提示", role_prompt: "会用舞台比喻的自信演员", image_prompt: "white-and-blue hair, blue opera costume", allowed_types: ["text", "image"] };
  const second = { ...first, key: "preset_03", character_name: "测试星际旅人", game: "starrail", game_title: "崩坏：星穹铁道", element: "火", region: "星海", role_prompt: "认真而直接的成年旅人，用短句关心朋友", image_prompt: "silver hair, mint space travel jacket" };
  try {
    await writeFile(file, JSON.stringify({ presets: [first, second, { key: "preset_01", character_name: "下架角色" }] }));
    const catalog = createCatalog(file);
    assert.equal(catalog.list().length, 2); assert.equal(catalog.find("preset_01"), undefined);
    assert.notEqual(catalog.find("preset_02").role_prompt, catalog.find("preset_03").role_prompt);
    assert.notEqual(catalog.find("preset_02").image_prompt, catalog.find("preset_03").image_prompt);
    const profile = { id: 1, character_name: "旧角色名", relationship: "恋人", preset_key: first.key, user_preference: first.user_preference, profile_json: JSON.stringify(first), search_summary: "旧资料" };
    const next = { ...first, role_prompt: "新版舞台演员拥有独立的幽默语言习惯", image_prompt: "updated blue coat, white-blue hair, small top hat", portrait_url: "/web/assets/new-portrait.png" };
    await writeFile(file, JSON.stringify({ presets: [next, second] }));
    const current = effectiveProfile(profile, catalog.find(first.key));
    assert.equal(current.role_prompt, next.role_prompt); assert.equal(current.image_prompt, next.image_prompt); assert.equal(current.user_preference, "");
    assert.equal(current.portrait_url, next.portrait_url); assert.equal(current.game, "genshin"); assert.equal(current.rarity, 5);
    assert.equal(effectiveProfile({ ...profile, user_preference: "请叫我旅行者" }, next).user_preference, "请叫我旅行者");
    const longDefault = "旧目录长提示".repeat(900);
    assert.equal(effectiveProfile({ ...profile, user_preference: longDefault.slice(0, 4000), profile_json: JSON.stringify({ user_preference: longDefault }) }, next).user_preference, "");
    const prompt = imagePrompt(current, { scene_prompt: "在花园挥手" }, "测试回复", imageOptions({}));
    assert.match(prompt, /updated blue coat/); assert.doesNotMatch(prompt, /mint space travel jacket/);
    const retired = effectiveProfile({ ...profile, preset_key: "preset_01", character_name: "下架旧角色" }, undefined);
    assert.equal(retired.character_name, "下架旧角色"); assert.equal(retired.catalog_available, false);
    assert.deepEqual(Object.keys(catalogMetadata(next)).sort(), ["avatar_url", "element", "game", "game_title", "portrait_url", "rarity", "region", "sources"].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Python PBKDF2 / bcrypt / legacy Node password compatibility", async () => {
  const salt = Buffer.from("binary-salt\0\xff", "latin1"), password = "兼容密码-Test42";
  const expected = pbkdf2Sync(password, salt, 29000, 32, "sha256");
  const python = `$pbkdf2-sha256$29000$${encoded(salt)}$${encoded(expected)}`;
  assert.equal(await verifyPassword(password, python), true);
  assert.equal(await verifyPassword("wrong", python), false);
  const bcryptHash = await bcrypt.hash(password, 4);
  assert.equal(await verifyPassword(password, bcryptHash), true);
  const oldSalt = "old-base64url-string";
  const node = `$node-pbkdf2-sha256$29000$${oldSalt}$${pbkdf2Sync(password, oldSalt, 29000, 32, "sha256").toString("base64url")}`;
  assert.equal(await verifyPassword(password, node), true);
  const current = await passwordHash(password);
  assert.match(current, /^\$pbkdf2-sha256\$/);
  assert.equal(await verifyPassword(password, current), true);
});

test("partial JSON streaming decoding and root endpoint normalization", () => {
  assert.equal(partialReplyText('{"text":"你好\\n\\u4e16'), "你好\n世");
  assert.equal(partialReplyText('{"text":"你好\\u4e'), "你好");
  assert.equal(partialReplyText('{"text":"你好","media":{"images":[]}}'), "你好");
  assert.equal(partialReplyText("普通文字"), "普通文字");
  assert.equal(apiEndpoint("https://example.com"), "https://example.com/v1/chat/completions");
  assert.equal(apiEndpoint("https://example.com/v1/chat/completions"), "https://example.com/v1/chat/completions");
});
test("JSON remains readable when a gateway marks it as SSE", async () => {
  const response = new Response(JSON.stringify({ choices: [{ message: { content: "普通响应" } }] }), { headers: { "Content-Type": "text/event-stream" } });
  assert.equal(await consumeAIResponse(response), "普通响应");
});
test("production config rejects template placeholders before creating a database", async () => {
  const valid = { NODE_ENV: "production", JWT_SECRET: "fixture-secret-at-least-24-characters", ADMIN_PASSWORD: "fixture-admin-password" };
  assert.doesNotThrow(() => validateProductionConfig(valid));
  for (const value of ["replace-with-at-least-32-random-characters", "placeholder-for-a-long-secret", "example-long-secret-should-fail", "change-this-to-a-long-random-secret"]) assert.throws(() => validateProductionConfig({ ...valid, JWT_SECRET: value }), /JWT_SECRET/);
  for (const value of ["replace-with-a-long-unique-admin-password", "placeholder-admin-password", "admin123456"]) assert.throws(() => validateProductionConfig({ ...valid, ADMIN_PASSWORD: value }), /ADMIN_PASSWORD/);
  const root = await mkdtemp(resolve(tmpdir(), "mihoyo-failfast-test-"));
  try {
    await assert.rejects(createApplication({ root, env: { ...valid, JWT_SECRET: "replace-with-at-least-32-random-characters" } }), /JWT_SECRET/);
    await assert.rejects(import("node:fs/promises").then(fs => fs.stat(resolve(root, "app.db"))), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("network errors report a clear Chinese message without exposing the API key", async () => {
  const originalFetch = globalThis.fetch;
  const client = createTextClient({ key: "fixture-private-key", baseUrl: "https://fixture.invalid/v1", timeoutMs: 1000 });
  try {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
      globalThis.fetch = async () => { throw Object.assign(new Error("request failed"), { cause: { code } }); };
      await assert.rejects(client([{ role: "user", content: "fixture message" }], { model: "fixture-model" }), /文字接口连接失败.*本次不扣点/);
    }
    globalThis.fetch = async () => { throw new Error("upstream fixture-private-key denied"); };
    await assert.rejects(client([{ role: "user", content: "fixture message" }], { model: "fixture-model" }), error => error.message.includes("[hidden]") && !error.message.includes("fixture-private-key"));
  } finally { globalThis.fetch = originalFetch; }
});
test("light history quickly projects large legacy images without resizing, overwriting or exposing credentials", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mihoyo-history-preservation-"));
  const blockedImages = resolve(root, "blocked-images");
  await writeFile(blockedImages, "A file prevents image-directory creation.");
  const app = await createApplication({ root, env: { NODE_ENV: "test", LOCAL_DEV: "0", GENERATED_IMAGES_DIR: blockedImages, DB_PATH: resolve(root, "history.db"), TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" } });
  try {
    const address = await app.listen(0), created = "2026-10-05 00:00:00";
    const uid = Number(app.db.prepare("INSERT INTO users(account,password_hash,balance,created_at) VALUES(?,?,?,?)").run("history-fixture-user", "$disabled-fixture$", 10, created).lastInsertRowid);
    const pid = Number(app.db.prepare("INSERT INTO companion_profiles(user_id,character_name,relationship,created_at,updated_at) VALUES(?,?,?,?,?)").run(uid, "测试角色", "朋友", created, created).lastInsertRowid);
    const png = await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
    assert.equal(png.length > 2 * 1024 * 1024, true);
    const original = { images: [{ title: "需完整保留的历史图", url: `data:image/png;base64,${png.toString("base64")}`, prompt: "测试场景", requested_size: "1920x1080" }], audios: [], custom_field: "preserve" }, serialized = JSON.stringify(original);
    const messageId = Number(app.db.prepare("INSERT INTO companion_messages(user_id,profile_id,role,content,media_json,created_at) VALUES(?,?,?,?,?,?)").run(uid, pid, "assistant", "历史记录测试", serialized, created).lastInsertRowid);
    const token = app.signToken({ user_id: uid, exp: Math.floor(Date.now() / 1000) + 60 });
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/companion/history?profile_id=${pid}&media_mode=light`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
    const text = await response.text(); assert.equal(text.length < 8192, true); assert.equal(text.includes("data:image/"), false);
    const history = JSON.parse(text); assert.equal(history.success, true);
    const projected = history.items.find(item => item.id === messageId).media;
    assert.match(projected.images[0].url, /^\/api\/companion\/history-image\/\d+\/0\?signature=[A-Za-z0-9_-]{43}$/);
    assert.equal(projected.images[0].url.includes(token), false);
    assert.deepEqual({ ...projected, images: [{ ...projected.images[0], url: original.images[0].url }] }, original);
    const imageResponse = await fetch(base + projected.images[0].url);
    assert.equal(imageResponse.status, 200); assert.equal(imageResponse.headers.get("content-type"), "image/png"); assert.equal(Number(imageResponse.headers.get("content-length")), png.length);
    assert.match(imageResponse.headers.get("cache-control"), /^private,/);
    const retrieved = Buffer.from(await imageResponse.arrayBuffer());
    assert.equal(createHash("sha256").update(retrieved).digest("hex"), createHash("sha256").update(png).digest("hex"));
    assert.equal((await sharp(retrieved).metadata()).width, 1024); // no resize to the requested 1920x1080
    const cached = await fetch(base + projected.images[0].url, { headers: { "If-None-Match": imageResponse.headers.get("etag") } }); assert.equal(cached.status, 304); assert.equal(Number(cached.headers.get("content-length")), png.length);
    const forged = new URL(base + projected.images[0].url), signature = forged.searchParams.get("signature"); forged.searchParams.set("signature", (signature[0] === "A" ? "B" : "A") + signature.slice(1)); assert.equal((await fetch(forged)).status, 404);
    assert.equal((await fetch(base + projected.images[0].url.replace(`/${messageId}/0?`, `/${messageId}/1?`))).status, 404);
    const uid2 = Number(app.db.prepare("INSERT INTO users(account,password_hash,balance,created_at) VALUES(?,?,?,?)").run("other-history-user", "$disabled-fixture$", 10, created).lastInsertRowid);
    const otherId = Number(app.db.prepare("INSERT INTO companion_messages(user_id,profile_id,role,content,media_json,created_at) VALUES(?,?,?,?,?,?)").run(uid2, pid, "assistant", "另一用户图片", serialized, created).lastInsertRowid);
    assert.equal((await fetch(base + projected.images[0].url.replace(`/${messageId}/0?`, `/${otherId}/0?`))).status, 404);
    const repeat = await fetch(`${base}/api/companion/history?profile_id=${pid}&media_mode=light`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await repeat.json()).items.find(item => item.id === messageId).media.images[0].url, projected.images[0].url);
    assert.equal(app.db.prepare("SELECT media_json FROM companion_messages WHERE id=?").get(messageId).media_json, serialized);
    const full = await fetch(`${base}/api/companion/history?profile_id=${pid}&media_mode=full`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal((await full.json()).items.find(item => item.id === messageId).media.images[0].url, original.images[0].url);
    for (const unsafe of ["data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>throw new Error("blocked")</script></svg>').toString("base64"), "data:image/png;base64," + Buffer.from("<html>not an image</html>").toString("base64"), "data:image/jpeg;base64," + png.toString("base64")]) {
      app.db.prepare("UPDATE companion_messages SET media_json=? WHERE id=?").run(JSON.stringify({ images: [{ url: unsafe }] }), messageId);
      assert.equal((await fetch(base + projected.images[0].url)).status, 415);
    }
    app.db.prepare("UPDATE companion_messages SET media_json=? WHERE id=?").run(serialized, messageId);
    assert.equal((await fetch(base + projected.images[0].url)).status, 200);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test("Node API integration against a local mock upstream and a temporary SQLite database", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "mihoyo-node-test-"));
  const state = { requests: [], imageRejectSize: false, imageError: false };
  const fixture = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#b4a2e8" } }).png().toBuffer();
  const mock = createServer(async (req, res) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const data = body ? JSON.parse(body) : {}, message = (data.messages || data.input || []).at(-1)?.content || "";
      state.requests.push({ path: req.url, ...data });
      const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/v1/images/generations") {
        if (state.imageError) return json(503, { error: { message: "synthetic image outage" } });
        if (state.imageRejectSize && (data.size || data.aspect_ratio)) return json(400, { error: { message: "unsupported size or aspect_ratio" } });
        await sleep(30); return json(200, { data: [{ b64_json: fixture.toString("base64") }] });
      }
      if ((data.messages || data.input || [])[0]?.content?.includes("中文陪伴角色建档助手")) {
        return message.includes("无法识别")
          ? json(200, { choices: [{ message: { content: JSON.stringify({ status: "needs_more_info", concise_message: "请补充角色来源作品。" }) } }] })
          : json(200, { choices: [{ message: { content: JSON.stringify({ status: "ready", role_prompt: "测试角色是喜欢星空与文学的温柔朋友，始终用轻松自然的中文交流，在用户需要帮助时耐心倾听并给出具体建议。" }) } }] });
      }
      if (message === "http-error") return json(503, { error: { message: "synthetic provider unavailable" } });
      if (message === "empty") return json(200, { choices: [{ message: { content: "", reasoning_content: "private reasoning must not become the answer" } }] });
      if (message === "empty-json") return json(200, { choices: [{ message: { content: '{"text":""}' } }] });
      if (message === "timeout") { await sleep(300); if (!res.destroyed) return json(200, { choices: [{ message: { content: "迟到的文字" } }] }); return; }
      const answer = message.includes("中文小说") ? "测试小说大纲与章节正文" : JSON.stringify({ text: "你好，旅行者！", media: { images: [{ title: "相遇", prompt: "角色在星光下挥手" }] } });
      if (req.url === "/v1/responses") {
        if (!data.stream) return json(200, { output: [{ type: "message", content: [{ type: "output_text", text: answer }] }] });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const chunk of [answer.slice(0, 13), answer.slice(13)]) { res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: chunk })}\n\n`); await sleep(30); }
        res.end(`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: answer }] }] } })}\n\n`); return;
      }
      if (data.stream || message === "sse-despite-json") {
        res.writeHead(200, { "Content-Type": message === "sse-despite-json" ? "application/json" : "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", reasoning_content: "ignore" } }] })}\n\n`);
        for (const chunk of [answer.slice(0, 13), answer.slice(13, 20), answer.slice(20)]) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`); await sleep(30); }
        res.end("data: [DONE]\n\n"); return;
      }
      return json(200, { choices: [{ message: { content: [{ type: "text", text: answer }] } }] });
    } catch { if (!res.destroyed) res.end(); }
  });
  await new Promise(resolveMock => mock.listen(0, "127.0.0.1", resolveMock));
  const upstream = `http://127.0.0.1:${mock.address().port}/v1`;
  await mkdir(resolve(root, "assets"));
  await writeFile(resolve(root, "index.html"), "<h1>fixture page</h1>");
  await writeFile(resolve(root, ".env"), "PRIVATE=must-never-be-served");
  const presetFixture = { key: "fixture", character_name: "测试角色", relationship: "朋友", user_preference: "测试设定", role_prompt: "角色独立对话标记：喜欢以星光比喻的温柔朋友", image_prompt: "fixture-original-identity: silver hair, mint travel coat", game: "starrail", game_title: "崩坏：星穹铁道", rarity: 5, element: "火", region: "星海", avatar_url: "/web/assets/fixture-avatar.webp", portrait_url: "/web/assets/fixture-portrait.png", sources: ["https://example.test/official/fixture"], allowed_types: ["text", "image", "audio", "video"] };
  let currentPreset = presetFixture;
  const writeCatalog = () => writeFile(resolve(root, "companion_presets.json"), JSON.stringify({ presets: [currentPreset] }));
  await writeCatalog();
  // Exercise additive migration from the original Python schema without the two added columns.
  const old = new DatabaseSync(resolve(root, "app.db"));
  old.exec("CREATE TABLE verify_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, code TEXT NOT NULL, expire_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL); CREATE TABLE companion_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,character_name TEXT NOT NULL,relationship TEXT NOT NULL,user_preference TEXT,profile_json TEXT,search_summary TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"); old.close();
  const env = { NODE_ENV: "test", LOCAL_DEV: "1", DEV_SKIP_CAPTCHA: "0", JWT_SECRET: "fixture-jwt-secret-for-test-only", ADMIN_PASSWORD: "fixture-admin-password", PAY_CALLBACK_SECRET: "fixture-pay-secret", AI_API_KEY: "fixture-key", AI_BASE_URL: upstream, AI_COMPANION_MODEL: "fixture-chat-model", AI_NOVEL_MODEL: "fixture-novel-model", AI_IMAGE_KEY: "fixture-image-key", AI_IMAGE_ENDPOINT: upstream, AI_IMAGE_API_MODE: "image", AI_IMAGE_MODEL: "fixture-image-model", TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "", ALLOW_MOCK_PAYMENT: "false", SSE_HEARTBEAT_MS: "25", AI_TIMEOUT_MS: "180000" };
  let app = await createApplication({ root, env }), address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  let token, profileId;
  const request = async (path, data, auth = token, method = data === undefined ? "GET" : "POST") => {
    const response = await fetch(base + path, { method, headers: { ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    const value = await response.json(); return { status: response.status, ...value };
  };
  t.after(async () => { await app.close(); mock.closeAllConnections(); await new Promise(resolveClose => mock.close(resolveClose)); await rm(root, { recursive: true, force: true }); });

  await t.test("registration, captcha single use / expiry, existing JWT, legacy password login", async () => {
    const captcha = await request("/api/auth/captcha", undefined, "");
    assert.equal(captcha.success, true);
    const code = await request("/api/auth/send-code", { account: "fixture-user", captcha_token: captcha.token, captcha_code: captcha.dev_code }, "");
    assert.equal(code.success, true);
    assert.equal((await request("/api/auth/send-code", { account: "fixture-user", captcha_token: captcha.token, captcha_code: captcha.dev_code }, "")).success, false);
    assert.equal((await request("/api/auth/register", { account: "fixture-user", password: "test-password", code: code.dev_code, captcha_token: captcha.token }, "")).success, true);
    const loginCaptcha = await request("/api/auth/captcha", undefined, "");
    const login = await request("/api/auth/login", { account: "fixture-user", password: "test-password", captcha_token: loginCaptcha.token, captcha_code: loginCaptcha.dev_code }, ""); assert.equal(login.success, true); token = login.token;
    assert.equal((await request("/api/me")).user.balance, 100);
    const oldToken = app.signToken({ user_id: login.user.id, exp: Math.floor(Date.now() / 1000) + 60 });
    assert.equal((await request("/api/me", undefined, oldToken)).success, true);
    const expired = app.signToken({ user_id: login.user.id, exp: 1 }); assert.equal((await request("/api/me", undefined, expired)).success, false);
    const stale = await request("/api/auth/captcha", undefined, ""); app.db.prepare("UPDATE captcha_codes SET expire_at='2000-01-01 00:00:00' WHERE token_hash=?").run(createHash("sha256").update(stale.token).digest("hex"));
    assert.equal((await request("/api/auth/login", { account: "fixture-user", password: "test-password", captcha_token: stale.token, captcha_code: stale.dev_code }, "")).success, false);
    const salt = Buffer.from("python-compatible-salt"), pyHash = `$pbkdf2-sha256$29000$${encoded(salt)}$${encoded(pbkdf2Sync("old-password", salt, 29000, 32, "sha256"))}`;
    app.db.prepare("INSERT INTO users(account,password_hash,balance,created_at) VALUES(?,?,?,?)").run("old-python-user", pyHash, 10, "2026-01-01 00:00:00");
    const legacyCaptcha = await request("/api/auth/captcha", undefined, "");
    assert.equal((await request("/api/auth/login", { account: "old-python-user", password: "old-password", captcha_token: legacyCaptcha.token, captcha_code: legacyCaptcha.dev_code }, "")).success, true);
  });
  await t.test("public static allowlist, invalid body and Turnstile config", async () => {
    assert.equal((await fetch(base + "/web/index.html")).status, 200);
    for (const path of ["/web/.env", "/web/app.db", "/web/server.py", "/web/backend-node/server.mjs", "/web/assets/%2e%2e%2f.env", "/web/assets/%5c..%5c.env"]) assert.equal((await fetch(base + path)).status, 404);
    const malformed = await fetch(base + "/api/auth/register", { method: "POST", body: "{" }); assert.equal(malformed.status, 400);
    assert.equal((await request("/api/auth/turnstile-config", undefined, "")).enabled, false);
    assert.equal((await request("/api/pay/alipay/mock-success", { order_no: "any" })).status, 404);
    const health = await request("/health", undefined, ""); assert.equal(health.service, "node-api"); assert.equal(health.local_dev, true); assert.equal(health.db_path, undefined);
  });
  await t.test("role profile reuse, JSON replies, array content and history persistence", async () => {
    const profile = await request("/api/companion/profile", { preset_key: "fixture" }); profileId = profile.profile_id;
    assert.equal(profile.success, true);
    assert.equal((await request("/api/companion/profile", { preset_key: "fixture" })).reused, true);
    const reply = await request("/api/companion/chat", { profile_id: profileId, message: "hello" });
    assert.equal(reply.reply.text, "你好，旅行者！"); assert.equal(reply.balance, 95); assert.equal(reply.user_message_id > 0, true);
    assert.equal((await request(`/api/companion/history?profile_id=${profileId}`)).items.length, 2);
    assert.equal(state.requests.at(-1).model, "fixture-chat-model");
    assert.equal((await request("/api/companion/chat", { profile_id: 99999, message: "hello" })).success, false);
  });
  await t.test("catalog metadata is public while prompts stay internal, and existing profiles refresh without losing preferences", async () => {
    const uid = (await request("/api/me")).user.id, originalBalance = (await request("/api/me")).user.balance;
    const catalog = await request("/api/companion/presets"), item = catalog.items[0];
    for (const key of ["game", "game_title", "rarity", "element", "region", "avatar_url", "portrait_url", "sources"]) assert.deepEqual(item[key], presetFixture[key]);
    assert.equal(item.role_prompt, undefined); assert.equal(item.user_preference, undefined); assert.equal(item.image_prompt, undefined);
    app.db.prepare("UPDATE companion_profiles SET character_name=?,user_preference=?,profile_json=?,search_summary=? WHERE id=?").run("过时角色名", presetFixture.user_preference, JSON.stringify(presetFixture), "过时资料", profileId);
    currentPreset = { ...presetFixture, character_name: "更新测试角色", summary: "新版简明资料", role_prompt: "fixture-updated-voice：用清楚短句表达关心的独立旅人", image_prompt: "fixture-updated-appearance: silver hair, emerald coat, unique star brooch", portrait_url: "/web/assets/updated-portrait.png" };
    await writeCatalog();
    const projected = (await request("/api/companion/profiles")).items.find(x => x.id === profileId);
    assert.equal(projected.character_name, currentPreset.character_name); assert.equal(projected.portrait_url, currentPreset.portrait_url); assert.equal(projected.catalog_available, true);
    assert.equal(projected.role_prompt, undefined); assert.equal(projected.image_prompt, undefined);
    assert.equal((await request("/api/companion/chat", { profile_id: profileId, message: "catalog-update-check" })).success, true);
    let system = state.requests.at(-1).messages[0].content;
    assert.match(system, /fixture-updated-voice/); assert.doesNotMatch(system, /测试设定|过时资料|过时角色名/);
    app.db.prepare("UPDATE companion_profiles SET user_preference=? WHERE id=?").run("个人偏好：请叫我旅行者", profileId);
    assert.equal((await request("/api/companion/chat", { profile_id: profileId, message: "personal-preference-check" })).success, true);
    system = state.requests.at(-1).messages[0].content; assert.match(system, /fixture-updated-voice/); assert.match(system, /个人偏好：请叫我旅行者/);
    const reopened = await request("/api/companion/profile", { preset_key: "fixture" });
    assert.equal(reopened.reused, true); assert.equal(reopened.profile_id, profileId);
    assert.equal(app.db.prepare("SELECT user_preference FROM companion_profiles WHERE id=?").get(profileId).user_preference, "个人偏好：请叫我旅行者");
    const count = app.db.prepare("SELECT COUNT(*) n FROM companion_profiles").get().n, requests = state.requests.length;
    for (const preset_key of ["preset_01", "unknown-key"]) { const result = await request("/api/companion/profile", { preset_key, character_name: "企图降级为自定义角色" }); assert.equal(result.success, false); assert.match(result.message, /移除或不存在/); }
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM companion_profiles").get().n, count); assert.equal(state.requests.length, requests);
    app.db.prepare("UPDATE users SET balance=? WHERE id=?").run(originalBalance, uid);
  });
  await t.test("removed presets retain their existing history and text access without restoring media permissions", async () => {
    const uid = (await request("/api/me")).user.id, balance = (await request("/api/me")).user.balance, date = "2026-10-05 10:00:00";
    const oldProfile = Number(app.db.prepare("INSERT INTO companion_profiles(user_id,character_name,relationship,user_preference,profile_json,search_summary,preset_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(uid, "下架旧角色", "朋友", "历史个人偏好", JSON.stringify({ role_prompt: "旧角色独立设定" }), "历史资料", "preset_01", date, date).lastInsertRowid);
    const messageId = Number(app.db.prepare("INSERT INTO companion_messages(user_id,profile_id,role,content,media_json,created_at) VALUES(?,?,?,?,?,?)").run(uid, oldProfile, "assistant", "须保留的历史回复", JSON.stringify({ images: [{ url: "/web/assets/old.png" }] }), date).lastInsertRowid);
    const history = await request(`/api/companion/history?profile_id=${oldProfile}&media_mode=light`);
    assert.equal(history.items[0].id, messageId); assert.equal(history.items[0].content, "须保留的历史回复");
    assert.equal(history.profile.catalog_available, false); assert.deepEqual(history.profile.allowed_types, ["text"]);
    const response = await request("/api/companion/chat", { profile_id: oldProfile, message: "existing-retired-profile", reply_types: ["image"] });
    assert.equal(response.success, true); assert.deepEqual(response.reply.media.images, []);
    const system = state.requests.at(-1).messages[0].content; assert.match(system, /旧角色独立设定/); assert.match(system, /历史个人偏好/);
    assert.equal(app.db.prepare("SELECT content FROM companion_messages WHERE id=?").get(messageId).content, "须保留的历史回复");
    app.db.prepare("UPDATE users SET balance=? WHERE id=?").run(balance, uid);
  });
  await t.test("custom role AI onboarding and needs_more_info compatibility", async () => {
    const profile = await request("/api/companion/profile", { character_name: "原创星空少女", relationship: "朋友", user_preference: "温柔的图书管理员，喜欢文学和星空" });
    assert.equal(profile.success, true); assert.equal(profile.profile.profile_source, "chat_model");
    const incomplete = await request("/api/companion/profile", { character_name: "无法识别" }); assert.equal(incomplete.success, false); assert.equal(incomplete.need_more_info, true);
  });
  await t.test("true streaming emits deltas / heartbeat before terminal done and persists full reply", async () => {
    const response = await fetch(base + "/api/companion/chat/stream", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ profile_id: profileId, message: "stream" }) });
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const reader = response.body.getReader(), decoder = new TextDecoder(); let value = "", sawEarlyDelta = false;
    while (true) { const chunk = await reader.read(); if (chunk.done) break; value += decoder.decode(chunk.value, { stream: true }); if (value.includes("event: delta") && !value.includes("event: done")) sawEarlyDelta = true; }
    assert.equal(sawEarlyDelta, true); assert.match(value, /: heartbeat/); assert.match(value, /event: done/); assert.doesNotMatch(value, /private reasoning/);
    const done = JSON.parse(value.match(/event: done\ndata: ([^\n]+)/)[1]); assert.equal(done.reply.text, "你好，旅行者！"); assert.equal(done.balance, 90);
  });
  await t.test("SSE returned despite JSON mode, errors and empty final text never charge", async () => {
    assert.equal((await request("/api/companion/chat", { profile_id: profileId, message: "sse-despite-json" })).success, true);
    const balance = (await request("/api/me")).user.balance;
    for (const message of ["empty", "empty-json", "http-error"]) assert.equal((await request("/api/companion/chat", { profile_id: profileId, message })).success, false);
    assert.equal((await request("/api/me")).user.balance, balance);
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM ai_logs WHERE success=0").get().n, 3);
  });
  await t.test("concurrent charges add correctly and never overdraw", async () => {
    const uid = (await request("/api/me")).user.id; app.db.prepare("UPDATE users SET balance=10 WHERE id=?").run(uid);
    const results = await Promise.all(Array.from({ length: 3 }, () => request("/api/companion/chat", { profile_id: profileId, message: "concurrent" })));
    assert.equal(results.filter(x => x.success).length, 2); assert.equal((await request("/api/me")).user.balance, 0);
    app.db.prepare("UPDATE users SET balance=100 WHERE id=?").run(uid);
  });
  await t.test("async image task, fallback payloads, exact portrait dimensions and owner isolation", async () => {
    state.imageRejectSize = true;
    const response = await fetch(base + "/api/companion/chat/stream", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ profile_id: profileId, message: "draw", reply_types: ["text", "image"], image_quality: "1080p", image_aspect_ratio: "9:16", image_tone: "cinematic" }) });
    const text = await response.text(), done = JSON.parse(text.match(/event: done\ndata: ([^\n]+)/)[1]), taskId = done.reply.media.images[0].task_id;
    assert.equal(done.reply.media.images[0].status, "pending"); assert.equal(done.reply.media.images[0].requested_size, "1080x1920");
    let task;
    for (let attempt = 0; attempt < 60; attempt++) { task = await request(`/api/companion/image-task/${taskId}`); if (["done", "error"].includes(task.status)) break; await sleep(20); }
    assert.equal(task.status, "done");
    const url = task.media.images[0].url; assert.match(url, /^\/web\/assets\/generated_images\//);
    const asset = await fetch(base + url); assert.equal(asset.status, 200);
    const metadata = await sharp(Buffer.from(await asset.arrayBuffer())).metadata(); assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920);
    const other = app.signToken({ user_id: app.db.prepare("SELECT id FROM users WHERE account='old-python-user'").get().id, exp: Math.floor(Date.now() / 1000) + 60 });
    assert.equal((await request(`/api/companion/image-task/${taskId}`, undefined, other)).status, 404);
    const stored = (await request(`/api/companion/history?profile_id=${profileId}`)).items.find(x => x.id === done.assistant_message_id); assert.equal(stored.media.images[0].url, url);
    assert.equal(state.requests.filter(x => x.path === "/v1/images/generations").some(x => !x.size && !x.aspect_ratio), true);
    const imageRequest = state.requests.filter(x => x.path === "/v1/images/generations").at(-1);
    assert.match(imageRequest.prompt, /fixture-updated-appearance/); assert.match(imageRequest.prompt, /角色在星光下挥手/); assert.doesNotMatch(imageRequest.prompt, /fixture-original-identity/);
    state.imageRejectSize = false;
  });
  await t.test("image failure preserves successful text and records terminal error", async () => {
    state.imageError = true;
    const response = await fetch(base + "/api/companion/chat/stream", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ profile_id: profileId, message: "draw failure", reply_types: ["image"] }) });
    const value = await response.text(), done = JSON.parse(value.match(/event: done\ndata: ([^\n]+)/)[1]);
    let task; for (let i = 0; i < 60; i++) { task = await request(`/api/companion/image-task/${done.reply.media.images[0].task_id}`); if (task.status === "error") break; await sleep(10); }
    assert.equal(task.status, "error"); assert.equal(done.reply.text, "你好，旅行者！"); assert.equal(done.cost, 5); state.imageError = false;
  });
  await t.test("unfinished persisted image jobs resume after restart; legacy inline images remain accessible", async () => {
    const uid = (await request("/api/me")).user.id, taskId = "0123456789abcdef0123456789abcdef";
    const media = { images: [{ title: "重启测试", prompt: "stale-composed-identity: previous generic character", status: "pending", task_id: taskId, requested_size: "1080x1080" }], videos: [], audios: [] };
    const aid = Number(app.db.prepare("INSERT INTO companion_messages(user_id,profile_id,role,content,media_json,created_at) VALUES(?,?,?,?,?,?)").run(uid, profileId, "assistant", "恢复测试回复", JSON.stringify(media), "2026-10-05 10:00:00").lastInsertRowid);
    app.db.prepare("INSERT INTO companion_image_tasks(task_id,user_id,profile_id,assistant_message_id,status,stage,message,progress,api_started,created_at,updated_at,started_ms,reply_json,options_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(taskId, uid, profileId, aid, "running", "api", "服务重启前正在生成", 8, 1, "2026-10-05 10:00:00", "2026-10-05 10:00:00", Date.now(), JSON.stringify({ text: "恢复测试回复", media }), JSON.stringify({ image_quality: "1080p", image_aspect_ratio: "1:1" }));
    currentPreset = { ...currentPreset, image_prompt: "fixture-restarted-identity: emerald coat and star brooch after catalog refresh" }; await writeCatalog();
    await app.close(); app = await createApplication({ root, env }); address = await app.listen(0); base = `http://127.0.0.1:${address.port}`;
    let task; for (let i = 0; i < 60; i++) { task = await request(`/api/companion/image-task/${taskId}`); if (["done", "error"].includes(task.status)) break; await sleep(15); } assert.equal(task.status, "done");
    const restartedRequest = state.requests.filter(x => x.path === "/v1/images/generations").at(-1);
    assert.match(restartedRequest.prompt, /fixture-restarted-identity/); assert.doesNotMatch(restartedRequest.prompt, /stale-composed-identity|fixture-original-identity/);
    const legacyId = Number(app.db.prepare("INSERT INTO companion_messages(user_id,profile_id,role,content,media_json,created_at) VALUES(?,?,?,?,?,?)").run(uid, profileId, "assistant", "历史图片测试", JSON.stringify({ images: [{ title: "历史图片", url: `data:image/png;base64,${fixture.toString("base64")}` }] }), "2026-10-05 10:00:00").lastInsertRowid);
    const history = await request(`/api/companion/history?profile_id=${profileId}&media_mode=light&limit=100`), legacy = history.items.find(x => x.id === legacyId);
    assert.match(legacy.media.images[0].url, /^\/api\/companion\/history-image\//); assert.equal((await fetch(base + legacy.media.images[0].url)).status, 200);
    assert.equal(JSON.parse(app.db.prepare("SELECT media_json FROM companion_messages WHERE id=?").get(legacyId).media_json).images[0].url, `data:image/png;base64,${fixture.toString("base64")}`);
  });
  await t.test("novel history, Python float callback signatures, concurrent callback idempotence and admin export", async () => {
    const novel = await request("/api/ai/generate-outline", { novel_type: "幻想", protagonist: "测试主角", background: "星空", style: "轻小说" }); assert.equal(novel.success, true); assert.equal(novel.cost, 20); assert.equal((await request("/api/ai/history")).items.length, 1);
    const before = (await request("/api/me")).user.balance, order = await request("/api/pay/alipay/create-order", { amount: 39 });
    const sign = createHmac("sha256", "fixture-pay-secret").update(`${order.order_no}|39.0|test-trade`).digest("hex");
    const callbacks = await Promise.all(Array.from({ length: 3 }, () => request("/api/pay/alipay/callback", { order_no: order.order_no, amount: 39, trade_no: "test-trade", sign }, ""))); assert.equal(callbacks.every(x => x.success), true); assert.equal((await request("/api/me")).user.balance, before + 5000);
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM wallet_logs WHERE log_type='RECHARGE'").get().n, 1);
    const admin = await request("/api/admin/login", { password: "fixture-admin-password" }, "");
    assert.equal((await request("/api/admin/bootstrap", undefined, admin.token)).users.length, 2);
    const xlsx = await fetch(base + "/api/admin/export.xlsx", { headers: { Authorization: `Bearer ${admin.token}` } }); assert.equal(xlsx.status, 200); assert.equal(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString(), "PK");
  });
  await t.test("Responses API stream/JSON and timeout configuration", async () => {
    await app.close(); app = await createApplication({ root, env: { ...env, AI_TEXT_API_MODE: "responses", AI_TIMEOUT_MS: "1000" } }); address = await app.listen(0); base = `http://127.0.0.1:${address.port}`;
    const json = await request("/api/companion/chat", { profile_id: profileId, message: "response-json" }); assert.equal(json.reply.text, "你好，旅行者！");
    const response = await fetch(base + "/api/companion/chat/stream", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ profile_id: profileId, message: "response-stream" }) }); const stream = await response.text(); assert.match(stream, /event: delta/); assert.match(stream, /event: done/);
    assert.equal(state.requests.at(-1).path, "/v1/responses");
    await app.close(); app = await createApplication({ root, env: { ...env, AI_TIMEOUT_MS: "30" } }); address = await app.listen(0); base = `http://127.0.0.1:${address.port}`;
    const before = (await request("/api/me")).user.balance, result = await request("/api/companion/chat", { profile_id: profileId, message: "timeout" }); assert.equal(result.success, false); assert.match(result.message, /超时/); assert.equal((await request("/api/me")).user.balance, before);
  });
});
