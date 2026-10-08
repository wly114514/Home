import sharp from "sharp";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, open, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 24_000_000;
export const MAX_IMAGES_PER_MESSAGE = 3;
const MAX_DIMENSION = 2048, THUMBNAIL_DIMENSION = 320, DECODE_TIMEOUT_SECONDS = 5;
const MIME_FORMATS = new Map([["image/jpeg", "jpeg"], ["image/png", "png"], ["image/webp", "webp"]]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const error = (code, status, message) => Object.assign(new Error(message), { code, status });
const cancelled = () => error("ATTACHMENT_CANCELLED", 499, "图片操作已取消");
function checkSignal(signal) { if (signal?.aborted) throw cancelled(); }

function sniff(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "";
}

async function inputBytes(input, signal) {
  checkSignal(signal);
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (input.byteLength > MAX_UPLOAD_BYTES) throw error("ATTACHMENT_TOO_LARGE", 413, "每张图片不得超过 8 MiB");
    return Buffer.from(input);
  }
  if (!input || typeof input[Symbol.asyncIterator] !== "function") throw error("ATTACHMENT_INVALID_INPUT", 400, "没有收到图片文件");
  const length = Number(input.headers?.["content-length"]);
  if (Number.isFinite(length) && length > MAX_UPLOAD_BYTES) throw error("ATTACHMENT_TOO_LARGE", 413, "每张图片不得超过 8 MiB");
  const chunks = []; let size = 0;
  const abort = () => input.destroy?.();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of input) {
      checkSignal(signal);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_UPLOAD_BYTES) throw error("ATTACHMENT_TOO_LARGE", 413, "每张图片不得超过 8 MiB");
      chunks.push(bytes);
    }
    checkSignal(signal);
    return Buffer.concat(chunks, size);
  } catch (cause) {
    if (signal?.aborted) throw cancelled();
    if (cause.code?.startsWith("ATTACHMENT_")) throw cause;
    throw error("ATTACHMENT_UPLOAD_INTERRUPTED", 400, "图片上传未完成，请重新选择图片");
  } finally { signal?.removeEventListener("abort", abort); }
}

async function processImage(pipeline, signal, metadata = false) {
  checkSignal(signal);
  const operation = metadata ? pipeline.metadata() : pipeline.toBuffer({ resolveWithObject: true });
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => { pipeline.destroy(); reject(cancelled()); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  try { return await (signal ? Promise.race([operation, interrupted]) : operation); }
  catch (cause) {
    if (signal?.aborted) throw cancelled();
    if (/timeout/i.test(cause.message || "")) throw error("ATTACHMENT_DECODE_TIMEOUT", 408, "图片处理超时，请换一张较小的图片");
    if (/pixel limit/i.test(cause.message || "")) throw error("ATTACHMENT_TOO_MANY_PIXELS", 413, "图片像素过大，请缩小后上传");
    throw error("ATTACHMENT_INVALID_IMAGE", 422, "图片无法完整解码，请上传有效的 JPEG、PNG 或 WebP 图片");
  } finally { signal?.removeEventListener("abort", abort); }
}

export async function normalizeImage(input, { contentType, signal } = {}) {
  const mime = String(contentType || input?.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!MIME_FORMATS.has(mime)) throw error("ATTACHMENT_UNSUPPORTED_TYPE", 415, "只支持 JPEG、PNG 和 WebP 图片");
  const bytes = await inputBytes(input, signal), actual = sniff(bytes);
  if (!actual || actual !== MIME_FORMATS.get(mime)) throw error("ATTACHMENT_TYPE_MISMATCH", 415, "文件内容与图片类型不一致");
  const options = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning", sequentialRead: true };
  const metadata = await processImage(sharp(bytes, options).timeout({ seconds: DECODE_TIMEOUT_SECONDS }), signal, true);
  if (metadata.format !== actual || !metadata.width || !metadata.height) throw error("ATTACHMENT_INVALID_IMAGE", 422, "图片内容无效");
  if (metadata.width * metadata.height > MAX_INPUT_PIXELS) throw error("ATTACHMENT_TOO_MANY_PIXELS", 413, "图片像素过大，请缩小后上传");
  if ((metadata.pages || 1) > 1) throw error("ATTACHMENT_ANIMATED_IMAGE", 415, "请上传静态图片，暂不支持动画图片");
  let normalized = await processImage(sharp(bytes, options).rotate().flatten({ background: "#ffffff" }).resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).timeout({ seconds: DECODE_TIMEOUT_SECONDS }), signal);
  if (normalized.data.length > MAX_IMAGE_BYTES) normalized = await processImage(sharp(normalized.data, options).jpeg({ quality: 60 }).timeout({ seconds: DECODE_TIMEOUT_SECONDS }), signal);
  if (normalized.data.length > MAX_IMAGE_BYTES) throw error("ATTACHMENT_NORMALIZED_TOO_LARGE", 413, "图片压缩后仍过大，请缩小后重试");
  const thumbnail = await processImage(sharp(normalized.data, options).resize({ width: THUMBNAIL_DIMENSION, height: THUMBNAIL_DIMENSION, fit: "inside", withoutEnlargement: true }).webp({ quality: 75 }).timeout({ seconds: DECODE_TIMEOUT_SECONDS }), signal);
  checkSignal(signal);
  return { bytes: normalized.data, thumbnail: thumbnail.data, mime_type: "image/jpeg", width: normalized.info.width, height: normalized.info.height, size: normalized.data.length, sha256: hash(normalized.data), thumbnail_sha256: hash(thumbnail.data) };
}

