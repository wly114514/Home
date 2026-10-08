import { readFileSync, statSync } from "node:fs";

// Keys remain stable across catalog updates: stored conversations use these identifiers.
export function createCatalog(file) {
  let fingerprint = "", items = [], byKey = new Map();
  function refresh() {
    try {
      const info = statSync(file), next = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (next === fingerprint) return;
      const value = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      const list = Array.isArray(value) ? value : value.presets;
      items = (Array.isArray(list) ? list : []).filter(item => item && typeof item.key === "string" && item.key && item.key !== "preset_01");
      byKey = new Map(items.map(item => [item.key, item])); fingerprint = next;
    } catch { fingerprint = ""; items = []; byKey = new Map(); }
  }
  return { list: () => { refresh(); return items; }, find: key => { refresh(); return byKey.get(String(key || "")); } };
}

export function catalogMetadata(preset = {}) {
  const avatar = String(preset.avatar_url || preset.portrait_url || ""), portrait = String(preset.portrait_url || preset.avatar_url || "");
  return {
    game: String(preset.game || ""), game_title: String(preset.game_title || ""), rarity: Number(preset.rarity) || null,
    element: String(preset.element || ""), region: String(preset.region || ""), avatar_url: avatar, portrait_url: portrait,
    sources: (Array.isArray(preset.sources) ? preset.sources : []).filter(value => typeof value === "string" && /^https?:\/\//i.test(value))
  };
}

function snapshot(profile) { try { const value = JSON.parse(profile.profile_json || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } }

export function personalPreference(profile, preset) {
  const preference = String(profile.user_preference || "").trim();
  if (!preset || !preference) return preference;
  // Python and the first Node version copied the whole built-in prompt into this column.
  // That snapshot identifies catalog defaults without deleting any stored preferences.
  const previous = snapshot(profile);
  const builtins = [previous.user_preference, previous.role_prompt, preset.user_preference, preset.role_prompt].map(value => String(value || "").trim().slice(0, 4000).trim()).filter(Boolean);
  return builtins.includes(preference) ? "" : preference;
}

export function effectiveProfile(profile, preset) {
  const previous = snapshot(profile);
  if (!preset) return { ...profile, ...catalogMetadata(previous), role_prompt: String(previous.role_prompt || ""), image_prompt: String(previous.image_prompt || ""), catalog_available: false };
  return {
    ...profile, ...catalogMetadata(preset), character_name: preset.character_name || profile.character_name,
    search_summary: preset.search_summary || preset.summary || "", role_prompt: preset.role_prompt || preset.user_preference || preset.search_summary || preset.summary || "",
    user_preference: personalPreference(profile, preset), image_prompt: String(preset.image_prompt || ""), catalog_available: true
  };
}
