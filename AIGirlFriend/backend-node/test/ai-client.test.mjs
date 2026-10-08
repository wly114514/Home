import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { consumeAIResponse, parseReply, partialReplyText } from "../ai-client.mjs";
import { createApplication } from "../app.mjs";

const replyText = "我会认真听你说完，再陪你看看窗外的花园。";
const reply = { text: replyText, media: { images: [{ title: "窗边", prompt: "成年旅人在窗边看花园" }] } };
const encodedReply = JSON.stringify(reply);
const delta = content => ({ choices: [{ delta: { content }, finish_reason: null }] });
const final = content => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
const encodeEvents = events => events.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";

function response(events) {
  const bytes = new TextEncoder().encode(encodeEvents(events));
  // Network chunks need not align with SSE frames or Chinese UTF-8 characters.
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}

async function collect(events) {
  let displayed = "";
  const callbacks = [];
  const raw = await consumeAIResponse(response(events), (chunk, full) => {
    callbacks.push(chunk);
    const visible = partialReplyText(full);
    if (visible.startsWith(displayed) && visible.length > displayed.length) displayed += visible.slice(displayed.length);
  });
  return { raw, parsed: parseReply(raw), displayed, callbacks };
}

test("Chat SSE plain deltas followed by a structured final message preserve one reply and its media", async () => {
  const result = await collect([delta(replyText), final(encodedReply)]);
  assert.equal(result.raw, encodedReply);
  assert.deepEqual(result.parsed, reply);
  assert.equal(result.displayed, replyText);
  assert.deepEqual(result.callbacks, [replyText, ""]);
});

test("Chat SSE JSON deltas followed by the same full message do not append a second JSON object", async () => {
  const result = await collect([delta(encodedReply.slice(0, 13)), delta(encodedReply.slice(13)), final(encodedReply)]);
  assert.equal(result.raw, encodedReply);
  assert.deepEqual(result.parsed, reply);
  assert.equal(result.displayed, replyText);
  assert.equal(result.callbacks.length, 2);
});

test("novel-style plain deltas followed by a full final message return the text once", async () => {
  const result = await collect([delta(replyText.slice(0, 6)), delta(replyText.slice(6)), final(replyText)]);
  assert.equal(result.raw, replyText);
  assert.equal(result.parsed.text, replyText);
  assert.equal(result.displayed, replyText);
  assert.deepEqual(result.parsed.media, {});
  assert.equal(result.callbacks.length, 2);
});

test("authoritative Chat final messages can complete or revise partial text without emitting a JSON shell", async () => {
  const prefix = replyText.slice(0, 6);
  const extended = await collect([delta(prefix), final(encodedReply)]);
  assert.deepEqual(extended.parsed, reply);
  assert.equal(extended.displayed, replyText);
  assert.deepEqual(extended.callbacks, [prefix, replyText.slice(prefix.length)]);
  const changed = await collect([delta("旧增量内容。"), final(encodedReply)]);
  assert.deepEqual(changed.parsed, reply);
  assert.equal(changed.callbacks.at(-1), "");
  assert.ok(changed.callbacks.every(chunk => !chunk.includes('{"text"')));
});

test("message-only SSE, standard deltas, Responses and trailing upstream errors retain their behavior", async () => {
  const cases = [
    [final([{ type: "text", text: encodedReply }])],
    [delta(encodedReply), { choices: [{ delta: {}, finish_reason: "stop" }] }],
    [{ type: "response.output_text.delta", delta: encodedReply }, { type: "response.output_text.done", text: encodedReply }, { type: "response.completed", response: { output_text: encodedReply } }],
    [{ type: "response.output_text.done", text: encodedReply }, { type: "response.completed", response: { output_text: encodedReply } }],
  ];
  for (const events of cases) {
    const result = await collect(events);
    assert.deepEqual(result.parsed, reply);
    assert.equal(result.displayed, replyText);
  }
  await assert.rejects(collect([delta(replyText), { error: { message: "fixture upstream failure" } }]), /fixture upstream failure/);
});

