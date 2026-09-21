#!/usr/bin/env bash
#
# 部署 Worker，并在同一次操作中上传密钥。
#
# 解决的问题：Worker 首次部署时尚不存在，`wrangler secret put` 无法预先写入密钥，
# 而 wrangler.jsonc 的 secrets.required 又会让 deploy 因缺密钥而失败。出路是
# `wrangler deploy --secrets-file`，在部署的同时提交密钥。
#
# 该命令对已存在的 Worker 同样安全：文件中未包含的密钥会沿用上一个版本，
# 所以这个脚本可以反复执行。
#
# 用法：
#   bash scripts/deploy.sh                    # 从 .dev.vars 读取密钥
#   bash scripts/deploy.sh .dev.vars.prod     # 指定其它密钥文件
#   CLOUDFLARE_ACCOUNT_ID=xxx bash scripts/deploy.sh   # 跳过账号交互选择
#
# 密钥值不会出现在命令行参数、标准输出或 shell 历史中。

set -euo pipefail

cd "$(dirname "$0")/.."

SECRETS_FILE="${1:-${SECRETS_FILE:-.dev.vars}}"

# ── 前置检查 ─────────────────────────────────────────────────────────
if [ ! -f "$SECRETS_FILE" ]; then
  echo "错误：找不到密钥文件 $SECRETS_FILE" >&2
  echo "" >&2
  echo "请先创建它（该文件已被 .gitignore 忽略，不会进版本库）：" >&2
  echo "    cp .dev.vars.example $SECRETS_FILE" >&2
  echo "    # 然后填入真实的 RACORE_ACCESS_KEY 与 RACORE_SECRET_KEY" >&2
  exit 1
fi

# 密钥文件不应对其他用户可读
if [ "$(uname)" = "Darwin" ]; then
  PERMS="$(stat -f '%OLp' "$SECRETS_FILE")"
else
  PERMS="$(stat -c '%a' "$SECRETS_FILE")"
fi
case "$PERMS" in
  600|400) ;;
  *)
    echo "提示：$SECRETS_FILE 权限为 $PERMS，建议收紧为 600" >&2
    echo "    chmod 600 $SECRETS_FILE" >&2
    ;;
esac

# ── 生成临时 secrets JSON ────────────────────────────────────────────
# 放在项目内：wrangler 解析 --secrets-file 时以项目为基准更稳妥。
TMP_SECRETS="$(mktemp "./.secrets.deploy.XXXXXX.json")"

cleanup() {
  if [ -f "$TMP_SECRETS" ]; then
    # 先覆写再删除，降低内容残留在磁盘上的可能
    : > "$TMP_SECRETS"
    rm -f "$TMP_SECRETS"
  fi
}
trap cleanup EXIT INT TERM

chmod 600 "$TMP_SECRETS"

echo "▸ 校验密钥文件：$SECRETS_FILE"
node scripts/collect-secrets.mjs "$SECRETS_FILE" "$TMP_SECRETS"

# ── 部署 ────────────────────────────────────────────────────────────
echo ""
echo "▸ 部署中（密钥随本次部署一并提交）"
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "  使用账号 CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID}"
else
  echo "  未设置 CLOUDFLARE_ACCOUNT_ID，wrangler 可能会让你交互选择账号"
fi
echo ""

npx wrangler deploy --secrets-file "$TMP_SECRETS"

echo ""
echo "▸ 部署完成"
echo ""
echo "后续步骤："
echo "  1. 访问 /health 确认 credentials_configured 为 true"
echo "  2. 配置 Cloudflare Access 保护 /mcp —— 在此之前端点是公开的，"
echo "     任何知道 URL 的人都能借你的 AK/SK 查询 CDN 数据"
echo ""
echo "密钥已保存在 Worker 上，后续仅改代码时可直接用 npx wrangler deploy。"
