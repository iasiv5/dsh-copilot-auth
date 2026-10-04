// runtime-scope.mjs — 稳定 profile 身份与私有数据目录（T2）。
// 契约：resolveRuntimeScope(ctx) -> {known, profileId, dataDir, reason?}
//  - dataDir = join(profileContext.dir, "copilot-auth")（dir = $DSH_HOME/profiles/<name>，
//    profile 私有；禁止使用跨 profile 共享的 home）
//  - profileId = sha256(name \0 dir) 前 16 hex
//  - 缺 profileContext 或形状非法 → known=false + reason；调用方禁写新状态
// 本模块纯计算，不写盘；dataDir 由调用方按需创建。
import { createHash } from "node:crypto";
import { join } from "node:path";

function validString(v) {
  return typeof v === "string" && v.length > 0;
}

export function resolveRuntimeScope(ctx) {
  const pc = ctx?.profileContext;
  if (!pc || typeof pc !== "object" || Array.isArray(pc)) {
    return { known: false, profileId: null, dataDir: null, reason: "profile-context-unavailable" };
  }
  if (!validString(pc.name) || !validString(pc.dir)) {
    return { known: false, profileId: null, dataDir: null, reason: "profile-context-invalid" };
  }
  const profileId = createHash("sha256").update(`${pc.name}\0${pc.dir}`).digest("hex").slice(0, 16);
  return { known: true, profileId, dataDir: join(pc.dir, "copilot-auth") };
}
