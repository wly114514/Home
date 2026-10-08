import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { consumeAIResponse } from "./ai-client.mjs";

const SIZES = {
  "16:9": ["1920x1080", "2048x1152", "3840x2160"],
  "9:16": ["1080x1920", "1152x2048", "2160x3840"],
  "1:1": ["1080x1080", "2048x2048", "3072x3072"],
  "4:3": ["1440x1080", "2048x1536", "3840x2880"],
  "3:4": ["1080x1440", "1536x2048", "2880x3840"]
};
const TONES = {
  natural: ["自然", "自然清透的色调，肤色和环境光协调"],
  warm: ["暖色", "温暖金色调，柔和暖光，舒适亲密的氛围"],
  cool: ["冷色", "冷色蓝调，清澈安静"],
  pastel: ["粉彩", "低饱和粉彩色调，柔软、轻盈、干净"],
  cinematic: ["电影感", "动漫电影定格镜头质感、浅景深、体积光、镜头光晕、冷暖对比、柔和高光、胶片色彩分层"],
  dreamy: ["梦幻", "梦幻柔焦色调，微光、朦胧、浪漫"]
};
const CHARACTERS = {
  "流萤": "gentle silver-haired anime girl with teal-green eyes, sincere slightly shy expression, futuristic light outfit with mint and black accents, subtle firefly glow and mechanical armor energy motifs.",
  "遐蝶": "Castorice-inspired Honkai Star Rail heroine, very long silver-white hair with lavender shadows, purple-violet eyes, calm gentle expression, translucent purple-black butterfly ornaments, small black headpiece, asymmetrical black-purple-white layered battle dress, light featherlike sleeves, sci-fi fantasy details, dark violet crystal accents. Avoid wedding dress, large crown, horns, generic gothic princess or seductive outfit.",
  "芙宁娜": "elegant white-and-pale-blue-haired anime girl with blue eyes, refined opera-stage fantasy costume, water and spotlight motifs, dramatic yet tender expression."
};

export function imageOptions(data = {}) {
  const quality = ["1080p", "2k", "4k"].includes(String(data.image_quality).toLowerCase()) ? String(data.image_quality).toLowerCase() : "1080p";
  const ratio = String(data.image_aspect_ratio || "16:9").toLowerCase().replaceAll("x", ":");
  const aspect = SIZES[ratio] ? ratio : "16:9";
  const tone = TONES[data.image_tone] ? data.image_tone : "natural";
  return { quality, aspect, tone, size: SIZES[aspect][["1080p", "2k", "4k"].indexOf(quality)], timeoutMs: ({ "1080p": 120000, "2k": 210000, "4k": 360000 })[quality] };
}

export function imagePrompt(profile, item, text, options) {
  const identity = String(profile.image_prompt || "").trim() || CHARACTERS[profile.character_name] || `Anime companion character ${profile.character_name}, ${profile.search_summary || ""}`;
  return `请画角色本人：${profile.character_name}。角色独立外观设定：${identity}
场景（必须遵守上面的角色外观设定）：${String(item.scene_prompt || item.prompt || text || "自然的聊天场景").slice(0, 500)}。
${options.aspect} 构图，${TONES[options.tone][1]}。角色头部、头发、下巴和主体关键部位完整入镜，头顶留出安全空间；使用中景、半身像、膝上像或全身像，背景作为氛围。
Safety requirement: all-ages safe, non-sexual, fully clothed, no nudity, no seductive poses or body-part closeups.`;
}

function imageValue(value, allowBase64 = false) {
  if (!value) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (/^(data:image\/|https?:\/\/)/i.test(text)) return text;
    if (allowBase64 && /^[A-Za-z0-9+/=\s]+$/.test(text)) return `data:image/png;base64,${text.replace(/\s/g, "")}`;
    const match = text.match(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s"'<>)]+/i);
    if (match) return match[0];
    try { return imageValue(JSON.parse(text)); } catch { return ""; }
  }
  if (Array.isArray(value)) { for (const item of value) { const found = imageValue(item); if (found) return found; } return ""; }
  if (typeof value === "object") {
    for (const key of ["url", "image_url", "b64_json", "image_base64", "image", "images", "data", "content", "message", "choices", "output", "image_urls"]) {
      const found = imageValue(value[key], /base64|b64_json/.test(key)); if (found) return found;
    }
  }
  return "";
}

