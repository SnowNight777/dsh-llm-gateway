/**
 * dsh-llm-gateway — 把 DSH 当前 profile 已配置的全部 provider / model 以 OpenAI
 * 兼容接口暴露到本机回环，供任意本地程序（Python、Node、curl…）调用。
 *
 * 不绑定任何下游栈：模型目录从 llm 服务自动发现，请求里的 model 参与真实路由
 * （provider/model 或唯一的裸 model id）。
 */
import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import z from '@deepseek-ai/schemastery';

export const name = 'llm-gateway';

/**
 * 加载探针：把「模块被 import」「apply 进入」「端口已监听」「失败原因」逐条追写到
 * `~/.dsh/logs/llm-gateway-probe.log`。
 *
 * 存在的唯一理由：宿主日志不落盘、插件页只给一个「异常」，没有它就分不清
 * 「模块没被加载」与「apply 抛错」这两种完全不同的故障。探针自身失败一律吞掉，
 * 不影响插件行为；不需要时删掉本函数与其调用即可。
 *
 * @param stage - 阶段标记。
 * @param detail - 附加说明。
 */
function probe(stage, detail = '') {
  try {
    appendFileSync(join(homedir(), '.dsh', 'logs', 'llm-gateway-probe.log'), `${new Date().toISOString()}\t${stage}\t${detail}\n`);
  } catch {
    /* 探针失败不影响插件 */
  }
}

probe('module-imported', `pid=${process.pid}`);

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8790,
  /** 请求未带 model 时使用的路由；留空则必须显式指定。 */
  defaultModel: '',
  /** 非空则校验 Authorization: Bearer / x-api-key；回环部署可留空。 */
  apiKeys: [],
  /** 从目录中剔除的 provider id / model id / provider/model。 */
  excludeProviders: [],
  excludeModels: [],
  /** 模型目录缓存时长；未命中时会强制刷新一次。 */
  catalogTtlMs: 30_000,
  /** 上游只出 reasoning 不出 text 时，把 reasoning 兜底当 content 返回。 */
  reasoningAsContent: true,
  requestLog: true,
  maxBodyBytes: 8 * 1024 * 1024,
};

/**
 * Host Config schema。
 *
 * 声明它就是让本条目变成一个「被服务的 settings 命名空间」的唯一条件：DSH 把
 * 序列化后的 schema 交给浏览器校验草稿，并把有效值呈现为
 * 用户层 → 组合层 → 这里的默认值。所以**每个字段都必须带默认值** ——
 * 没有默认值的字段，会在任何省略它的 config 里被丢掉。
 *
 * 命名空间口径 = patchId（`llm-gateway`），不是 loader entryId
 * （`include:llm-gateway`）：dsh-settings 以 `entry.options.id` 建 ns。
 * 浏览器半侧 `lib/client.js` 按同一个键绑定表单。
 */

/**
 * 给字段打上 schemastery 的 `volatile` 标记。
 *
 * Config 表单生成器只服务带这个标记的字段：`dsh-settings` 的 `volatileForm()`
 * 把一个 volatile 字段都没有的条目整条丢掉（返回 undefined），该条目于是不进
 * namespaces —— 浏览器半侧的 `whileServed` 便永远等不到，配置区不出现。
 * 旧版 schemastery 没有 `volatile()`，这里按能力探测并原样返回。
 *
 * @param field - schemastery 字段。
 * @returns 打了标记的字段，或原字段。
 */
function volatileField(field) {
  const volatile = field.volatile;
  return typeof volatile === 'function' ? volatile.call(field) : field;
}

/**
 * 把 cordis 传入的 config 归一成普通对象。
 *
 * 带 `.volatile()` 的字段在 config 上不是值，而是一个 volatile accessor（`{ get() }`）——
 * 直接展开或读取会把它当值用（`server.listen({ get() }…)` → TypeError，插件 fiber 落进
 * failed，插件页显示「异常」）。官方 agent-loop 也是用 `config.maxParallelToolCalls.get()`
 * 这么读的，这里逐字段读取并对 accessor 取值。
 *
 * @param config - cordis 传入的 config，可能为 undefined。
 * @returns 合并了默认值的普通对象。
 */
function readConfig(config) {
  const cfg = { ...DEFAULTS };
  if (config === null || typeof config !== 'object') return cfg;
  for (const key of Object.keys(DEFAULTS)) {
    let value = config[key];
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') value = value.get();
    if (value !== undefined) cfg[key] = value;
  }
  return cfg;
}

