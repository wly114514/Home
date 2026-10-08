// Kept dependency-free so deployment checks and recovery tools share startup rules.
export function validateProductionConfig(env) {
  if (env.NODE_ENV !== "production") return;
  const jwtSecret = env.JWT_SECRET || "change-this-secret", adminPassword = env.ADMIN_PASSWORD || "admin123456";
  const placeholder = /^(?:change-this|your-|dev-|replace-with|placeholder|example)/i;
  if (jwtSecret.length < 24 || placeholder.test(jwtSecret)) throw new Error("生产服务需要设置足够长的 JWT_SECRET");
  if (adminPassword.length < 10 || adminPassword === "admin123456" || placeholder.test(adminPassword)) throw new Error("生产服务需要设置安全的 ADMIN_PASSWORD");
}
