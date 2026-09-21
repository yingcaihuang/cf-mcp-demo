#!/usr/bin/env node
/**
 * 从 dotenv 格式的密钥文件中挑出 wrangler.jsonc 声明为必需的密钥，
 * 校验齐全后写成 JSON，供 `wrangler deploy --secrets-file` 使用。
 *
 * 为什么不直接把 .dev.vars 传给 --secrets-file：
 *  1. dotenv 的值常带引号，交给不同解析器可能把引号当成值的一部分，
 *     那样签名会静默算错，排查成本极高。这里显式剥离引号。
 *  2. .dev.vars 里可能还有 RACORE_API_BASE_URL 这类明文变量，
 *     一旦被当作 secret 上传，就会和 wrangler.jsonc 的 vars 同名冲突。
 *     这里只挑 secrets.required 里声明的名字。
 *
 * 用法: node scripts/collect-secrets.mjs <密钥文件> <输出 JSON 路径>
 * 输出只打印密钥名，绝不打印值。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const [secretsFileArg, outputArg] = process.argv.slice(2);
if (!secretsFileArg || !outputArg) {
  console.error("用法: node scripts/collect-secrets.mjs <密钥文件> <输出 JSON 路径>");
  process.exit(2);
}

/**
 * 剥离 JSONC 注释。用状态机跟踪字符串上下文，避免把字符串里的 `//`
 * （例如 "https://example.com"）误当成注释起点。
 */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 解析 dotenv：支持 KEY=value、KEY="value"、KEY='value'、行内注释与空行 */
function parseDotenv(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    // 带引号：取引号内内容，引号内的 # 不视为注释
    if (
      (value.startsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.length > 1)
    ) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      // 无引号：去掉行内注释
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    result[key] = value;
  }
  return result;
}

// ── 读取 wrangler.jsonc 中声明为必需的密钥名 ──────────────────────────
const wranglerPath = resolve(projectRoot, "wrangler.jsonc");
if (!existsSync(wranglerPath)) {
  console.error(`找不到 ${wranglerPath}`);
  process.exit(1);
}

let required;
try {
  const config = JSON.parse(stripJsonComments(readFileSync(wranglerPath, "utf8")));
  required = config?.secrets?.required ?? [];
} catch (error) {
  console.error(`解析 wrangler.jsonc 失败: ${error.message}`);
  process.exit(1);
}

if (!Array.isArray(required) || required.length === 0) {
  console.error(
    "wrangler.jsonc 的 secrets.required 为空，无需通过 --secrets-file 上传密钥。",
  );
  process.exit(1);
}

// ── 读取密钥文件 ────────────────────────────────────────────────────
const secretsPath = resolve(process.cwd(), secretsFileArg);
if (!existsSync(secretsPath)) {
  console.error(`找不到密钥文件: ${secretsPath}`);
  console.error(`请复制 .dev.vars.example 为 ${secretsFileArg} 并填入真实值。`);
  process.exit(1);
}

const parsed = parseDotenv(readFileSync(secretsPath, "utf8"));

// ── 校验并挑选 ──────────────────────────────────────────────────────
const payload = {};
const missing = [];

for (const name of required) {
  const value = parsed[name];
  if (typeof value !== "string" || value.trim() === "") {
    missing.push(name);
    continue;
  }
  payload[name] = value;
}

if (missing.length > 0) {
  console.error(`密钥文件 ${secretsFileArg} 中缺少或为空: ${missing.join(", ")}`);
  process.exit(1);
}

// 提示被忽略的键，避免用户以为它们也上传了
const ignored = Object.keys(parsed).filter((k) => !required.includes(k));

writeFileSync(resolve(process.cwd(), outputArg), JSON.stringify(payload), {
  mode: 0o600,
});

// 只打印名字，不打印值
console.log(`将上传 ${required.length} 个密钥: ${required.join(", ")}`);
if (ignored.length > 0) {
  console.log(`已忽略非密钥项（由 wrangler.jsonc 的 vars 管理）: ${ignored.join(", ")}`);
}