export const Config = z.object({
  host: volatileField(z.string().default(DEFAULTS.host).description('监听地址。别改成 0.0.0.0，除非同时配置 apiKeys。')),
  port: volatileField(z.natural().default(DEFAULTS.port).description('监听端口。改动会重建 HTTP 服务。')),
  defaultModel: volatileField(
    z
      .string()
      .default(DEFAULTS.defaultModel)
      .description('请求未带 model 时使用的路由，形如 provider/model。留空则强制客户端显式指定。'),
  ),
  apiKeys: volatileField(z.array(z.string()).default([]).description('非空则校验 Authorization: Bearer 或 x-api-key。回环部署可留空。')),
  excludeProviders: volatileField(z.array(z.string()).default([]).description('从模型目录剔除的 provider id。')),
  excludeModels: volatileField(z.array(z.string()).default([]).description('从模型目录剔除的 model id 或 provider/model。')),
  catalogTtlMs: volatileField(z.natural().default(DEFAULTS.catalogTtlMs).description('模型目录缓存时长（毫秒）；未命中时会强制刷新一次。')),
  reasoningAsContent: volatileField(
    z
      .boolean()
      .default(DEFAULTS.reasoningAsContent)
      .description('上游只出 reasoning 不出 text 时，把 reasoning 兜底当 content 返回。'),
  ),
  requestLog: volatileField(z.boolean().default(DEFAULTS.requestLog).description('每个请求打一行「方法 路径 -> 状态 (耗时)」日志。')),
  maxBodyBytes: volatileField(z.natural().default(DEFAULTS.maxBodyBytes).description('请求体上限（字节）。')),
});

/**
 * DSH 的 llm 服务用对象下发结束原因（{kind:'stop'} / {kind:'max-tokens'} / …），
 * OpenAI 要求 finish_reason 是字符串，这里做映射，未知 kind 一律降级为 stop。
 */
const FINISH_REASON = { stop: 'stop', 'max-tokens': 'length', 'tool-calls': 'tool_calls' };

/**
 * 一次上游失败：DSH 既可能抛错，也可能以 finish/error/aborted 帧收尾。
 * 保留 `status` 与 `providerRetryAfterMs` —— 错误状态映射与 Retry-After 都要用它们。
 */
function failureFrom(reason) {
  if (typeof reason === 'string') return { message: reason, code: undefined };
  if (reason && typeof reason === 'object') {
    const f = reason.failure ?? {};
    const status = f.status ?? reason.status;
    const providerRetryAfterMs = f.providerRetryAfterMs ?? reason.providerRetryAfterMs;
    return {
      message: f.message ?? reason.message ?? `upstream ${reason.kind ?? 'error'}`,
      code: f.code ?? reason.code,
      ...(status === undefined ? {} : { status }),
      ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
    };
  }
  return { message: 'upstream error', code: undefined };
}

function kindOf(reason) {
  return typeof reason === 'string' ? reason : reason?.kind;
}

function isFailureChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  if (chunk.type === 'error' || chunk.type === 'aborted') return true;
  if (chunk.type === 'finish') {
    const kind = kindOf(chunk.reason);
    return kind === 'error' || kind === 'aborted';
  }
  return false;
}

function log(ctx, level, fmt, ...args) {
  const fn = ctx?.logger?.[level];
  if (typeof fn === 'function') fn.call(ctx.logger, '[llm-gateway] ' + fmt, ...args);
  else console.log('[llm-gateway] ' + fmt, ...args);
}

/** 本包在 profile 清单里的包名。 */
const PKG_NAME = 'dsh-llm-gateway';

/**
 * 读 profile 清单，判断本插件是不是被 profile 正式持有。
 *
 * `dependencies` 决定插件管理页里的 `installed`，也是启停、版本与配置表单的依托；
 * 只登记 `dsh.profile.bundles` 的「游离安装」会在插件页缺位，设置页也就没有这张表单。
 *
 * @param ctx - 插件上下文，可能携带 profileContext。
 * @returns 安装事实；候选目录都读不到清单时为 null。
 */
function detectInstallation(ctx) {
  const candidates = [];
  const fromEnv = process.env?.DSH_PROFILE_DIR;
  if (typeof fromEnv === 'string' && fromEnv) candidates.push(fromEnv);
  const fromCtx = ctx?.profileContext?.dir ?? ctx?.profile?.dir;
  if (typeof fromCtx === 'string' && fromCtx) candidates.push(fromCtx);
  for (const dir of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const spec = manifest?.dependencies?.[PKG_NAME];
      return {
        profileDir: dir,
        declared: typeof spec === 'string',
        spec: typeof spec === 'string' ? spec : null,
        bundled: Array.isArray(manifest?.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(PKG_NAME),
      };
    } catch {
      /* 换下一个候选目录 */
    }
  }
  return null;
}

/**
 * 读出本条目在 loader 里的身份，以及宿主实际服务的 settings 命名空间。
 *
 * 命名空间决定浏览器半侧 `whileServed` 能不能绑定表单 —— 口径在各版本间变过
 * （条目 id / patch id / 包名），所以这里直接问运行时，并原样落到 `/healthz` 上。
 *
 * @param ctx - 插件上下文。
 * @returns `{ entryId, settingsNamespaces, settingsNamespaceCount }`，读不到的项为 null。
 */
