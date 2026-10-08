// Gateways sometimes send SSE even when stream:false; consume the actual response format.
export function textContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value && typeof value === "object") return textContent(value.text ?? value.content ?? value.value ?? "");
  return "";
}

export function extractText(value) {
  const choice = value?.choices?.[0];
  if (choice) return textContent(choice.delta?.content ?? choice.message?.content ?? choice.text ?? "");
  if (value?.type === "response.output_text.delta") return textContent(value.delta);
  if (value?.type === "response.output_text.done") return textContent(value.text);
  const response = value?.response ?? value;
  if (response?.output_text) return textContent(response.output_text);
  if (Array.isArray(response?.output)) return response.output.filter(x => x.type === "message").map(x => textContent(x.content)).join("");
  return "";
}

export function upstreamError(value, fallback = "AI 接口请求失败") {
  const error = value?.error ?? value?.response?.error;
  return String(error?.message ?? (typeof error === "string" ? error : "") ?? "") || String(value?.message || fallback);
}

export function apiEndpoint(base, mode = "chat") {
  const value = String(base || "").replace(/\/+$/, "");
  if (/\/(?:chat\/completions|responses|images\/generations)$/.test(value)) return value;
  let normalized = value;
  try { if (new URL(value).pathname === "/") normalized += "/v1"; } catch { /* fetch validates configured endpoint */ }
  return `${normalized}/${mode === "responses" ? "responses" : "chat/completions"}`;
}

export async function consumeAIResponse(response, onDelta = () => {}) {
  if (!response.ok) {
    const body = await response.text();
    let value; try { value = JSON.parse(body); } catch { value = {}; }
    throw new Error(upstreamError(value, `AI 请求失败：HTTP ${response.status}`).slice(0, 500));
  }
  if (!response.body) throw new Error("AI 接口未返回响应正文");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", raw = "", sse = /text\/event-stream/i.test(response.headers.get("content-type") || ""), decided = false;
  const append = text => { if (text) { raw += text; if (raw.length > 16 * 1024 * 1024) throw new Error("AI 文字响应过大"); onDelta(text, raw); } };
  const finalMessage = text => {
    if (!text || text === raw) return;
    if (text.length > 16 * 1024 * 1024) throw new Error("AI 文字响应过大");
    const previousText = partialReplyText(raw), completeText = partialReplyText(text);
    // A Chat message is a full snapshot, not another token delta. It may contain
    // structured media absent from the deltas, so keep it as the final result.
    raw = text;
    // Notify consumers of the canonical snapshot without appending its JSON shell.
    // A changed prefix is reconciled by the final reply, not invented as a suffix.
    onDelta(completeText.startsWith(previousText) ? completeText.slice(previousText.length) : "", raw);
  };
  const event = block => {
    const data = block.split(/\r?\n/).filter(x => x.startsWith("data:")).map(x => x.slice(5).trimStart()).join("\n").trim();
    if (!data || data === "[DONE]") return;
    let value; try { value = JSON.parse(data); } catch { throw new Error("AI 流式响应包含无效 JSON"); }
    if (value.error || value.type === "error" || /response\.(failed|incomplete)$/.test(value.type || "")) throw new Error(upstreamError(value, "AI 回复未完成"));
    // Responses terminal events repeat the full output: emit them only when no deltas arrived.
    if (/response\.(output_text\.done|completed)$/.test(value.type || "") && raw) return;
    const choice = value?.choices?.[0];
    if (choice?.message?.content != null) {
      const complete = textContent(choice.message.content);
      if (complete) { finalMessage(complete); return; }
    }
    append(extractText(value));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (!decided && buffer.trim()) {
        const probe = buffer.trimStart();
        if (/^(data:|event:|:)/.test(probe)) { sse = true; decided = true; }
        else if (/^[{\[]/.test(probe)) { sse = false; decided = true; }
      }
      if (sse) {
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) event(block);
      }
      if (buffer.length > 16 * 1024 * 1024) throw new Error("AI 文字响应过大");
      if (done) break;
    }
    if (sse) { if (buffer.trim()) event(buffer); }
    else {
      let value; try { value = JSON.parse(buffer); } catch { throw new Error("AI 返回格式错误，请检查接口地址及协议"); }
      if (value.error || value.status === "failed" || value.status === "incomplete") throw new Error(upstreamError(value));
      append(extractText(value));
    }
    if (!raw.trim()) throw new Error("AI 接口返回了空内容，请检查文字模型和接口权限；本次不扣点");
    return raw;
  } finally { reader.releaseLock(); }
}

export function createTextClient(config) {
  return async function generate(messages, { model, maxTokens = 1800, stream = false, onDelta, signal } = {}) {
    if (!config.key) throw new Error("未配置 AI_API_KEY");
    if (!config.baseUrl) throw new Error("未配置 AI_BASE_URL");
    if (!model) throw new Error("未配置文字模型，请设置 AI_COMPANION_MODEL / AI_NOVEL_MODEL");
    const mode = config.mode === "responses" ? "responses" : "chat";
    const url = config.endpoint || apiEndpoint(config.baseUrl, mode);
    const body = mode === "responses"
      ? { model, input: messages, max_output_tokens: maxTokens, stream }
      : { model, messages, [config.tokenField || "max_tokens"]: maxTokens, stream, ...(config.temperature === false ? {} : { temperature: .85 }) };
    const timeout = AbortSignal.timeout(config.timeoutMs || 180000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${config.key}` }, body: JSON.stringify(body), signal: combined });
      return await consumeAIResponse(response, onDelta);
    } catch (error) {
      if (timeout.aborted) throw new Error("文字接口响应超时，请稍后再试；本次不扣点");
      if (signal?.aborted) throw new Error("请求已取消");
      const network = /fetch failed|ECONN(?:RESET|REFUSED)|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET)/i.test(`${error.message || ""} ${error.cause?.code || ""}`);
      const message = network ? "文字接口连接失败，请检查服务器到模型平台的网络和 AI_BASE_URL；本次不扣点" : String(error.message || "文字接口连接失败");
      throw new Error(message.replaceAll(config.key, "[hidden]").slice(0, 600));
    }
  };
}

export function parseReply(raw) {
  let source = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value; try { value = JSON.parse(source); } catch { value = null; }
  const text = value && typeof value === "object" ? textContent(value.text ?? value.reply ?? value.content ?? "").trim() : source;
  if (!text) throw new Error("AI 回复的文字为空；本次不扣点");
  return { text, media: value?.media && typeof value.media === "object" ? value.media : {} };
}

// Decode an incomplete JSON string to show the text field as upstream tokens arrive.
export function partialReplyText(raw) {
  const source = String(raw).trimStart().replace(/^```(?:json)?\s*/i, "");
  if (!source || /^`/.test(source)) return "";
  if (!source.startsWith("{")) return source;
  const match = /"text"\s*:\s*"/.exec(source);
  if (!match) return "";
  let out = "";
  for (let i = match.index + match[0].length; i < source.length; i++) {
    const c = source[i];
    if (c === '"') break;
    if (c !== "\\") { out += c; continue; }
    const n = source[++i];
    if (!n) break;
    if (n === "u") {
      const hex = source.slice(i + 1, i + 5);
      if (!/^[\da-f]{4}$/i.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else out += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[n] ?? n;
  }
  return out;
}
