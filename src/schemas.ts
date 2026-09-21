import { z } from "zod";

/**
 * 时间格式：文档给的是 `yyyy-mm-dd hh:mm`（例 2018-11-25 08:00）。
 * 这里放宽到可选秒、可用 T 分隔，降低模型填参时的失败率。
 */
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

const SCOPE_VALUES = [
  "today",
  "yesterday",
  "last7days",
  "last30days",
  "week",
  "month",
  "last_month",
] as const;

const SRV_TYPE_VALUES = [
  "oversea",
  "live",
  "video",
  "dynamic",
  "static",
  "download",
] as const;

/** 时间范围：scope 与 start_time/end_time 互斥，运行时由 validateTimeParams 兜底校验 */
export const timeRangeFields = {
  scope: z
    .enum(SCOPE_VALUES)
    .optional()
    .describe(
      "预设查询区间，与 start_time/end_time 互斥。today=当天, yesterday=昨天, " +
        "last7days=近7天, last30days=近30天, week=本周, month=本月, last_month=上月。",
    ),
  start_time: z
    .string()
    .regex(TIME_PATTERN, "格式须为 yyyy-mm-dd hh:mm，例如 2026-09-01 08:00")
    .optional()
    .describe(
      "自定义起始时间，格式 yyyy-mm-dd hh:mm。必须与 end_time 同时提供，且不能与 scope 同用。",
    ),
  end_time: z
    .string()
    .regex(TIME_PATTERN, "格式须为 yyyy-mm-dd hh:mm，例如 2026-09-30 23:55")
    .optional()
    .describe(
      "自定义结束时间，格式 yyyy-mm-dd hh:mm。必须与 start_time 同时提供，且不能与 scope 同用。",
    ),
} as const;

export const multiDomainField = z
  .string()
  .optional()
  .describe("加速域名，多个用英文逗号分隔。留空表示账号下全部域名。");

export const singleDomainField = z
  .string()
  .optional()
  .describe("加速域名。此接口仅支持单个域名，不支持逗号分隔的多域名。");

export const srvTypeField = z
  .string()
  .optional()
  .describe(
    `加速服务类型，多个用英文逗号分隔，可选值：${SRV_TYPE_VALUES.join(", ")}` +
      "（分别为海外加速/直播/点播/动态加速/静态加速/文件下载加速）。若已指定 domain，此参数被忽略。",
  );

export const protocolField = z
  .enum(["http", "https"])
  .optional()
  .describe("按传输协议过滤。");

export const isProtocolField = z
  .union([z.literal(0), z.literal(1)])
  .optional()
  .describe("是否按协议分组统计。0=不分组（默认），1=分组。");

export const isCombineField = z
  .union([z.literal(0), z.literal(1)])
  .optional()
  .describe(
    "是否合并统计。传 0 时按域名分组返回（data 变为 { 域名: [...] } 结构）；默认合并。",
  );

/** 时序类接口的完整公共参数（8 个）。适用于 bandwidth / flow / hit flow / request / hit request。 */
export const timeSeriesFields = {
  domain: multiDomainField,
  ...timeRangeFields,
  srv_type: srvTypeField,
  protocol: protocolField,
  is_protocol: isProtocolField,
  is_combine: isCombineField,
} as const;

/** 回源类与部分接口不支持 is_combine（7 个参数）。 */
export const timeSeriesFieldsNoCombine = {
  domain: multiDomainField,
  ...timeRangeFields,
  srv_type: srvTypeField,
  protocol: protocolField,
  is_protocol: isProtocolField,
} as const;

/** HTTP 状态码明细与汇总：无 is_combine，额外有 codes / code。 */
export const httpCodeFields = {
  ...timeSeriesFieldsNoCombine,
  codes: z
    .enum(["2xx", "3xx", "4xx", "5xx"])
    .optional()
    .describe("按状态码段聚合查询，例如 4xx。与 code 可配合使用。"),
  code: z
    .string()
    .regex(/^\d{3}$/, "须为三位数字状态码，如 200、404")
    .optional()
    .describe("查询具体状态码的明细，例如 200、302、404。"),
} as const;

/** 按域名聚合状态码总量：无 is_protocol / is_combine，额外有 state_group 与分页。 */
export const httpCodeDetailFields = {
  domain: multiDomainField,
  ...timeRangeFields,
  srv_type: srvTypeField,
  protocol: protocolField,
  state_group: z
    .enum(["2xx", "3xx", "4xx", "5xx"])
    .optional()
    .describe("状态码段筛选。留空则返回全部状态码的请求总量。"),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("分页每页条数。"),
  page: z.number().int().positive().optional().describe("分页页码，从 1 开始。"),
} as const;

/** Top Domains：只接受时间范围，本身即跨域名排行。 */
export const topDomainsFields = {
  ...timeRangeFields,
} as const;

/**
 * Top URL / Referer / UA 共用结构，差别只在 sorted 的取值前缀。
 * 注意 domain 只支持单个域名。
 */
export function buildTopResourceFields<const T extends readonly [string, string]>(
  sortedValues: T,
  sortedDefaultHint: string,
) {
  return {
    domain: singleDomainField,
    ...timeRangeFields,
    sorted: z
      .enum(sortedValues as unknown as [string, ...string[]])
      .optional()
      .describe(
        `排序依据：${sortedValues[0]} 按流量排序，${sortedValues[1]} 按请求数排序。默认 ${sortedDefaultHint}。`,
      ),
  } as const;
}