function describeEntry(ctx) {
  const out = { entryId: null, settingsNamespaces: null, settingsNamespaceCount: null };
  try {
    const id = ctx?.fiber?.entry?.id;
    if (typeof id === 'string' && id) out.entryId = id;
  } catch {
    /* 内部结构不可读 */
  }
  try {
    const described = ctx?.get?.('settings')?.describe?.();
    if (Array.isArray(described)) {
      const all = described.map((view) => view?.ns).filter((ns) => typeof ns === 'string');
      out.settingsNamespaceCount = all.length;
      out.settingsNamespaces = all.filter((ns) => /gateway/i.test(ns));
    }
  } catch {
    /* 没有 settings 服务 */
  }
  return out;
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, type = 'invalid_request_error', code, headers) {
  const body = JSON.stringify({ error: { message: String(message), type, ...(code ? { code } : {}) } });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(headers ?? {}),
  });
  res.end(body);
}

/**
 * DSH 的失败分类 → HTTP 状态。DSH 的 `code` 是稳定契约，按它路由，绝不解析消息文本。
 * 未列出的 code 或未知失败一律 502。
 */
const FAILURE_STATUS = {
  AUTH: 401,
  MISSING_CREDENTIAL: 401,
  INVALID_CREDENTIAL: 401,
  RATE_LIMIT: 429,
  QUOTA: 429,
  ACCOUNT_QUOTA: 402,
  CONTEXT_WINDOW_EXCEEDED: 400,
  IMAGE_OFFLOAD_REQUIRED: 400,
  UNSUPPORTED_REASONING_EFFORT: 400,
  INVALID_REQUEST: 400,
  INVALID_ARGS: 400,
  NO_ADAPTER: 404,
};

/** 上游失败对应的 HTTP 状态：供应商自报的 status 优先，其次按 DSH code 归类。 */
function upstreamStatus(failure) {
  const status = failure?.status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  return FAILURE_STATUS[failure?.code] ?? 502;
}

/** OpenAI 风格的 error.type，按状态归类。 */
function errorTypeFor(status) {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'upstream_error';
  return 'invalid_request_error';
}

/** 上游给了 Retry-After 就把它转成响应头，客户端据此退避。 */
function retryAfterHeader(failure) {
  const ms = failure?.providerRetryAfterMs;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return { 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))) };
}

/**
 * DSH 的 TokenUsage → OpenAI 的 usage。
 *
 * DSH 给六个字段（inputTokens / outputTokens / totalTokens / cacheReadTokens /
 * cacheWriteTokens / reasoningTokens），比 OpenAI 顶层那三个多出缓存与推理用量。
 * 多出来的不丢：缓存读进 prompt_tokens_details.cached_tokens，推理进
 * completion_tokens_details.reasoning_tokens。cacheWriteTokens 在 OpenAI 口径里
 * 没有对应字段，宁可给个非标准的 cache_write_tokens，也别把上游的账丢一半。
 */
function usagePayload(usage) {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const out = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number.isFinite(usage?.totalTokens) ? usage.totalTokens : input + output,
  };
  const promptDetails = {};
  if (Number.isFinite(usage?.cacheReadTokens)) promptDetails.cached_tokens = usage.cacheReadTokens;
  if (Number.isFinite(usage?.cacheWriteTokens)) promptDetails.cache_write_tokens = usage.cacheWriteTokens;
  if (Object.keys(promptDetails).length) out.prompt_tokens_details = promptDetails;
  if (Number.isFinite(usage?.reasoningTokens)) out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  return out;
}

/** 这些键有真实去向，放行（校验交给 DSH）。 */
const FORWARDED_PARAMS = new Set([
  'model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens',
  'temperature', 'stop', 'tools', 'reasoning_effort',
]);
/**
 * 这些键对结果没有影响，放行。
 * `n=1` 和 `stream_options` 几乎每个 SDK 都会默认带上，一律拒绝等于自断门路；
 * `user` 只做标识用，网关不追踪也不影响生成。
 */
const BENIGN_PARAMS = new Set(['stream_options', 'user']);

/**
 * 拦下网关没有去路的参数。
 *
 * DSH 的 LlmCallConfig 只有 provider / model / reasoningEffort / temperature /
 * maxTokens / stop 六项，其余采样参数没有去处。以前是静默忽略 —— 客户端以为
 * 生效了，结果不对还查不出来。现在直接 400 说清楚。
 *
 * @throws 带 code='unsupported_parameter'，调用处转 400。
 */
function assertSupportedParams(body) {
  for (const key of Object.keys(body)) {
    if (FORWARDED_PARAMS.has(key) || BENIGN_PARAMS.has(key)) continue;
    // OpenAI 把 max_tokens 改名成 max_completion_tokens，两个都收，上面已放行。
    if (key === 'n' && body[key] === 1) continue;
    // tool_choice 只有"自动"这一档等于不表态；其它档位网关无法表达。
    if (key === 'tool_choice') {
      if (body[key] === undefined || body[key] === null || body[key] === 'auto') continue;
      throw Object.assign(new Error('unsupported parameter "tool_choice": only "auto" is supported'), { code: 'unsupported_parameter' });
    }
    throw Object.assign(new Error(`unsupported parameter "${key}": this gateway forwards only the parameters DSH's call config carries`), { code: 'unsupported_parameter' });
  }
}

