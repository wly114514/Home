import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile, rename, unlink, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const TTS_ENV_KEYS = ["MEDIA_TTS_PROVIDER", "DASHSCOPE_API_KEY", "DASHSCOPE_BASE_HTTP_API_URL", "DASHSCOPE_BASE_WEBSOCKET_API_URL", "BASE_HTTP_API_URL", "BASE_WEBSOCKET_API_URL", "COSYVOICE_MODEL", "COSYVOICE_VOICE_ID"];
export const DEFAULT_TTS_ENV_FILE = "";
const enabled = value => ["1", "true"].includes(String(value || "").toLowerCase());

export function synthesisEndpoint(env) {
  let base = env.DASHSCOPE_BASE_HTTP_API_URL || env.BASE_HTTP_API_URL;
  if (!base) {
    const ws = env.DASHSCOPE_BASE_WEBSOCKET_API_URL || env.BASE_WEBSOCKET_API_URL;
    base = ws ? `${new URL(ws).protocol === "wss:" ? "https:" : "http:"}//${new URL(ws).host}/api/v1` : "https://dashscope.aliyuncs.com/api/v1";
  }
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("语音服务地址配置无效");
  if (url.protocol !== "https:" && !(enabled(env.LOCAL_DEV) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("语音服务必须使用 HTTPS");
  let path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") path = "/api/v1";
  if (!path.endsWith("/services/audio/tts/SpeechSynthesizer")) path += "/services/audio/tts/SpeechSynthesizer";
  url.pathname = path;
  return url.toString();
}

// Verify the complete downloaded WAV, not just a successful HTTP response or RIFF magic.
export function inspectWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error("语音文件不完整或不是 WAV 格式");
  let format, dataBytes = 0, offset = 12;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), begin = offset + 8;
    if (begin + size > bytes.length) throw new Error("语音文件不完整");
    if (name === "fmt ") {
      if (size < 16) throw new Error("语音格式无效");
      format = { code: bytes.readUInt16LE(begin), channels: bytes.readUInt16LE(begin + 2), sample_rate: bytes.readUInt32LE(begin + 4), rate: bytes.readUInt32LE(begin + 8), block: bytes.readUInt16LE(begin + 12), bits: bytes.readUInt16LE(begin + 14) };
      if (format.code === 65534 && size >= 40 && bytes.readUInt16LE(begin + 24) === 1) format.code = 1;
    }
    if (name === "data") dataBytes += size;
    offset = begin + size + (size % 2);
  }
  if (offset !== bytes.length || !format || format.code !== 1 || format.channels !== 1 || format.bits !== 16 || format.block !== 2 || format.rate !== format.sample_rate * 2 || ![8000, 12000, 16000, 22050, 24000, 44100, 48000].includes(format.sample_rate) || !dataBytes || dataBytes % format.block) throw new Error("语音文件编码不符合要求");
  const duration_seconds = dataBytes / format.rate;
  if (duration_seconds < 0.1 || duration_seconds > 600) throw new Error("语音文件时长无效");
  return { duration_seconds, sample_rate: format.sample_rate, format: "wav", sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function normalizeCompletedWav(bytes) {
  // CosyVoice/lib­sndfile uses this exact paired placeholder in completed HTTP WAV results.
  // Only the known standard PCM header is accepted. Ordinary mismatched lengths remain errors.
  if (Buffer.isBuffer(bytes) && bytes.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 16) === "WAVEfmt " && bytes.readUInt32LE(16) === 16 && bytes.toString("ascii", 36, 40) === "data" && bytes.readUInt32LE(4) === 0x7fffffbf && bytes.readUInt32LE(40) === 0x7fffff9b) {
    const normalized = Buffer.from(bytes);
    normalized.writeUInt32LE(normalized.length - 8, 4); normalized.writeUInt32LE(normalized.length - 44, 40);
    inspectWav(normalized); return normalized;
  }
  inspectWav(bytes); return bytes;
}

async function limitedBody(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) throw new Error("语音服务返回文件过大");
  const chunks = []; let length = 0;
  for await (const chunk of response.body || []) { length += chunk.length; if (length > limit) throw new Error("语音服务返回文件过大"); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}