async function imageBytes(url, signal) {
  if (url.startsWith("data:image/")) {
    const match = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
    if (!match) throw new Error("图片 base64 格式无效");
    const value = Buffer.from(match[1], "base64");
    if (value.length > 32 * 1024 * 1024) throw new Error("图片文件过大");
    return value;
  }
  if (!/^https?:\/\//.test(url)) throw new Error("图片地址协议无效");
  const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]), headers: { "User-Agent": "MihoyoCompanion/2" } });
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
  const chunks = []; let count = 0;
  for await (const chunk of response.body) { count += chunk.length; if (count > 32 * 1024 * 1024) throw new Error("图片文件过大"); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function createImageService({ env, root }) {
  const assetRoot = resolve(root, env.GENERATED_IMAGES_DIR || "assets/generated_images");
  const route = prefix => {
    const key = env[`${prefix}KEY`] || (prefix === "AI_IMAGE_" ? env.AI_API_KEY : "");
    const base = env[`${prefix}ENDPOINT`] || (prefix === "AI_IMAGE_" ? env.AI_BASE_URL : "");
    const mode = env[`${prefix}API_MODE`] || env.AI_IMAGE_API_MODE || "chat";
    let endpoint = String(base || "").replace(/\/+$/, "");
    endpoint = endpoint.replace(/\/(?:chat\/completions|images\/generations)$/, "");
    try { if (new URL(endpoint).pathname === "/") endpoint += "/v1"; } catch { /* validated by fetch */ }
    endpoint += mode === "chat" ? "/chat/completions" : "/images/generations";
    return { key, endpoint, mode, model: env[`${prefix}MODEL`] || env.AI_IMAGE_MODEL || "", fallback: env[`${prefix}FALLBACK_MODELS`] || "", format: env[`${prefix}RESPONSE_FORMAT`] || "url" };
  };
  const routes = [route("AI_IMAGE_"), route("AI_IMAGE_STANDARD_")].filter(x => x.key && x.endpoint && x.model);

  async function saveImage(url, size, signal, progress = () => {}) {
    const bytes = await imageBytes(url, signal);
    const [width, height] = size.split("x").map(Number);
    const average = await sharp(bytes, { limitInputPixels: 40_000_000 }).resize(1, 1, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const output = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize(width, height, { fit: "contain", background: { r: average[0], g: average[1], b: average[2], alpha: 1 }, kernel: "lanczos3" }).png().toBuffer();
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    await mkdir(resolve(assetRoot, day), { recursive: true });
    const filename = `${randomUUID().replaceAll("-", "")}.png`;
    await writeFile(resolve(assetRoot, day, filename), output);
    progress({ stage: "saving", message: `图片已标准化为 ${width} × ${height}`, progress: 95 });
    return `/web/assets/generated_images/${day}/${filename}`;
  }

  async function generate(prompt, options, progress = () => {}, signal) {
    if (!routes.length) throw new Error("未配置可用的图片接口 / 模型");
    const errors = []; let attempt = 0;
    for (const route of routes) {
      for (const model of [...new Set([route.model, ...route.fallback.split(",")].map(x => x.trim()).filter(Boolean))]) {
        const base = { model, prompt: prompt.slice(0, 1500), n: 1 };
        const candidates = route.mode === "chat"
          ? [{ model, messages: [{ role: "user", content: `${prompt.slice(0, 1500)}\nImage size: ${options.size}. Aspect ratio: ${options.aspect}.` }], stream: false }]
          : [
            ...[...new Set([route.format, "url", "b64_json"].filter(Boolean))].map(format => ({ ...base, response_format: format, size: options.size, aspect_ratio: options.aspect })),
            ...[...new Set([route.format, "url", "b64_json"].filter(Boolean))].map(format => ({ ...base, response_format: format, size: options.size })),
            { ...base, response_format: route.format },
            base
          ];
        for (const body of candidates) {
          progress({ stage: "api", message: attempt++ ? "正在尝试备用图片配置" : "正在生成图片", api_started: true, requested_size: options.size, timeout_seconds: options.timeoutMs / 1000, progress: 8 });
          const timeout = AbortSignal.timeout(options.timeoutMs);
          const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
          try {
            const response = await fetch(route.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${route.key}` }, body: JSON.stringify(body), signal: combined });
            let url;
            if (/text\/event-stream/.test(response.headers.get("content-type") || "")) url = imageValue(await consumeAIResponse(response));
            else {
              const raw = await response.text(); let result; try { result = JSON.parse(raw); } catch { throw new Error(`图片接口返回格式错误：HTTP ${response.status}`); }
              if (!response.ok || result.error) throw new Error(String(result.error?.message || result.message || `图片接口失败：HTTP ${response.status}`));
              url = imageValue(result);
            }
            if (!url) throw new Error("图片接口没有返回图片地址或 base64");
            progress({ stage: "saving", message: "图片已返回，正在保存", progress: 90 });
            return { url: await saveImage(url, options.size, signal, progress), used_model: model };
          } catch (error) {
            if (signal?.aborted) throw new Error("图片任务已取消");
            const message = timeout.aborted ? "图片接口响应超时" : String(error.message).replaceAll(route.key, "[hidden]");
            if (/余额|欠费|insufficient|quota|billing|credit/i.test(message)) throw new Error("图片 API 额度不足，请联系管理员");
            errors.push(message.slice(0, 160));
          }
        }
      }
    }
    throw new Error([...new Set(errors)].join("；").slice(0, 500) || "图片接口没有返回图片");
  }

  function prepare(reply, types, profile, data, taskId = "") {
    const options = imageOptions(data);
    const images = types.includes("image") ? (Array.isArray(reply.media?.images) && reply.media.images.length ? reply.media.images.slice(0, 2) : [{ title: `${profile.character_name}画面`, prompt: reply.text.slice(0, 150) }]) : [];
    const normalized = images.map(source => {
      const item = { title: String(source?.title || `${profile.character_name}画面`), url: "", scene_prompt: String(source?.scene_prompt || source?.prompt || reply.text.slice(0, 150)).slice(0, 500) };
      item.prompt = imagePrompt(profile, item, reply.text, options);
      Object.assign(item, { requested_quality: options.quality === "1080p" ? "1080p" : options.quality.toUpperCase(), requested_aspect_ratio: `${options.aspect} ${["9:16", "3:4"].includes(options.aspect) ? "竖图" : options.aspect === "1:1" ? "方图" : "横图"}`, requested_tone: TONES[options.tone][0], requested_size: options.size, requested_model: routes[0]?.model || "", status: "pending", task_id: taskId, stage: "prepare", message: "准备图片任务", api_started: false, progress: 0 });
      return item;
    });
    const videos = types.includes("video") ? (Array.isArray(reply.media?.videos) && reply.media.videos.length ? reply.media.videos : [{ title: `${profile.character_name}短片`, script: reply.text }]).slice(0, 2).map(x => ({ title: String(x.title || "短片分镜"), script: String(x.script || reply.text), url: "", status: "script", message: "短片分镜" })) : [];
    const audios = types.includes("audio") ? (Array.isArray(reply.media?.audios) && reply.media.audios.length ? reply.media.audios : [{ title: `${profile.character_name}语音`, text: reply.text }]).slice(0, 2).map(x => ({ title: String(x.title || "语音台词"), text: String(x.text || reply.text), url: "" })) : [];
    return { text: reply.text, media: { images: normalized, videos, audios } };
  }

  async function enrich(media, data, progress, signal) {
    const value = structuredClone(media);
    for (const item of value.images || []) {
      try { Object.assign(item, await generate(item.prompt, imageOptions(data), progress, signal), { status: "done", progress: 100 }); }
      catch (error) { Object.assign(item, { status: "error", url: "", error: "图片暂未返回，请稍后重试。", error_detail: error.message }); }
      delete item.task_id;
    }
    return value;
  }
  return { assetRoot, generate, saveImage, prepare, enrich };
}
