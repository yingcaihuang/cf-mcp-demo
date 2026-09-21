# Racore CDN Statistic Analysis — MCP Server on Cloudflare Workers

把 Racore CDN 的 **Statistic Analysis** 接口封装成远程 MCP Server，部署在 Cloudflare Workers 上。
AK/SK 存放在 Workers Secrets 中，Worker 内部完成 HMAC-SHA512 签名鉴权与 token 缓存，MCP 客户端不接触密钥。

## 架构

```
MCP 客户端  ──HTTP──▶  Cloudflare Worker  ──POST /API/OAuth/token──▶  Racore
(Claude / Kiro 等)      ├─ createMcpHandler(无状态)                    (换取 24h token)
                        ├─ HMAC-SHA512 签名 + token 内存缓存
                        └─ 15 个统计工具            ──Bearer token──▶  /API/cdn/statistics/*
```

采用 `agents/mcp/server` 的 `createMcpHandler`（MCP SDK v2，无状态）。
`McpAgent` 已被官方标记为废弃且功能冻结，因此本项目**不需要 Durable Object 绑定，也没有 migrations**。

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | Worker 入口、路由、可选的端点访问令牌校验 |
| `src/env.ts` | 环境变量类型与配置解析 |
| `src/auth.ts` | 签名计算、token 获取与缓存、签名格式自动回退 |
| `src/client.ts` | 统一 API 调用、时间参数校验、401 重试 |
| `src/schemas.ts` | 各接口的 zod 参数定义 |
| `src/tools/statistics.ts` | 15 个 MCP 工具注册与结果处理 |

## 工具清单

时序类（`bw`/`flow`/`req` 字段，5 分钟粒度）：

| 工具 | 接口路径 | 说明 |
| --- | --- | --- |
| `racore_query_bandwidth` | `/API/cdn/statistics/bandwidth` | 带宽 (bps) |
| `racore_query_origin_bandwidth` | `/API/cdn/statistics/src/bandwidth` | 回源带宽 |
| `racore_query_traffic` | `/API/cdn/statistics/flow` | 流量 (字节) |
| `racore_query_hit_traffic` | `/API/cdn/statistics/hit/flow` | 命中流量 |
| `racore_query_origin_traffic` | `/API/cdn/statistics/src/flow` | 回源流量 |
| `racore_query_request_count` | `/API/cdn/statistics/request` | 请求数 |
| `racore_query_hit_request_count` | `/API/cdn/statistics/hit/request` | 命中请求数 |
| `racore_query_origin_request_count` | `/API/cdn/statistics/src/request` | 回源请求数 |

状态码 / 地区 / 排行：

| 工具 | 接口路径 | 说明 |
| --- | --- | --- |
| `racore_query_http_status_code` | `/API/cdn/statistics/http/code` | 状态码时序明细 + `report` 汇总 |
| `racore_query_http_status_code_by_domain` | `/API/cdn/statistics/http/code/detail` | 按域名聚合状态码总量，支持分页 |
| `racore_query_country_region_consumption` | `/API/cdn/statistics/district` | 国家/地区消耗，附 `country_codes` 对照表 |
| `racore_top_domains` | `/API/cdn/statistics/top/domain` | 域名消耗排行 |
| `racore_top_url` | `/API/cdn/domain/top/url` | Top URL |
| `racore_top_referer` | `/API/cdn/domain/top/referer` | Top Referer |
| `racore_top_ua` | `/API/cdn/domain/top/ua` | Top UA，额外提供解码后的 `ua_decoded` |

### 参数差异（已在各工具 schema 中如实体现，不是笔误）

- 回源类（`src/*`）与状态码、地区类接口**不支持 `is_combine`**
- `/http/code` 用 **`codes`**（2xx/3xx/4xx/5xx）与 `code`（具体状态码）
- `/http/code/detail` 用 **`state_group`**，且**没有 `is_protocol`**，另有 `limit`/`page`
- `racore_top_domains` 只接受时间范围，**没有 `domain` 参数**（它本身即跨域名排行）
- Top URL/Referer/UA 的 `domain` **只支持单个域名**，且 `sorted` 取值各不相同
  （`url_size|url_count` / `referer_size|referer_count` / `ua_size|ua_count`）

## 部署

### 1. 安装依赖并登录

```bash
npm install
npx wrangler login
```

### 2. 确认 API 网关地址

官方文档的 OpenAPI spec 里 `servers` 为空，**没有给出实际网关域名**。
`wrangler.jsonc` 里暂填的是 `https://api.racorecloud.com`，请按控制台或客户经理提供的地址核对后修改：

```jsonc
"vars": {
  "RACORE_API_BASE_URL": "https://实际网关地址"
}
```

### 3. 写入密钥

AK/SK 走 Workers Secrets，不进代码也不进 `wrangler.jsonc`：

```bash
npx wrangler secret put RACORE_ACCESS_KEY
npx wrangler secret put RACORE_SECRET_KEY
```