/** 定长比较，避免把 key 长度/前缀差异变成计时旁路。 */
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function authorized(req, cfg) {
  if (!cfg.apiKeys.length) return true;
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : req.headers['x-api-key'];
  return typeof token === 'string' && cfg.apiKeys.some((key) => safeEqual(key, token));
}

/**
 * 把 OpenAI 的 messages 折成 DSH 的形状：system/developer 合并成 options.system，
 * 其余映射为 [{role, content:[{type:'text', text}]}]。
 * @throws 遇到图片/音频等非文本 part 时抛出，避免静默丢内容。
 */
/** 把一条消息的 content 折成纯文本；图片/音频等非文本 part 一律抛错，不静默丢内容。 */
function textOfContent(content) {
  let text = '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    if (part?.type === 'text' || part?.type === 'input_text') {
      text += part.text ?? '';
      continue;
    }
    if (part?.type !== undefined) {
      throw new Error(`unsupported content part "${part.type}": this gateway is text-only`);
    }
  }
  return text;
}

/**
 * OpenAI 的 tools[] → DSH 的 ToolSchema[]。
 *
 * 只认 `{type:'function', …}`（也容忍裸的 function 对象）。碰到别的 tool 类型**抛错**
 * 而不是跳过：静默丢弃工具定义会让客户端以为工具在用，比直接报错危险得多。
 */
function toDshTools(tools) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const type = tool?.type;
    if (type !== undefined && type !== 'function') {
      throw new Error(`unsupported tool type "${type}": only "function" tools are supported`);
    }
    const fn = type === 'function' ? tool.function : tool;
    const name = fn?.name;
    if (typeof name !== 'string' || !name) continue;
    const parameters = fn?.parameters;
    out.push({
      name,
      description: typeof fn?.description === 'string' ? fn.description : '',
      parameters: parameters && typeof parameters === 'object' ? parameters : { type: 'object', properties: {} },
    });
  }
  return out;
}

/**
 * OpenAI 的 image_url part → DSH 的 image 块。
 *
 * 图片必须先落进 attachments 服务、拿到 ImageAttachmentRef，才能构成 DSH 的图片块
 * —— 那是 DSH 接受图片的唯一形态。data URL 直接解码；http(s) URL 由网关代下载转
 * 成字节（DSH 只认字节，不认远端地址）。
 *
 * attachments 只接受 canonical base64，所以这里统一走 saveImages 提交原始字节，
 * 不把客户端带来的填充/换行差异带进去。
 */
async function imagePartToDsh(part, attachments) {
  if (!attachments?.saveImages) {
    throw Object.assign(new Error('image input requires the DSH attachments service, which is not mounted'), { code: 'attachments_unavailable' });
  }
  const raw = part?.image_url;
  const url = typeof raw === 'string' ? raw : raw?.url;
  if (typeof url !== 'string' || !url) {
    throw Object.assign(new Error('image_url part requires a "url"'), { code: 'invalid_image' });
  }

  let mediaType;
  let bytes;
  if (url.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
    if (!match) {
      throw Object.assign(new Error('image_url data URL must be base64-encoded (data:<type>;base64,<payload>)'), { code: 'invalid_image' });
    }
    mediaType = match[1].trim();
    bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  } else if (/^https?:\/\//i.test(url)) {
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw Object.assign(new Error(`failed to download image_url: ${String(error?.message ?? error)}`), { code: 'image_fetch_failed' });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`failed to download image_url: HTTP ${response.status}`), { code: 'image_fetch_failed' });
    }
    mediaType = (response.headers.get('content-type') ?? 'image/png').split(';')[0].trim();
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    throw Object.assign(new Error('image_url must be a data: or http(s): URL'), { code: 'invalid_image' });
  }

  if (!bytes.length) throw Object.assign(new Error('image_url decoded to zero bytes'), { code: 'invalid_image' });
  const [ref] = await attachments.saveImages([{ data: Uint8Array.from(bytes), mediaType }]);
  return { type: 'image', attachment: ref };
}

/**
 * 把 OpenAI 的 messages 折成 DSH 的形状。
 *
 * - `system` / `developer` 合并进 options.system
 * - assistant 带 `tool_calls` 时折进同一条消息的 content（tool-call 块），
 *   使多轮工具对话的历史形状与 DSH 一致
 * - `role:'tool'` 变成 DSH 的 ToolResultMessage（带 `source` 与 `toolCallId`）
 * - 既无文本也无工具调用的空消息**直接跳过**：旧实现会给它塞一个空 text 块，
 *   上游收到空块会抛 `reading 'replayState'` 并以 502 收场
 *
 * @throws 遇到图片/音频等非文本 part、或 tool 回执缺 tool_call_id 时抛出。
 */
/**
 * 把一条消息的 content 折成 DSH 的块数组：文本进 text 块，图片落进 attachments。
 * 文本与图片交错时保持原有顺序。
 */
