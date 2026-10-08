import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import { createApplication } from "../app.mjs";
import { inspectWav, normalizeCompletedWav, synthesisEndpoint } from "../cosyvoice.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));
function wav() {
  const bytes = Buffer.alloc(44 + 48000); bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(48000, 40);
  for (let i = 0; i < 24000; i++) bytes.writeInt16LE(Math.round(Math.sin(i / 13) * 2000), 44 + i * 2);
  return bytes;
}
async function fixture(t, state = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "mihoyo-cosyvoice-test-")), bytes = wav(), png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#cfeaff" } }).png().toBuffer();
  Object.assign(state, { textCalls: 0, ttsCalls: 0, downloads: 0, imageCalls: 0 });
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url === "/v1/chat/completions") {
      state.textCalls++; state.textBody = payload; await sleep(state.textDelay || 0);
      const reply = JSON.stringify({ text: "今天也想与你一起看看星空。", media: { images: [{ prompt: "穿外套在花园挥手" }], audios: [{ url: "https://fake.invalid/pretend.mp3", text: "fake" }] } });
      if (payload.stream) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(0, 12) } }] })}\n\n`); await sleep(10); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(12) } }] })}\n\ndata: [DONE]\n\n`); }
      else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: reply } }] })); } return;
    }
    if (req.url === "/api/v1/services/audio/tts/SpeechSynthesizer") {
      state.ttsCalls++; state.ttsBody = payload; state.ttsAuthorization = req.headers.authorization; state.ttsStarted?.(); await sleep(state.ttsDelay || 0);
      if (state.mode === "http-error") { res.writeHead(403); res.end(JSON.stringify({ message: "fixture-key private upstream details" })); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ output: { finish_reason: "stop", audio: { url: state.mode === "unsafe-url" ? "http://169.254.169.254/latest/meta-data" : `${url}/generated.wav` } } })); return;
    }
    if (req.url === "/generated.wav") {
      state.downloads++; state.downloadAuthorization = req.headers.authorization;
      const result = Buffer.from(bytes); if (state.mode === "provider-placeholder") { result.writeUInt32LE(0x7fffffbf, 4); result.writeUInt32LE(0x7fffff9b, 40); }
      res.setHeader("Content-Type", "audio/wav"); res.end(state.mode === "corrupt" ? bytes.subarray(0, 1200) : result); return;
    }
    if (req.url === "/v1/images/generations") { state.imageCalls++; await sleep(state.imageDelay || 0); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(done => upstream.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${upstream.address().port}`;
  // Match the real production catalog: all current presets declare only text/image.
  const presets = [{ key: "preset_03", character_name: "测试旅人", relationship: "恋人", role_prompt: "温柔的成年旅人", image_prompt: "adult traveller wearing a coat", media_enabled: true, allowed_types: ["text", "image"] }, { key: "preset_02", character_name: "待上传角色", media_enabled: true, allowed_types: ["text", "image"] }];
  const voiceCatalog = { version: 1, model: "cosyvoice-v3.5-flash", voices: { preset_03: { name: "测试旅人", model: "cosyvoice-v3.5-flash", voice_id: "fixture-specific-voice", status: "ready" }, preset_02: { name: "待上传角色", status: "pending_upload" } } };
  await writeFile(resolve(root, "companion_presets.json"), JSON.stringify({ presets })); await writeFile(resolve(root, "companion_voice_catalog.json"), JSON.stringify(voiceCatalog)); await mkdir(resolve(root, "assets"));
  const app = await createApplication({ root, ttsEnvFile: resolve(root, "missing.env"), env: { LOCAL_DEV: "1", AI_PROFILE_GENERATION: "off", AI_API_KEY: "fixture-text-key", AI_BASE_URL: `${url}/v1`, AI_COMPANION_MODEL: "fixture-text", AI_IMAGE_BASE_URL: `${url}/v1`, AI_IMAGE_API_KEY: "fixture-image-key", AI_IMAGE_MODEL: "fixture-image", AI_IMAGE_API_MODE: "image", MEDIA_TTS_PROVIDER: "cosyvoice", DASHSCOPE_API_KEY: "fixture-key", DASHSCOPE_BASE_HTTP_API_URL: `${url}/api/v1`, COSYVOICE_MODEL: "cosyvoice-v3.5-flash", COSYVOICE_TIMEOUT_MS: "1000", ...state.env } });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  app.db.prepare("INSERT INTO users(id,account,password_hash,balance,created_at) VALUES(?,?,?,?,?)").run(1, "voice-fixture", "unused", state.balance ?? 100, "2026-10-07 00:00:00");
  app.db.prepare("INSERT INTO users(id,account,password_hash,balance,created_at) VALUES(?,?,?,?,?)").run(2, "other-fixture", "unused", 100, "2026-10-07 00:00:00");
  const token = app.signToken({ user_id: 1, exp: Math.floor(Date.now() / 1000) + 3600 }), otherToken = app.signToken({ user_id: 2, exp: Math.floor(Date.now() / 1000) + 3600 });
  const request = (path, body, options = {}) => fetch(base + path, { headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...options.headers }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), ...options });
  const profile = await (await request("/api/companion/profile", { preset_key: "preset_03" })).json(); assert.equal(profile.success, true);
  const chat = async (extra = {}) => (await request("/api/companion/chat", { profile_id: profile.profile_id, message: "测试问候", reply_types: ["text", "audio"], ...extra })).json();
  t.after(async () => { await app.close(); upstream.closeAllConnections(); await new Promise(done => upstream.close(done)); assert.ok(root.startsWith(resolve(tmpdir(), "mihoyo-cosyvoice-test-"))); await rm(root, { recursive: true, force: true }); });
  return { app, state, root, base, bytes, request, chat, profile, token, otherToken, voiceCatalog, presets };
}

test("production text/image presets expose their ready voice consistently and actually synthesize the selected audio reply", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.presets[0].allowed_types, ["text", "image"]);
  assert.ok(Number.isSafeInteger(f.profile.profile_id)); assert.equal(f.profile.profile.id, f.profile.profile_id);
  assert.equal(f.profile.profile.voice_available, true); assert.equal(f.profile.profile.voice_status, "ready"); assert.deepEqual(f.profile.profile.allowed_types, ["text", "image", "audio"]);
  const catalog = await (await f.request("/api/companion/presets")).json(), ready = catalog.items.find(row => row.key === "preset_03"), pending = catalog.items.find(row => row.key === "preset_02");
  assert.equal(ready.voice_available, true); assert.equal(ready.voice_status, "ready"); assert.deepEqual(ready.allowed_types, ["text", "image", "audio"]);
  assert.equal(pending.voice_available, false); assert.equal(pending.voice_status, "pending_upload"); assert.deepEqual(pending.allowed_types, ["text", "image"]);
  const profiles = await (await f.request("/api/companion/profiles")).json(); assert.equal(profiles.items[0].voice_available, true); assert.equal(profiles.items[0].voice_status, "ready"); assert.deepEqual(profiles.items[0].allowed_types, ready.allowed_types);
  assert.ok(Number.isSafeInteger(profiles.items[0].id)); assert.equal(profiles.items[0].id, f.profile.profile_id);
  const otherProfiles = await (await fetch(f.base + "/api/companion/profiles", { headers: { Authorization: `Bearer ${f.otherToken}` } })).json(); assert.deepEqual(otherProfiles.items, []);
  const result = await f.chat(); assert.equal(result.success, true); assert.equal(result.cost, 10); assert.equal(result.balance, 90); assert.equal(result.reply.media.audios.length, 1); assert.equal(f.state.ttsCalls, 1); assert.equal(f.state.ttsBody.input.voice, "fixture-specific-voice");
  assert.match(f.state.textBody.messages[0].content, /本次允许的媒体：text、audio/);
  const history = await (await f.request(`/api/companion/history?profile_id=${f.profile.profile_id}`)).json(); assert.equal(history.profile.voice_available, true); assert.deepEqual(history.profile.allowed_types, ready.allowed_types); assert.ok(Number.isSafeInteger(history.profile.id)); assert.equal(history.profile.id, f.profile.profile_id);
  const ownProfile = f.app.db.prepare("SELECT user_id FROM companion_profiles WHERE id=?").get(f.profile.profile_id); assert.equal(ownProfile.user_id, 1);
  for (const response of [f.profile, catalog, profiles, history, result]) assert.doesNotMatch(JSON.stringify(response), /fixture-specific-voice|fixture-key|fixture-text-key|fixture-image-key/);
  assert.deepEqual(JSON.parse(await readFile(resolve(f.root, "companion_presets.json"), "utf8")).presets[0].allowed_types, ["text", "image"]);
});

test("custom, removed and explicitly media-disabled profiles remain text-only and never borrow a ready voice", async t => {
  const f = await fixture(t), custom = await (await f.request("/api/companion/profile", { character_name: "原创角色" })).json();
  assert.equal(custom.profile.voice_available, false); assert.deepEqual(custom.profile.allowed_types, ["text"]);
  const customReply = await f.chat({ profile_id: custom.profile_id }); assert.equal(customReply.cost, 5); assert.deepEqual(customReply.reply.media.audios, []); assert.equal(customReply.reply.media.audio_status.status, "unavailable");
  const legacyId = Number(f.app.db.prepare("INSERT INTO companion_profiles(user_id,character_name,relationship,user_preference,profile_json,search_summary,preset_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(1, "下架角色", "恋人", "", "{}", "旧历史保留", "preset_01", "2026-10-07 00:00:00", "2026-10-07 00:00:00").lastInsertRowid);
  f.voiceCatalog.voices.preset_01 = { status: "ready", model: "cosyvoice-v3.5-flash", voice_id: "fixture-retired-voice" }; await writeFile(resolve(f.root, "companion_voice_catalog.json"), JSON.stringify(f.voiceCatalog));
  const retiredReply = await f.chat({ profile_id: legacyId }); assert.equal(retiredReply.success, true); assert.equal(retiredReply.cost, 5); assert.equal(retiredReply.reply.media.audio_status.status, "unavailable");
  f.presets[0].media_enabled = false; await writeFile(resolve(f.root, "companion_presets.json"), JSON.stringify({ presets: f.presets }));
  const disabledReply = await f.chat(); assert.equal(disabledReply.cost, 5); assert.equal(disabledReply.reply.media.audio_status.status, "unavailable");
  const profiles = await (await f.request("/api/companion/profiles")).json();
  for (const row of profiles.items) { assert.equal(row.voice_available, false); assert.deepEqual(row.allowed_types, ["text"]); }
  assert.equal(f.state.ttsCalls, 0); assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM wallet_logs WHERE log_type='AI_COMPANION_AUDIO'").get().n, 0);
});

test("CosyVoice official endpoint aliases and complete WAV validation", () => {
  assert.equal(synthesisEndpoint({ BASE_HTTP_API_URL: "https://dashscope.aliyuncs.com/api/v1" }), "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
  assert.equal(synthesisEndpoint({ BASE_WEBSOCKET_API_URL: "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference" }), "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
  assert.equal(inspectWav(wav()).duration_seconds, 1); assert.throws(() => inspectWav(wav().subarray(0, 44)), /不完整/);
  assert.throws(() => synthesisEndpoint({ BASE_HTTP_API_URL: "http://169.254.169.254" }), /HTTPS/);
});

test("completed provider WAV paired placeholders are repaired without relaxing ordinary truncation checks", async t => {
  const original = wav(), streaming = Buffer.from(original); streaming.writeUInt32LE(0x7fffffbf, 4); streaming.writeUInt32LE(0x7fffff9b, 40);
  assert.throws(() => inspectWav(streaming), /不完整/); assert.deepEqual(normalizeCompletedWav(streaming), original);
  assert.throws(() => normalizeCompletedWav(streaming.subarray(0, streaming.length - 1)), /编码/);
  assert.throws(() => normalizeCompletedWav(original.subarray(0, original.length - 2)), /不完整/);
  const mismatched = Buffer.from(streaming); mismatched.writeUInt32LE(0x7fffff9a, 40); assert.throws(() => normalizeCompletedWav(mismatched), /不完整/);
  const f = await fixture(t, { mode: "provider-placeholder" }), result = await f.chat(); assert.equal(result.cost, 10); assert.equal(result.reply.media.audios[0].duration_seconds, 1);
  assert.deepEqual(Buffer.from(await (await fetch(f.base + result.reply.media.audios[0].url)).arrayBuffer()), f.bytes);
});

test("successful speech is persisted, charged exactly once, and signed history/playback stays free", async t => {
  const f = await fixture(t), result = await f.chat();
  assert.equal(result.success, true); assert.equal(result.cost, 10); assert.equal(result.balance, 90); assert.deepEqual(result.cost_breakdown, { text: 5, audio: 5 });
  const audio = result.reply.media.audios[0]; assert.equal(audio.provider, "cosyvoice"); assert.equal(audio.duration_seconds, 1); assert.equal(audio.text, result.reply.text); assert.equal(audio.file, undefined);
  assert.deepEqual(f.state.ttsBody, { model: "cosyvoice-v3.5-flash", input: { text: result.reply.text, voice: "fixture-specific-voice", format: "wav", sample_rate: 24000 } }); assert.equal(f.state.ttsAuthorization, "Bearer fixture-key"); assert.equal(f.state.downloadAuthorization, undefined);
  for (let i = 0; i < 3; i++) { const response = await fetch(f.base + audio.url); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "audio/wav"); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes); }
  const partial = await fetch(f.base + audio.url, { headers: { Range: "bytes=0-15" } }); assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 16);
  const history = await (await f.request(`/api/companion/history?profile_id=${f.profile.profile_id}&media_mode=light`)).json(); assert.equal(history.items.at(-1).media.audios[0].duration_seconds, 1); assert.equal(f.state.ttsCalls, 1);
  assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM wallet_logs WHERE log_type='AI_COMPANION_AUDIO'").get().n, 1); assert.equal(f.app.db.prepare("SELECT balance FROM users WHERE id=1").get().balance, 90); assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM companion_credit_holds").get().n, 0);
  const stored = JSON.parse(f.app.db.prepare("SELECT media_json FROM companion_messages WHERE id=?").get(result.assistant_message_id).media_json); assert.match(stored.audios[0].file, /\.wav$/); assert.equal(stored.audios[0].url, undefined);
  const publicJson = JSON.stringify(await (await f.request("/api/companion/presets")).json()) + JSON.stringify(await (await fetch(f.base + "/health")).json()) + JSON.stringify(result);
  assert.doesNotMatch(publicJson, /fixture-key|fixture-specific-voice|fake.invalid|generated.wav/);
  const forged = new URL(f.base + audio.url); forged.searchParams.set("signature", "A".repeat(43)); assert.equal((await fetch(forged)).status, 404);
  const expired = new URL(f.base + audio.url); expired.searchParams.set("expires", "1"); assert.equal((await fetch(expired)).status, 404);
  assert.equal((await fetch(f.base + audio.url, { headers: { Authorization: `Bearer ${f.otherToken}` } })).status, 404);
});

test("pending and missing voices never borrow an available character voice; metadata refreshes dynamically", async t => {
  const f = await fixture(t), pending = await (await f.request("/api/companion/profile", { preset_key: "preset_02" })).json();
  const result = await f.chat({ profile_id: pending.profile_id }); assert.equal(result.cost, 5); assert.deepEqual(result.reply.media.audios, []); assert.equal(result.reply.media.audio_status.status, "pending_upload"); assert.equal(f.state.ttsCalls, 0);
  let profiles = await (await f.request("/api/companion/profiles")).json(); assert.equal(profiles.items.find(x => x.id === pending.profile_id).voice_available, false); assert.equal(profiles.items.find(x => x.id === f.profile.profile_id).voice_available, true);
  f.voiceCatalog.voices.preset_03.status = "missing_reference"; await writeFile(resolve(f.root, "companion_voice_catalog.json"), JSON.stringify(f.voiceCatalog));
  const missing = await f.chat(); assert.equal(missing.cost, 5); assert.equal(missing.reply.media.audio_status.status, "missing_reference"); assert.equal(f.state.ttsCalls, 0);
});

for (const mode of ["http-error", "corrupt", "unsafe-url"]) test(`CosyVoice ${mode} preserves text and never charges the audio fee`, async t => {
  const f = await fixture(t, { mode }), result = await f.chat(); assert.equal(result.success, true); assert.equal(result.cost, 5); assert.equal(result.balance, 95); assert.equal(result.reply.media.audio_status.status, "failed"); assert.deepEqual(result.reply.media.audios, []); assert.doesNotMatch(JSON.stringify(result), /fixture-key|private upstream|169\.254/);
  assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM wallet_logs WHERE log_type='AI_COMPANION_AUDIO'").get().n, 0); assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM companion_credit_holds").get().n, 0);
  assert.equal(f.app.db.prepare("SELECT charged_points FROM companion_audio_generations").get().charged_points, 0);
  assert.deepEqual(await readdir(resolve(f.root, "assets/generated_audio")).catch(() => []), []);
});

test("insufficient balance avoids synthesis entirely; concurrent holds prevent paid requests from overdrawing", async t => {
  const f = await fixture(t, { balance: 7 }), result = await f.chat(); assert.equal(result.success, true); assert.equal(result.cost, 5); assert.equal(result.balance, 2); assert.equal(result.reply.media.audio_status.status, "insufficient_balance"); assert.equal(f.state.ttsCalls, 0);
  f.app.db.prepare("UPDATE users SET balance=15 WHERE id=1").run(); f.state.ttsDelay = 100; f.state.textDelay = 30;
  const results = await Promise.all([f.chat(), f.chat()]); assert.ok(results.every(x => x.success)); assert.equal(results.reduce((n, x) => n + x.cost, 0), 15); assert.equal(f.state.ttsCalls, 1); assert.equal(f.app.db.prepare("SELECT balance FROM users WHERE id=1").get().balance, 0); assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM companion_credit_holds").get().n, 0);
});

for (const imageFirst of [true, false]) test(`SSE speech and image completion preserve both media when ${imageFirst ? "images" : "audio"} finishes first`, async t => {
  const f = await fixture(t, { ttsDelay: imageFirst ? 150 : 0, imageDelay: imageFirst ? 0 : 150 }), response = await f.request("/api/companion/chat/stream", { profile_id: f.profile.profile_id, message: "挥手问候", reply_types: ["text", "image", "audio"] });
  const stream = await response.text(), parsed = stream.match(/event: done\ndata: ([^\n]+)/); assert.ok(parsed); const done = JSON.parse(parsed[1]);
  assert.ok(stream.indexOf("event: delta") < stream.indexOf('"media_type":"audio"')); assert.equal(done.cost, 10); assert.equal(done.reply.media.audios.length, 1);
  const taskId = done.reply.media.images[0].task_id || JSON.parse(stream.match(/event: media_status\ndata: ([^\n]+)/)[1]).task_id;
  let task; for (let i = 0; i < 100; i++) { task = await (await f.request(`/api/companion/image-task/${taskId}`)).json(); if (["done", "error"].includes(task.status)) break; await sleep(20); }
  assert.equal(task.status, "done");
  const history = await (await f.request(`/api/companion/history?profile_id=${f.profile.profile_id}`)).json(), media = history.items.at(-1).media;
  assert.equal(media.images[0].status, "done"); assert.ok(media.images[0].url); assert.equal(media.audios.length, 1); assert.equal(media.audio_status.status, "done"); assert.equal((await fetch(f.base + media.audios[0].url)).status, 200);
});

test("client cancellation during audio releases the hold and preserves the successful charged text", async t => {
  const state = { ttsDelay: 300 }, started = new Promise(done => { state.ttsStarted = done; }), f = await fixture(t, state), controller = new AbortController();
  const pending = f.request("/api/companion/chat/stream", { profile_id: f.profile.profile_id, message: "问候", reply_types: ["text", "audio"] }, { signal: controller.signal }).then(response => response.text()).catch(() => "");
  await started; controller.abort(); await pending;
  for (let i = 0; i < 50 && f.app.db.prepare("SELECT count(*) AS n FROM companion_credit_holds").get().n; i++) await sleep(10);
  assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM companion_credit_holds").get().n, 0); assert.equal(f.app.db.prepare("SELECT balance FROM users WHERE id=1").get().balance, 95); assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM companion_messages WHERE role='assistant'").get().n, 1); assert.equal(f.app.db.prepare("SELECT charged_points FROM companion_audio_generations").get().charged_points, 0);
});

test("CosyVoice timeout preserves the charged text, releases the audio hold and reports no private details", async t => {
  const f = await fixture(t, { ttsDelay: 1200 }), result = await f.chat(); assert.equal(result.success, true); assert.equal(result.cost, 5); assert.equal(result.balance, 95); assert.match(result.reply.media.audio_status.message, /超时.*未扣点/); assert.deepEqual(result.reply.media.audios, []);
  assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM companion_credit_holds").get().n, 0); assert.equal(f.app.db.prepare("SELECT charged_points FROM companion_audio_generations").get().charged_points, 0);
});

test("saved audio survives process restart without synthesis or any additional debit", async t => {
  const f = await fixture(t), result = await f.chat(); await f.app.close();
  const restored = await createApplication({ root: f.root, ttsEnvFile: resolve(f.root, "missing.env"), env: f.app.env });
  try {
    const address = await restored.listen(0), base = `http://127.0.0.1:${address.port}`;
    const history = await (await fetch(`${base}/api/companion/history?profile_id=${f.profile.profile_id}`, { headers: { Authorization: `Bearer ${f.token}` } })).json();
    const audio = history.items.at(-1).media.audios[0]; assert.ok(audio.url); assert.deepEqual(Buffer.from(await (await fetch(base + audio.url)).arrayBuffer()), f.bytes);
    assert.equal(f.state.ttsCalls, 1); assert.equal(restored.db.prepare("SELECT balance FROM users WHERE id=1").get().balance, 90); assert.equal(restored.db.prepare("SELECT count(*) AS n FROM wallet_logs WHERE log_type='AI_COMPANION_AUDIO'").get().n, 1); assert.equal(result.cost, 10);
  } finally { await restored.close(); }
});