export function createVoiceService({ env, root }) {
  const file = resolve(root, env.COMPANION_VOICE_CATALOG_FILE || "companion_voice_catalog.json"), directory = resolve(root, env.GENERATED_AUDIO_DIR || "assets/generated_audio");
  const provider = String(env.MEDIA_TTS_PROVIDER || "").toLowerCase(), model = String(env.COSYVOICE_MODEL || "cosyvoice-v3.5-flash"), key = String(env.DASHSCOPE_API_KEY || "");
  let fingerprint = "", voices = {}, catalogModel = "";
  function refresh() {
    try {
      const stat = statSync(file), next = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (next === fingerprint) return;
      const value = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      voices = value.voices && typeof value.voices === "object" && !Array.isArray(value.voices) ? value.voices : {}; catalogModel = String(value.model || ""); fingerprint = next;
    } catch { fingerprint = ""; voices = {}; catalogModel = ""; }
  }
  function voice(presetKey) {
    refresh(); const row = voices[String(presetKey || "")];
    if (!row) return { voice_available: false, voice_status: "unavailable", voice_reason: "该角色尚未配置专属音色" };
    if (row.status !== "ready") return { voice_available: false, voice_status: row.status === "missing_reference" ? "missing_reference" : "pending_upload", voice_reason: row.status === "missing_reference" ? "该角色缺少可用语音参考" : "该角色专属音色正在准备，文字和图片仍可使用" };
    if (provider !== "cosyvoice" || !key) return { voice_available: false, voice_status: "unavailable", voice_reason: "语音服务尚未配置" };
    const target = String(row.model || catalogModel || model), id = String(row.voice_id || "").trim();
    if (!id || target !== model) return { voice_available: false, voice_status: "unavailable", voice_reason: "该角色音色配置尚未完成" };
    return { voice_available: true, voice_status: "ready", voice_reason: "专属音色可用，每次成功音频回复额外 5 点", id, model: target };
  }
  const publicVoice = presetKey => { const { id, model: _model, ...metadata } = voice(presetKey); return metadata; };
  const timeoutMs = Math.max(1000, Math.min(180000, Number(env.COSYVOICE_TIMEOUT_MS) || 90000));
  async function synthesize(text, presetKey, callerSignal) {
    const selected = voice(presetKey);
    if (!selected.voice_available) throw new Error(selected.voice_reason);
    if (!String(text || "").trim() || String(text).length > 20000) throw new Error("语音文本为空或超过 20000 字，语音未扣点");
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let savedFile = "", partial = "";
    try {
      const response = await fetch(synthesisEndpoint(env), { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: selected.model, input: { text: String(text), voice: selected.id, format: "wav", sample_rate: 24000 } }), signal, redirect: "error" });
      if (!response.ok) throw new Error(`语音服务暂时无法合成（HTTP ${response.status}），语音未扣点`);
      let result; try { result = JSON.parse((await limitedBody(response, 1024 * 1024)).toString("utf8")); } catch { throw new Error("语音服务没有返回有效结果，语音未扣点"); }
      if (result.code || result.output?.finish_reason !== "stop" || !result.output?.audio?.url) throw new Error("语音服务未完成合成，语音未扣点");
      let url = new URL(result.output.audio.url);
      const allowedUrl = value => {
        if (value.username || value.password || !["http:", "https:"].includes(value.protocol)) return false;
        if (enabled(env.LOCAL_DEV) && ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname)) return true;
        // Provider results use an expiring OSS URL. Never fetch arbitrary/private hosts supplied by upstream.
        return value.hostname.endsWith(".aliyuncs.com") && /(?:^|\.)oss-[a-z0-9-]+\.aliyuncs\.com$/.test(value.hostname) && (!value.port || value.port === "443");
      };
      let audioResponse;
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (!allowedUrl(url)) throw new Error("语音服务返回了不支持的音频地址，语音未扣点");
        if (url.protocol === "http:" && url.hostname.endsWith(".aliyuncs.com")) url.protocol = "https:";
        audioResponse = await fetch(url, { signal, redirect: "manual" });
        if (![301, 302, 303, 307, 308].includes(audioResponse.status)) break;
        const location = audioResponse.headers.get("location"); await audioResponse.body?.cancel();
        if (!location || redirects === 3) throw new Error("语音音频下载重定向失败，语音未扣点");
        url = new URL(location, url);
      }
      if (!audioResponse.ok) throw new Error("语音音频下载失败，语音未扣点");
      // The API must report finish_reason=stop and fetch must finish the entire response before
      // repairing its documented streaming container placeholder; partial/non-frame PCM is rejected.
      const bytes = normalizeCompletedWav(await limitedBody(audioResponse, 32 * 1024 * 1024)), metadata = inspectWav(bytes);
      signal.throwIfAborted(); await mkdir(directory, { recursive: true });
      savedFile = `${randomUUID()}.wav`; partial = resolve(directory, `${savedFile}.partial`);
      await writeFile(partial, bytes, { flag: "wx", mode: 0o600 }); signal.throwIfAborted(); await rename(partial, resolve(directory, savedFile)); partial = "";
      return { file: savedFile, text: String(text), provider: "cosyvoice", model: selected.model, status: "done", billed_points: 5, ...metadata };
    } catch (error) {
      if (partial) await unlink(partial).catch(() => {});
      if (savedFile) await unlink(resolve(directory, savedFile)).catch(() => {});
      if (signal.aborted) throw new Error(callerSignal?.aborted ? "语音合成已取消，语音未扣点" : "语音服务连接超时，语音未扣点");
      // Never return provider error bodies, keys, voice identifiers or signed upstream URLs.
      if (/^语音/.test(error.message) && !error.message.includes(key)) throw error;
      throw new Error("语音服务连接失败，请稍后再试，语音未扣点");
    }
  }
  return { voice: publicVoice, synthesize, timeoutMs, directory,
    health: () => { refresh(); return { provider, model, configured: provider === "cosyvoice" && Boolean(key), ready_voice_count: Object.keys(voices).filter(keyName => voice(keyName).voice_available).length }; },
    read: filename => /^[a-f0-9-]{36}\.wav$/i.test(filename) ? readFile(resolve(directory, filename)) : Promise.reject(new Error("语音文件不存在")),
    discard: filename => /^[a-f0-9-]{36}\.wav$/i.test(filename) ? unlink(resolve(directory, filename)).catch(() => {}) : Promise.resolve()
  };
}