test("actual stream chat routes emit one final reply, persist it once and charge once for all three terminal shapes", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "mihoyo-chat-terminal-test-"));
  const captured = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()), scenario = body.messages.at(-1).content;
    captured.push({ scenario, stream: body.stream });
    const events = scenario === "json-terminal" ? [delta(encodedReply.slice(0, 13)), delta(encodedReply.slice(13)), final(encodedReply)]
      : scenario === "novel-terminal" ? [delta(replyText.slice(0, 6)), delta(replyText.slice(6)), final(replyText)]
        : [delta(replyText), final(encodedReply)];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(encodeEvents(events));
  });
  await new Promise(done => upstream.listen(0, "127.0.0.1", done));
  await mkdir(resolve(root, "assets"));
  await writeFile(resolve(root, "companion_presets.json"), JSON.stringify({ presets: [{ key: "preset_02", character_name: "测试成年旅人", relationship: "朋友", role_prompt: "平静认真，用自然短句交流。", allowed_types: ["text", "image"], media_enabled: true }] }));
  const app = await createApplication({ root, ttsEnvFile: resolve(root, "no-tts.env"), env: { LOCAL_DEV: "1", AI_PROFILE_GENERATION: "off", AI_API_KEY: "fixture-secret", AI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`, AI_COMPANION_MODEL: "fixture-model", MEDIA_TTS_PROVIDER: "", DASHSCOPE_API_KEY: "" } });
  t.after(async () => {
    await app.close(); upstream.closeAllConnections(); await new Promise(done => upstream.close(done));
    assert.ok(root.startsWith(resolve(tmpdir(), "mihoyo-chat-terminal-test-"))); await rm(root, { recursive: true, force: true });
  });
  app.db.prepare("INSERT INTO users(id,account,password_hash,balance,created_at) VALUES(?,?,?,?,?)").run(1, "terminal-fixture", "unused", 100, "2026-10-07 00:00:00");
  const token = app.signToken({ user_id: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const profile = await (await fetch(base + "/api/companion/profile", { method: "POST", headers, body: JSON.stringify({ preset_key: "preset_02" }) })).json();
  assert.equal(profile.success, true);
  let balance = 100;
  for (const scenario of ["plain-terminal", "json-terminal", "novel-terminal"]) {
    const res = await fetch(base + "/api/companion/chat/stream", { method: "POST", headers, body: JSON.stringify({ profile_id: profile.profile_id, message: scenario, reply_types: ["text"] }) });
    assert.equal(res.status, 200);
    const events = (await res.text()).split(/\r?\n\r?\n/).map(block => {
      const name = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
      return name && data ? { name, value: JSON.parse(data) } : null;
    }).filter(Boolean);
    assert.ok(!events.some(event => event.name === "error"));
    assert.equal(events.filter(event => event.name === "done").length, 1);
    const done = events.find(event => event.name === "done").value;
    assert.equal(events.filter(event => event.name === "delta").map(event => event.value.text).join(""), replyText);
    assert.equal(done.reply.text, replyText);
    assert.equal(done.cost, 5); assert.equal(done.cost_breakdown.audio, 0);
    assert.equal(done.balance, balance -= 5);
    assert.equal(app.db.prepare("SELECT content FROM companion_messages WHERE id=? AND user_id=1").get(done.assistant_message_id).content, replyText);
  }
  assert.equal(captured.length, 3); assert.ok(captured.every(item => item.stream === true));
  assert.equal(app.db.prepare("SELECT count(*) AS n FROM companion_messages WHERE user_id=1 AND role='assistant' AND content=?").get(replyText).n, 3);
  assert.equal(app.db.prepare("SELECT count(*) AS n FROM companion_credit_holds").get().n, 0);
});