async function blocksOfContent(content, attachments) {
  let blocks = [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    const type = part?.type;
    if (type === 'text' || type === 'input_text') {
      text += part.text ?? '';
      continue;
    }
    if (type === 'image_url' || type === 'input_image') {
      if (text) {
        blocks.push({ type: 'text', text });
        text = '';
      }
      blocks.push(await imagePartToDsh(part, attachments));
      continue;
    }
    if (type !== undefined) {
      throw Object.assign(new Error(`unsupported content part "${type}": text and image_url are supported`), { code: 'unsupported_content' });
    }
  }
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

async function toDshMessages(messages, route, attachments) {
  const system = [];
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;

    if (role === 'tool') {
      const callId = message?.tool_call_id;
      if (typeof callId !== 'string' || !callId) {
        throw Object.assign(new Error('a "tool" message requires a non-empty tool_call_id'), { code: 'invalid_tool_message' });
      }
      out.push({
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: textOfContent(message?.content) }],
        ...(message?.is_error === true ? { isError: true } : {}),
      });
      continue;
    }

    if (role === 'system' || role === 'developer') {
      const text = textOfContent(message?.content);
      if (text) system.push(text);
      continue;
    }

    const blocks = await blocksOfContent(message?.content, attachments);

    // reasoning 回传：DeepSeek 系 thinking 模型要求把上一轮的 thinking 一并送回，
    // 否则多轮工具对话会被上游拒绝（400 "content[].thinking ... must be passed back"）。
    // OpenAI 生态里这个字段叫 reasoning_content，也兼容简写 reasoning。
    const reasoning = message?.reasoning_content ?? message?.reasoning;
    if (typeof reasoning === 'string' && reasoning) {
      blocks.unshift({ type: 'reasoning', text: reasoning });
    }

    if (role === 'assistant' && Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = call?.function;
        const id = call?.id;
        if (typeof id !== 'string' || !id || typeof fn?.name !== 'string' || !fn.name) continue;
        blocks.push({
          type: 'tool-call',
          id,
          name: fn.name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
    }

    if (!blocks.length) continue;
    if (role === 'assistant') {
      // DSH 要求每条 assistant 消息都带 source：llm.forAdapter() 会读
      // `message.source.replayState`，缺了 source 会抛 "Cannot read properties of
      // undefined (reading 'replayState')" 并以 502 收场。provider/model 如实填当前
      // 路由，replayState 留空 —— 历史消息不该复用别的 adapter 的重放态。
      out.push({
        role: 'assistant',
        content: blocks,
        source: { kind: 'model', provider: route?.provider, model: route?.model },
      });
      continue;
    }
    out.push({ role: 'user', content: blocks });
  }
  return { system: system.join('\n\n'), messages: out };
}

/**
 * 模型目录：从 llm 服务枚举 provider × model，供 /v1/models 与请求路由共用。
 * 规范 id 是 provider/model；当某个裸 model id 只属于一个 provider 时，它同时可用。
 */
function createCatalog(ctx, cfg) {
  let cache = { at: 0, routes: new Map(), bare: new Map(), list: [] };

  const build = async () => {
    const llm = ctx.get('llm');
    if (!llm?.listProviders) throw new Error('DSH llm service unavailable');
    const routes = new Map();
    const bare = new Map();
    const list = [];
    let providers = 0;
    for (const provider of llm.listProviders()) {
      const pid = provider?.id;
      if (typeof pid !== 'string' || cfg.excludeProviders.includes(pid)) continue;
      let models = [];
      try {
        models = await llm.listModels(pid);
      } catch (error) {
        log(ctx, 'warn', 'provider %s: listModels failed (%s)', pid, String(error?.message ?? error));
        continue;
      }
      providers += 1;
      for (const model of models) {
        const mid = model?.id;
        if (typeof mid !== 'string') continue;
        if (cfg.excludeModels.includes(mid) || cfg.excludeModels.includes(`${pid}/${mid}`)) continue;
        const entry = {
          id: `${pid}/${mid}`,
          provider: pid,
          model: mid,
          name: model.name ?? mid,
          providerName: provider.name ?? pid,
          // listModels 只给得到这几个能力字段；吃不吃图片就看 inputModalities 里有没有 'image'。
          ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities } : {}),
          ...(typeof model.description === 'string' && model.description ? { description: model.description } : {}),
        };
        routes.set(entry.id, entry);
        list.push(entry);
        if (!bare.has(mid)) bare.set(mid, new Set());
        bare.get(mid).add(pid);
      }
    }
    for (const [mid, owners] of bare) {
      if (owners.size !== 1) continue;
      const owner = [...owners][0];
      const canonical = routes.get(`${owner}/${mid}`);
      if (canonical) list.push({ ...canonical, id: mid, alias: true });
    }
    cache = { at: Date.now(), routes, bare, list, providers };
    return cache;
  };

  /**
   * 空目录的重试间隔。
   *
   * DSH 启动早期，模型提供方适配器可能还没注册完 —— 这时 build() 会拿到一个
   * 空目录。若把它按 catalogTtlMs 缓存住，重启后的头几十秒里 /v1/models 会
   * 返回空列表，直到 TTL 到期或某个未命中的请求触发强制重建。所以空目录不
   * 算有效快照，只撑这个短间隔，让它在适配器就绪后立刻自愈。
   */
  const EMPTY_RETRY_MS = 1_000;

  const ensure = async (force = false) => {
    const age = Date.now() - cache.at;
    const ttl = cache.routes.size === 0 ? EMPTY_RETRY_MS : cfg.catalogTtlMs;
    if (force || age > ttl) await build();
    return cache;
  };

  /** @returns 命中的路由，或抛出带 status/code 的路由错误。 */
  const resolve = async (id) => {
    const lookup = async () => {
      if (cache.routes.has(id)) return cache.routes.get(id);
      const owners = cache.bare.get(id);
      if (owners?.size === 1) return cache.routes.get(`${[...owners][0]}/${id}`);
      if (owners?.size > 1) {
        const error = new Error(`model "${id}" is ambiguous across providers: ${[...owners].join(', ')} — use "provider/model"`);
        error.status = 400;
        error.code = 'ambiguous_model';
        throw error;
      }
      return undefined;
    };
    await ensure();
    let hit = await lookup();
    if (!hit) {
      await ensure(true);
      hit = await lookup();
    }
    if (!hit) {
      const error = new Error(`unknown model "${id}" — GET /v1/models for the catalog`);
      error.status = 404;
      error.code = 'model_not_found';
      throw error;
    }
    return hit;
  };

  return { ensure, resolve, peek: () => cache };
}