**强烈建议**再设置一个端点访问令牌。否则任何拿到 Worker URL 的人都能借你的 AK/SK 查询 CDN 数据：

```bash
# 生成一个随机令牌并写入
openssl rand -hex 32
npx wrangler secret put MCP_AUTH_TOKEN
```

### 4. 部署

```bash
npm run deploy
```

部署后可访问 `https://<your-worker>.workers.dev/health` 确认状态，
其中 `credentials_configured` 与 `auth_required` 应为 `true`。

## 本地开发

```bash
npm install                      # postinstall 会自动生成 worker-configuration.d.ts
cp .dev.vars.example .dev.vars   # 填入真实 AK/SK
npm run dev
```

`.dev.vars` 已在 `.gitignore` 中。注意 `wrangler dev` 启动后再改 `.dev.vars` 里的
非密钥变量可能不会热更新，需要重启，或用 `--var KEY:VALUE` 直接覆盖。

`worker-configuration.d.ts` 是 `wrangler types` 从 `wrangler.jsonc` 生成的运行时类型
（约 600 KB），不进版本库，由 `postinstall` 自动重建。改过 `wrangler.jsonc` 的
`vars` / 绑定之后，手动跑一次 `npm run cf-typegen` 刷新。

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地启动（`http://localhost:8787`） |
| `npm run typecheck` | 重新生成类型并做 `tsc --noEmit` |
| `npm run dry-run` | 构建但不部署，检查产物体积 |
| `npm run deploy` | 部署到 Cloudflare |
| `npm run cf-typegen` | 仅重新生成运行时类型 |

## 接入 MCP 客户端

Streamable HTTP 端点是 `POST https://<your-worker>.workers.dev/mcp`。

```jsonc
{
  "mcpServers": {
    "racore-cdn": {
      "url": "https://<your-worker>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <你设置的 MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

若客户端只支持 stdio，可用 `mcp-remote` 桥接：

```jsonc
{
  "mcpServers": {
    "racore-cdn": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<your-worker>.workers.dev/mcp",
        "--header", "Authorization:Bearer <你设置的 MCP_AUTH_TOKEN>"
      ]
    }
  }
}
```

## 实现说明

**签名算法**：文档给出 `hash_hmac('sha512', request_timestamp + ak + sk, sk)`，
即 HMAC-SHA512、密钥为 sk、消息为三者拼接、输出小写 hex。已用 Node `crypto.createHmac`
作为参照验证过 WebCrypto 实现与 PHP `hash_hmac` 逐字节一致。

**签名时间戳格式的歧义处理**：请求头 `x-request-date` 是 RFC1123 格式，但签名参数叫
`request_timestamp`，文档未明确二者是否同一个值。因此代码默认按 RFC1123
（贴合文档"传入计算签名时所用的 x-request-date 值"的措辞），**若被拒则自动用 Unix
秒级时间戳重试一次**，并记住成功的格式供后续复用。确认实际格式后，可通过
`RACORE_SIGNATURE_TIMESTAMP_MODE` 固定为 `rfc1123` 或 `unix` 以省掉一次试错。

**token 缓存**：模块级内存缓存，作用域为当前 isolate，含并发去重和提前 5 分钟过期。
token 有效期 24 小时，最坏情况只是每个新 isolate 多做一次鉴权。收到 401/403 会作废
缓存并重试一次。

**参数前置校验**：`scope` 与 `start_time`/`end_time` 互斥、必须二选一、自定义区间需成对
出现且不超过 90 天 —— 这些都在 Worker 内先拦截，错误信息比上游更明确。

**响应体积保护**：5 分钟粒度查 30 天约 8600 个数据点，直接回传会挤占模型上下文。
序列化超过 60000 字符时自动抽稀数组（保留首尾），并在结果中加 `_truncated`
和 `_truncation_note` 说明，提示缩小时间范围。

## 已验证项

- 15 个工具全部注册，参数数量与文档逐一核对一致
- MCP `initialize` / `tools/list` / `tools/call` 全部正常
- 签名实现与 PHP `hash_hmac('sha512', ...)` 等价（3 组用例，含非 ASCII 密钥）
- `toUTCString()` 输出与文档 RFC1123 示例格式完全匹配
- 端到端链路：签名 → 换取 token → Bearer 调用统计接口 → 返回数据
- token 缓存复用：5 次 API 调用只触发 1 次鉴权
- 签名格式回退：服务端只认 unix 时，客户端从 rfc1123 自动回退成功
- 参数校验：时间冲突、缺失、区间超 90 天、start/end 不成对均被正确拦截
- `MCP_AUTH_TOKEN` 生效时，无 token 与错误 token 均返回 401，正确 token 返回 15 个工具
- UA 双重 URL 解码正确
- `tsc --noEmit` 无错误，`wrangler deploy --dry-run` 构建通过（214 KiB gzip）

> 端到端验证是针对本地模拟的 Racore 服务（会真实校验 HMAC 签名）完成的。
> 尚未对真实 Racore 生产接口发起过调用 —— 网关地址和账号密钥需要你提供后才能验证。