export function createAttachmentStore({ root = process.cwd(), directory, env = {} } = {}) {
  const location = resolve(root, directory || env.COMPANION_ATTACHMENTS_DIR || ".private/companion-attachments");
  const comparable = path => process.platform === "win32" ? path.toLowerCase() : path;
  const validateId = id => {
    if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw error("ATTACHMENT_NOT_FOUND", 404, "图片不存在或无权访问");
    return id.toLowerCase();
  };
  async function safeDirectory(create = false) {
    if (create) await mkdir(location, { recursive: true, mode: 0o700 });
    const stat = await lstat(location);
    if (!stat.isDirectory() || stat.isSymbolicLink() || comparable(await realpath(location)) !== comparable(location)) throw error("ATTACHMENT_UNSAFE_STORAGE", 500, "图片存储目录不可用");
  }
  const target = (id, variant) => {
    if (!["image", "thumbnail"].includes(variant)) throw error("ATTACHMENT_INVALID_VARIANT", 400, "图片类型无效");
    return join(location, `${validateId(id)}${variant === "image" ? ".jpg" : ".thumb.webp"}`);
  };
  async function save(normalized, { signal } = {}) {
    checkSignal(signal);
    if (!Buffer.isBuffer(normalized?.bytes) || !Buffer.isBuffer(normalized?.thumbnail) || normalized.bytes.length > MAX_IMAGE_BYTES || normalized.thumbnail.length > MAX_IMAGE_BYTES || sniff(normalized.bytes) !== "jpeg" || sniff(normalized.thumbnail) !== "webp") throw error("ATTACHMENT_INVALID_IMAGE", 422, "图片尚未完成规范化处理");
    const id = randomUUID(), created = [];
    try {
      await safeDirectory(true);
      for (const [variant, bytes] of [["image", normalized.bytes], ["thumbnail", normalized.thumbnail]]) {
        checkSignal(signal);
        const path = target(id, variant), handle = await open(path, "wx", 0o600); created.push(path);
        try { await handle.writeFile(bytes, { signal }); } finally { await handle.close(); }
      }
      checkSignal(signal);
      return { attachment_id: id, mime_type: "image/jpeg", width: normalized.width, height: normalized.height, size: normalized.bytes.length, sha256: hash(normalized.bytes), thumbnail_sha256: hash(normalized.thumbnail) };
    } catch (cause) {
      await Promise.allSettled(created.map(path => unlink(path)));
      if (signal?.aborted) throw cancelled();
      if (cause.code?.startsWith("ATTACHMENT_")) throw cause;
      throw error("ATTACHMENT_STORAGE_FAILED", 500, "图片保存失败，请稍后重试");
    }
  }
  async function read(id, { variant = "image", signal } = {}) {
    const path = target(id, variant); checkSignal(signal);
    let handle;
    try {
      await safeDirectory();
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) throw error("ATTACHMENT_NOT_FOUND", 404, "图片不存在或无权访问");
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES || stat.dev !== before.dev || stat.ino !== before.ino) throw error("ATTACHMENT_NOT_FOUND", 404, "图片不存在或无权访问");
      const bytes = await handle.readFile({ signal }); checkSignal(signal);
      const expected = variant === "image" ? "jpeg" : "webp";
      if (bytes.length > MAX_IMAGE_BYTES || sniff(bytes) !== expected) throw error("ATTACHMENT_NOT_FOUND", 404, "图片不存在或无权访问");
      return { bytes, mime_type: variant === "image" ? "image/jpeg" : "image/webp", sha256: hash(bytes) };
    } catch (cause) {
      if (signal?.aborted) throw cancelled();
      if (cause.code?.startsWith("ATTACHMENT_")) throw cause;
      if (["ENOENT", "ELOOP", "ENOTDIR"].includes(cause.code)) throw error("ATTACHMENT_NOT_FOUND", 404, "图片不存在或无权访问");
      throw error("ATTACHMENT_STORAGE_FAILED", 500, "图片读取失败，请稍后重试");
    } finally { await handle?.close(); }
  }
  async function remove(id) {
    const paths = [target(id, "image"), target(id, "thumbnail")];
    try {
      await safeDirectory();
      for (const path of paths) {
        try { await unlink(path); } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
      }
    } catch (cause) {
      if (cause.code === "ENOENT") return;
      if (cause.code?.startsWith("ATTACHMENT_")) throw cause;
      throw error("ATTACHMENT_STORAGE_FAILED", 500, "图片删除失败，请稍后重试");
    }
  }
  return { save, read, remove };
}