export function apply(ctx, config = {}) {
  probe('apply-enter', `port=${readConfig(config).port}`);
  try {
    return applyInner(ctx, config);
  } catch (error) {
    probe('apply-threw', `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`);
    throw error;
  }
}

function applyInner(ctx, config) {
  const cfg = readConfig(config);
  const catalog = createCatalog(ctx, cfg);
  const installation = detectInstallation(ctx);
  const entry = describeEntry(ctx);
  probe('entry', `entryId=${entry.entryId} ns=${JSON.stringify(entry.settingsNamespaces)} count=${entry.settingsNamespaceCount} declared=${installation?.declared}`);

  if (installation !== null && !installation.declared) {
    log(
      ctx,
      'warn',
      '游离安装：profile 的 package.json 没把 %s 列为依赖（只登记在 dsh.profile.bundles）——DSH 插件页看不到本插件，设置页也不会有配置表单。请按 README「安装」一节改用 profile 依赖安装。',
      PKG_NAME,
    );
  }

  log(ctx, 'info', 'starting gateway on %s:%d (defaultModel=%s auth=%s)', cfg.host, cfg.port, cfg.defaultModel || '<none>', cfg.apiKeys.length ? 'on' : 'off');

  const chat = async (req, res) => {
    const llm = ctx.get?.('llm');
    if (!llm?.stream) return sendError(res, 503, 'DSH llm service unavailable', 'service_unavailable');

    let body;
    try {
      body = await readJson(req, cfg.maxBodyBytes);
    } catch (error) {
      return sendError(res, 400, error.message, 'invalid_request_error');
    }

    const requested = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : cfg.defaultModel;
    if (!requested) return sendError(res, 400, 'model is required (no defaultModel configured)', 'invalid_request_error', 'model_required');

    let route;
    try {
      route = await catalog.resolve(requested);
    } catch (error) {
      return sendError(res, error.status ?? 500, error.message, error.status === 404 ? 'model_not_found' : 'invalid_request_error', error.code);
    }

    try {
      assertSupportedParams(body);
    } catch (error) {
      return sendError(res, 400, error.message, 'invalid_request_error', error.code ?? 'unsupported_parameter');
    }

    let parsed;
    try {
      parsed = await toDshMessages(body.messages, route, ctx.get('attachments'));
    } catch (error) {
      const code = error?.code ?? 'invalid_request_error';
      const status = code === 'attachments_unavailable' ? 501 : 400;
      const type = code === 'unsupported_content' || code === 'invalid_image' || code === 'image_fetch_failed'
        ? 'unsupported_content'
        : 'invalid_request_error';
      return sendError(res, status, error.message, type, code);
    }
    if (!parsed.messages.length) return sendError(res, 400, 'messages is required', 'invalid_request_error', 'messages_required');

    let tools;
    if (body.tools !== undefined) {
      try {
        tools = toDshTools(body.tools);
      } catch (error) {
        return sendError(res, 400, error.message, 'invalid_request_error', 'unsupported_tool');
      }
    }

    const options = { provider: route.provider, model: route.model, messages: parsed.messages };
    if (parsed.system) options.system = parsed.system;
    // max_tokens 是旧名，max_completion_tokens 是新名，两个都收；上限对齐 DSH 的校验。
    const maxTokens = Number.isFinite(body.max_tokens) ? body.max_tokens : body.max_completion_tokens;
    if (Number.isFinite(maxTokens)) options.maxTokens = Math.max(1, Math.min(200_000, Math.floor(maxTokens)));
    if (Number.isFinite(body.temperature)) options.temperature = body.temperature;
    if (Array.isArray(body.stop) && body.stop.length) options.stop = body.stop.slice(0, 4).map(String);
    if (tools?.length) options.tools = tools;
    // reasoning_effort 原样透传：可用档位由模型自己声明（reasoning.efforts[].id），
    // 不支持的档位由 DSH 抛 UNSUPPORTED_REASONING_EFFORT —— 该码已映到 400。
    if (typeof body.reasoning_effort === 'string') options.reasoningEffort = body.reasoning_effort;

    const id = 'chatcmpl-' + randomUUID();
    const created = Math.floor(Date.now() / 1000);
    const model = route.id;
    const streaming = body.stream === true;
    const abort = new AbortController();
    options.signal = abort.signal;
    req.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    let text = '';
    let reasoning = '';
    let usage;
    let finishReason = 'stop';
    let failure;
    /** 累积的工具调用：index → { id, name, arguments }。 */
    const toolCalls = new Map();

    const consumeChunk = (chunk, onDelta) => {
      if (!chunk || typeof chunk !== 'object') return;
      switch (chunk.type) {
        case 'text-delta':
          if (chunk.text) {
            text += chunk.text;
            onDelta({ content: chunk.text });
          }
          return;
        case 'reasoning-delta':
          if (chunk.text) {
            reasoning += chunk.text;
            onDelta({ reasoning_content: chunk.text });
          }
          return;
        case 'tool-call-delta': {
          const index = Number.isInteger(chunk.index) ? chunk.index : 0;
          const isNew = !toolCalls.has(index);
          const acc = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
          if (isNew) toolCalls.set(index, acc);
          if (typeof chunk.id === 'string' && chunk.id) acc.id = chunk.id;
          if (typeof chunk.name === 'string' && chunk.name) acc.name = chunk.name;
          const delta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : '';
          acc.arguments += delta;
          // OpenAI 的约定：首个分片带 id / type / function.name，其后的分片只带 arguments。
          onDelta({
            tool_calls: [
              {
                index,
                ...(isNew ? { id: acc.id, type: 'function' } : {}),
                function: { ...(isNew ? { name: acc.name } : {}), arguments: delta },
              },
            ],
          });
          return;
        }
        case 'usage':
          if (chunk.usage) usage = chunk.usage;
          return;
        case 'finish': {
          const kind = kindOf(chunk.reason);
          if (kind === 'error' || kind === 'aborted') failure = failureFrom(chunk.reason);
          else finishReason = FINISH_REASON[kind] ?? 'stop';
          return;
        }
        case 'error':
        case 'aborted':
          failure = failureFrom(chunk.reason ?? chunk.failure ?? chunk.type);
          return;
        default:
          return;
      }
    };

    const iterator = llm.stream(options)[Symbol.asyncIterator]();
    const closeIterator = () => {
      try {
        iterator.return?.();
      } catch {
        /* 迭代器已结束 */
      }
    };
    /** 迭代器已被第一帧探针推进过一次，这里从第二帧起继续消费。 */
    const drain = async (onDelta) => {
      for (;;) {
        const step = await iterator.next();
        if (step.done) return;
        consumeChunk(step.value, onDelta);
      }
    };

    // 先探第一帧：上游在开流前就失败时，仍然能回一个真正的错误状态，
    // 而不是先写 200 再把错误塞进 SSE 里。状态按 DSH 的稳定 code 映射，
    // 客户端才能分别处理 401 / 429 / 400 —— 而不是把它们一律当成 502。
    let first;
    try {
      first = await iterator.next();
    } catch (error) {
      closeIterator();
      const early = failureFrom(error);
      const status = upstreamStatus(early);
      return sendError(res, status, error.message, errorTypeFor(status), early.code, retryAfterHeader(early));
    }
    if (!first.done && isFailureChunk(first.value)) {
      closeIterator();
      const early = failureFrom(first.value.reason ?? first.value.failure ?? first.value.type);
      const status = upstreamStatus(early);
      return sendError(res, status, early.message, errorTypeFor(status), early.code, retryAfterHeader(early));
    }

    if (!streaming) {
      try {
        if (!first.done) {
          consumeChunk(first.value, () => {});
          await drain(() => {});
        }
      } catch (error) {
        failure = failure ?? { message: error.message, code: undefined };
      }
      closeIterator();
      if (failure) {
        const status = upstreamStatus(failure);
        return sendError(res, status, failure.message, errorTypeFor(status), failure.code, retryAfterHeader(failure));
      }
      if (!text && reasoning && cfg.reasoningAsContent) text = reasoning;
      const calls = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => call)
        .filter((call) => call.name);
      return sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              // 有工具调用时 content 必须是 null —— OpenAI 的约定。
              content: calls.length ? null : text,
              // thinking 模型的思考过程要能被客户端拿回去再传上来，否则多轮工具
              // 对话会被上游拒绝。deepseek 系在流式里叫 reasoning_content，这里对齐。
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(calls.length
                ? {
                    tool_calls: calls.map((call, i) => ({
                      id: call.id || `call_${i}`,
                      type: 'function',
                      function: { name: call.name, arguments: call.arguments || '{}' },
                    })),
                  }
                : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: usagePayload(usage),
      });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const emit = (delta, finish = null) => {
      res.write(
        'data: ' +
          JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] }) +
          '\n\n',
      );
    };

    emit({ role: 'assistant', content: '' });
    try {
      if (!first.done) {
        consumeChunk(first.value, (delta) => emit(delta));
        await drain((delta) => emit(delta));
      }
    } catch (error) {
      failure = failure ?? { message: error.message, code: undefined };
    }
    closeIterator();

    if (failure) {
      // 响应头已经发出，改不回状态码；按 OpenAI 的做法把错误作为数据帧下发。
      // type 仍按映射后的状态归类，客户端可以据此判断该不该重试。
      const status = upstreamStatus(failure);
      res.write(
        'data: ' +
          JSON.stringify({
            error: { message: failure.message, type: errorTypeFor(status), ...(failure.code ? { code: failure.code } : {}) },
          }) +
          '\n\n',
      );
    } else {
      if (!text && reasoning && cfg.reasoningAsContent) emit({ content: reasoning });
      emit({}, finishReason);
      if (usage) {
        res.write(
          'data: ' +
            JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [],
              usage: usagePayload(usage),
            }) +
            '\n\n',
        );
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const models = async (res) => {
    try {
      const current = await catalog.ensure();
      const created = Math.floor(current.at / 1000);
      sendJson(res, 200, {
        object: 'list',
        data: current.list.map((entry) => ({
          id: entry.id,
          object: 'model',
          created,
          owned_by: entry.provider,
          // OpenAI 的 /v1/models 没有标准的能力字段，按社区惯例补上：
          // 客户端据此判断这个模型能不能吃图片、以及某条是不是别名。
          ...(Array.isArray(entry.inputModalities) ? { input_modalities: entry.inputModalities } : {}),
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
          ...(entry.alias === true ? { alias: true } : {}),
        })),
      });
    } catch (error) {
      sendError(res, 503, error.message, 'service_unavailable');
    }
  };

  const health = async (res) => {
    try {
      const current = await catalog.ensure();
      sendJson(res, 200, {
        ok: true,
        gateway: { host: cfg.host, port: cfg.port, auth: cfg.apiKeys.length > 0, defaultModel: cfg.defaultModel || null },
        catalog: { providers: current.providers, models: current.routes.size, aliases: current.list.length - current.routes.size, ageMs: Date.now() - current.at },
        installation:
          installation === null
            ? null
            : { declared: installation.declared, spec: installation.spec, bundled: installation.bundled },
        entry,
      });
    } catch (error) {
      sendError(res, 503, error.message, 'service_unavailable');
    }
  };

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = (req.url || '').split('?')[0];
    const logRequest = () => {
      if (cfg.requestLog) log(ctx, 'info', '%s %s -> %d (%dms)', req.method, url, res.statusCode, Date.now() - started);
    };
    res.on('finish', logRequest);

    const handle = async () => {
      if (!authorized(req, cfg)) return sendError(res, 401, 'invalid api key', 'authentication_error', 'invalid_api_key');
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) return models(res);
      if (req.method === 'GET' && (url === '/healthz' || url === '/v1/healthz')) return health(res);
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) return chat(req, res);
      if (url === '/v1/chat/completions' || url === '/v1/models') return sendError(res, 405, `method ${req.method} not allowed`, 'invalid_request_error', 'method_not_allowed');
      return sendError(res, 404, `no such route: ${req.method} ${url}`, 'invalid_request_error', 'not_found');
    };
    handle().catch((error) => {
      try {
        if (!res.headersSent) sendError(res, 500, error?.message ?? 'internal error');
        else res.end();
      } catch {
        /* 响应已断开 */
      }
    });
  });

  server.on('error', (error) => {
    probe('server-error', String(error?.message ?? error));
    log(ctx, 'warn', 'http server error: %s', String(error?.message ?? error));
  });
  server.listen(cfg.port, cfg.host, () => {
    probe('listening', `${cfg.host}:${cfg.port}`);
    log(ctx, 'info', 'gateway listening on http://%s:%d/v1', cfg.host, cfg.port);
  });
  ctx.effect(() => () => {
    try {
      // 配置热更会重建本插件：先掐断 keep-alive 连接再关监听，
      // 否则改端口后旧服务会一直挂着不释放。
      server.closeAllConnections?.();
      server.close();
    } catch {
      /* 已关闭 */
    }
  }, 'dsh-llm-gateway: http server');

  catalog
    .ensure()
    .then((current) => {
      // 空目录说明 llm 适配器还没注册完。这不是错误，但也不能说 ready ——
      // 目录会在适配器就绪后按 EMPTY_RETRY_MS 自愈。
      if (current.providers === 0) {
        log(ctx, 'warn', 'catalog warm-up found no providers yet (adapters may still be registering) — will retry on demand');
        return;
      }
      log(ctx, 'info', 'catalog ready: %d providers, %d models (%d aliases)', current.providers, current.routes.size, current.list.length - current.routes.size);
    })
    .catch((error) => {
      probe('catalog-warmup-failed', String(error?.message ?? error));
      log(ctx, 'warn', 'catalog warm-up failed: %s', String(error?.message ?? error));
    });

  log(ctx, 'info', 'ready — OpenAI 客户端把 base_url 指到 http://%s:%d/v1', cfg.host, cfg.port);
}
