import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { Readable } from "node:stream";
import { mkdtemp, readFile, readdir, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { normalizeImage, createAttachmentStore, MAX_UPLOAD_BYTES, MAX_IMAGE_BYTES } from "../attachments.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const fixture = (width = 64, height = 48) => sharp({ create: { width, height, channels: 4, background: { r: 50, g: 100, b: 150, alpha: 0.5 } } });
const rejects = (operation, code, status) => assert.rejects(operation, error => error.code === code && error.status === status);

test("real JPEG/PNG/WebP uploads normalize to bounded JPEG and a matching thumbnail with metadata removed", async () => {
  for (const format of ["jpeg", "png", "webp"]) {
    const bytes = await fixture(2560, 1440)[format]().toBuffer();
    const normalized = await normalizeImage(bytes, { contentType: `image/${format}` });
    const image = await sharp(normalized.bytes).metadata(), thumbnail = await sharp(normalized.thumbnail).metadata();
    assert.equal(image.format, "jpeg"); assert.equal(thumbnail.format, "webp");
    assert.equal(image.width, 2048); assert.equal(image.height, 1152);
    assert.ok(Math.max(thumbnail.width, thumbnail.height) <= 320);
    assert.equal(normalized.width, image.width); assert.equal(normalized.height, image.height);
    assert.ok(normalized.size <= MAX_IMAGE_BYTES); assert.equal(normalized.size, normalized.bytes.length);
    assert.equal(normalized.sha256, digest(normalized.bytes)); assert.equal(normalized.thumbnail_sha256, digest(normalized.thumbnail));
    assert.equal(image.exif, undefined); assert.equal(image.icc, undefined);
  }
  const original = await fixture(80, 40).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const normalized = await normalizeImage(original, { contentType: "image/jpeg" });
  assert.deepEqual([normalized.width, normalized.height], [40, 80]);
  assert.equal((await sharp(normalized.bytes).metadata()).orientation, undefined);
});

test("upload bytes and declared length are bounded before decoding; interrupted requests can be cancelled", async () => {
  await rejects(normalizeImage(Buffer.alloc(MAX_UPLOAD_BYTES + 1), { contentType: "image/jpeg" }), "ATTACHMENT_TOO_LARGE", 413);
  let consumed = false;
  const declared = Readable.from((async function* () { consumed = true; yield Buffer.from("unused"); })());
  declared.headers = { "content-type": "image/jpeg", "content-length": String(MAX_UPLOAD_BYTES + 1) };
  await rejects(normalizeImage(declared), "ATTACHMENT_TOO_LARGE", 413); assert.equal(consumed, false); declared.destroy();
  const chunked = Readable.from([Buffer.alloc(MAX_UPLOAD_BYTES), Buffer.alloc(1)]); chunked.headers = { "content-type": "image/jpeg" };
  await rejects(normalizeImage(chunked), "ATTACHMENT_TOO_LARGE", 413);
  const controller = new AbortController(), waiting = new Readable({ read() {} }); waiting.headers = { "content-type": "image/jpeg" };
  const pending = normalizeImage(waiting, { signal: controller.signal }); controller.abort();
  await rejects(pending, "ATTACHMENT_CANCELLED", 499);
});

test("SVG, mismatched MIME, truncated files and excessive input pixels are rejected without returning input details", async () => {
  const png = await fixture().png().toBuffer();
  await rejects(normalizeImage(Buffer.from('<svg><text>PRIVATE_IMAGE_CONTENT</text></svg>'), { contentType: "image/svg+xml" }), "ATTACHMENT_UNSUPPORTED_TYPE", 415);
  await rejects(normalizeImage(png, { contentType: "image/jpeg" }), "ATTACHMENT_TYPE_MISMATCH", 415);
  await assert.rejects(normalizeImage(png.subarray(0, Math.floor(png.length / 2)), { contentType: "image/png" }), error => error.status === 422 && !error.message.includes("PRIVATE_IMAGE_CONTENT") && !error.cause);
  const enormous = await fixture(5000, 5000).png().toBuffer();
  await rejects(normalizeImage(enormous, { contentType: "image/png" }), "ATTACHMENT_TOO_MANY_PIXELS", 413);
  const controller = new AbortController(); controller.abort();
  await rejects(normalizeImage(png, { contentType: "image/png", signal: controller.signal }), "ATTACHMENT_CANCELLED", 499);
});

test("private store saves exactly the normalized bytes, supports independent reads and removes both variants idempotently", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "mihoyo-attachment-store-test-"));
  t.after(async () => { assert.ok(root.startsWith(resolve(tmpdir(), "mihoyo-attachment-store-test-"))); await rm(root, { recursive: true, force: true }); });
  const store = createAttachmentStore({ root }), normalized = await normalizeImage(await fixture().png().toBuffer(), { contentType: "image/png" });
  const saved = await store.save(normalized), id = saved.attachment_id;
  assert.match(id, /^[a-f0-9-]{36}$/); assert.equal(saved.sha256, normalized.sha256);
  assert.deepEqual((await store.read(id)).bytes, normalized.bytes);
  const thumbnail = await store.read(id, { variant: "thumbnail" }); assert.deepEqual(thumbnail.bytes, normalized.thumbnail); assert.equal(thumbnail.mime_type, "image/webp");
  const directory = resolve(root, ".private/companion-attachments");
  assert.deepEqual((await readdir(directory)).sort(), [`${id}.jpg`, `${id}.thumb.webp`].sort());
  if (process.platform !== "win32") { assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(resolve(directory, `${id}.jpg`))).mode & 0o777, 0o600); }
  await rejects(store.read("../../.env"), "ATTACHMENT_NOT_FOUND", 404);
  await rejects(store.read(id, { variant: "../../.env" }), "ATTACHMENT_INVALID_VARIANT", 400);
  await rejects(store.save({ ...normalized, bytes: Buffer.from("not an image") }), "ATTACHMENT_INVALID_IMAGE", 422);
  await store.remove(id); await store.remove(id); assert.deepEqual(await readdir(directory), []);
  await rejects(store.read(id), "ATTACHMENT_NOT_FOUND", 404);
});

test("symlinked private directories cannot read, overwrite or remove files outside the configured store", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "mihoyo-attachment-symlink-test-"));
  t.after(async () => { assert.ok(root.startsWith(resolve(tmpdir(), "mihoyo-attachment-symlink-test-"))); await rm(root, { recursive: true, force: true }); });
  const outside = resolve(root, "outside"), linked = resolve(root, "linked"), original = createAttachmentStore({ directory: outside });
  const normalized = await normalizeImage(await fixture().png().toBuffer(), { contentType: "image/png" }), saved = await original.save(normalized);
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  const forbidden = createAttachmentStore({ directory: linked });
  await rejects(forbidden.read(saved.attachment_id), "ATTACHMENT_UNSAFE_STORAGE", 500);
  await rejects(forbidden.save(normalized), "ATTACHMENT_UNSAFE_STORAGE", 500);
  await rejects(forbidden.remove(saved.attachment_id), "ATTACHMENT_UNSAFE_STORAGE", 500);
  assert.deepEqual(await readFile(resolve(outside, `${saved.attachment_id}.jpg`)), normalized.bytes);
  assert.equal((await readdir(outside)).length, 2);
});
