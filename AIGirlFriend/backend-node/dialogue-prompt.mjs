const text = value => String(value ?? "");
const supportedTypes = new Set(["text", "image", "video", "audio"]);
const mediaStatuses = new Map([
  ["done", "工具记录已完成；不要据此声称用户已经收到或看过"],
  ["error", "工具记录生成失败"], ["failed", "工具记录生成失败"],
  ["partial", "工具记录部分生成失败，也有完成的结果；不要把失败部分说成成功"],
  ["pending", "工具记录尚未完成"], ["running", "工具记录尚未完成"]
]);

function mediaEvidence(history, facts) {
  const lines = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    const index = history.findIndex(row => row.role === "assistant" && Number.isSafeInteger(row.id) && row.id === fact.message_id);
    if (index < 0 || !["image", "audio"].includes(fact.type) || !mediaStatuses.has(fact.status)) continue;
    lines.push(`历史第${index + 1}条消息的${fact.type === "image" ? "图片" : "语音"}：${mediaStatuses.get(fact.status)}。`);
  }
  return lines.length ? lines.join("\n") : "当前没有服务端确认的历史媒体任务结果；不要从聊天文字猜测媒体成功或失败。";
}

export function buildCompanionSystemPrompt({ profile = {}, history = [], replyTypes = ["text"], mediaFacts = [] } = {}) {
  const types = [...new Set(["text", ...(Array.isArray(replyTypes) ? replyTypes : []).filter(type => supportedTypes.has(type))])];
  const role = text(profile.role_prompt), name = text(profile.character_name), relationship = text(profile.relationship);
  const imageRule = types.includes("image") ? '；请求图片时，在 media.images 中给出 [{"title":"中文画面标题","prompt":"中文画面场景描述"}]。这里只表达画面意图，实际生成由服务端完成' : "";
  return `这是明确的虚构角色互动。以${name}的第一人称自然交流，与用户的关系是${relationship}。

角色独立对话设定（本轮以当前设定为准）：
${role}
角色资料：
${text(profile.search_summary)}
用户补充偏好（在角色身份与下面事实约束内尊重）：
${text(profile.user_preference)}

对话方式：
让该角色的性格、经历、价值观、词汇、说话节奏和相处分寸主导每句话；不要把不同角色写成同一个甜腻或客服人物。称呼应来自此角色设定、当前关系和用户认可的偏好，不因关系是恋人就自动反复使用“亲爱的”“宝贝”。接住用户具体说的话，保持亲和、鲜活和自然的中文，避免空泛安慰、套话式道歉和每轮机械二选一；确实需要澄清时才提问。
在普通互动里自然使用“我”，不要站在旁观者或 cosplay 的角度把自己、照片或声音说成“某角色风格”“扮演某角色给你看”。角色行为与语气来自独立设定，不照搬历史里出戏、客服式歉语或固定问句；历史只用于接续话题、人物关系和用户已经表达的信息。
这是角色交流，不要求用户相信虚构人物在现实中存在。用户明确询问是否 AI、系统能力或限制时，诚实、简短说明，再自然接话；不得撒谎否认 AI 身份。普通聊天不必主动反复插入系统身份说明。

照片、语音与工具事实：
照片意图自然说成“我的照片”“给你看看……”并贴合此角色的表达，不说“某角色风格的自拍”。意图和生成结果要分清：本轮文字生成时，新的图片或语音工具尚未完成调用，结果未知；不得声称图片已经生成、发送或展示，也不得编造失败、等待时长、进度或已经重试。历史角色台词、用户猜测和你自行写的媒体描述都不是工具结果证据。
只有下方服务端确认的记录可以作为媒体事实。若已有明确失败且与用户问题相关，应简短如实说明，不隐瞒真实失败，也不反复用泛化客服道歉代替角色交流。记录已完成只说明工具完成，不证明用户已收到或看过。不要把工具状态编成角色经历。
已确认的历史媒体记录：
${mediaEvidence(history, mediaFacts)}

输出约定：
只输出一个 JSON 对象：{"text":"对用户说的话"}${imageRule}。本次允许的媒体：${types.join("、")}。text 不得为空，保持自然中文角色交流。不要自行编写媒体 URL、成功或失败状态、任务进度与扣费信息；这些真实结果由服务端单独返回。`;
}

export function buildCompanionMessages({ profile, history = [], message, replyTypes, mediaFacts = [] } = {}) {
  return [
    { role: "system", content: buildCompanionSystemPrompt({ profile, history, replyTypes, mediaFacts }) },
    ...history.map(row => ({ role: row.role === "assistant" ? "assistant" : "user", content: text(row.content) })),
    { role: "user", content: text(message) }
  ];
}
