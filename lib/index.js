/**
 * dsh-llm-gateway — 把 DSH 当前 profile 已配置的全部 provider / model 以 OpenAI
 * 兼容接口暴露到本机回环，供任意本地程序（Python、Node、curl…）调用。
 *
 * 不绑定任何下游栈：模型目录从 llm 服务自动发现，请求里的 model 参与真实路由
 * （provider/model 或唯一的裸 model id）。
 */
import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import z from '@deepseek-ai/schemastery';

export const name = 'llm-gateway';

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
export const Config = z.object({
  host: z.string().default(DEFAULTS.host).description('监听地址。别改成 0.0.0.0，除非同时配置 apiKeys。'),
  port: z.natural().default(DEFAULTS.port).description('监听端口。改动会重建 HTTP 服务。'),
  defaultModel: z
    .string()
    .default(DEFAULTS.defaultModel)
    .description('请求未带 model 时使用的路由，形如 provider/model。留空则强制客户端显式指定。'),
  apiKeys: z.array(z.string()).default([]).description('非空则校验 Authorization: Bearer 或 x-api-key。回环部署可留空。'),
  excludeProviders: z.array(z.string()).default([]).description('从模型目录剔除的 provider id。'),
  excludeModels: z.array(z.string()).default([]).description('从模型目录剔除的 model id 或 provider/model。'),
  catalogTtlMs: z.natural().default(DEFAULTS.catalogTtlMs).description('模型目录缓存时长（毫秒）；未命中时会强制刷新一次。'),
  reasoningAsContent: z
    .boolean()
    .default(DEFAULTS.reasoningAsContent)
    .description('上游只出 reasoning 不出 text 时，把 reasoning 兜底当 content 返回。'),
  requestLog: z.boolean().default(DEFAULTS.requestLog).description('每个请求打一行「方法 路径 -> 状态 (耗时)」日志。'),
  maxBodyBytes: z.natural().default(DEFAULTS.maxBodyBytes).description('请求体上限（字节）。'),
});

/**
 * DSH 的 llm 服务用对象下发结束原因（{kind:'stop'} / {kind:'max-tokens'} / …），
 * OpenAI 要求 finish_reason 是字符串，这里做映射，未知 kind 一律降级为 stop。
 */
const FINISH_REASON = { stop: 'stop', 'max-tokens': 'length', 'tool-calls': 'tool_calls' };

/** 一次上游失败：DSH 既可能抛错，也可能以 finish/error/aborted 帧收尾。 */
function failureFrom(reason) {
  if (typeof reason === 'string') return { message: reason, code: undefined };
  if (reason && typeof reason === 'object') {
    const f = reason.failure ?? {};
    return {
      message: f.message ?? reason.message ?? `upstream ${reason.kind ?? 'error'}`,
      code: f.code ?? reason.code,
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

function sendError(res, status, message, type = 'invalid_request_error', code) {
  sendJson(res, status, {
    error: { message: String(message), type, ...(code ? { code } : {}) },
  });
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
function toDshMessages(messages) {
  const system = [];
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;
    const content = message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
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
          throw new Error(`unsupported content part "${part.type}": this gateway is text-only in 0.1.0`);
        }
      }
    }
    if (role === 'system' || role === 'developer') {
      if (text) system.push(text);
      continue;
    }
    out.push({ role: role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text }] });
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
  const cfg = { ...DEFAULTS, ...config };
  const catalog = createCatalog(ctx, cfg);

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

    let parsed;
    try {
      parsed = toDshMessages(body.messages);
    } catch (error) {
      return sendError(res, 400, error.message, 'unsupported_content', 'unsupported_content');
    }
    if (!parsed.messages.length) return sendError(res, 400, 'messages is required', 'invalid_request_error', 'messages_required');

    const options = { provider: route.provider, model: route.model, messages: parsed.messages };
    if (parsed.system) options.system = parsed.system;
    if (Number.isFinite(body.max_tokens)) options.maxTokens = Math.max(1, Math.min(200_000, Math.floor(body.max_tokens)));
    if (Number.isFinite(body.temperature)) options.temperature = body.temperature;
    if (Array.isArray(body.stop) && body.stop.length) options.stop = body.stop.slice(0, 4).map(String);

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

    // 先探第一帧：上游在开流前就失败时，仍然能回一个真正的 502，
    // 而不是先写 200 再把错误塞进 SSE 里。
    let first;
    try {
      first = await iterator.next();
    } catch (error) {
      closeIterator();
      return sendError(res, 502, error.message, 'upstream_error');
    }
    if (!first.done && isFailureChunk(first.value)) {
      closeIterator();
      const early = failureFrom(first.value.reason ?? first.value.failure ?? first.value.type);
      return sendError(res, 502, early.message, 'upstream_error', early.code);
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
      if (failure) return sendError(res, 502, failure.message, 'upstream_error', failure.code);
      if (!text && reasoning && cfg.reasoningAsContent) text = reasoning;
      return sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
        usage: {
          prompt_tokens: usage?.inputTokens ?? 0,
          completion_tokens: usage?.outputTokens ?? 0,
          total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
        },
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
      // 头已经发出，改不回 502；按 OpenAI 的做法把错误作为数据帧下发。
      res.write('data: ' + JSON.stringify({ error: { message: failure.message, type: 'upstream_error', ...(failure.code ? { code: failure.code } : {}) } }) + '\n\n');
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
              usage: {
                prompt_tokens: usage.inputTokens ?? 0,
                completion_tokens: usage.outputTokens ?? 0,
                total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
              },
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
        data: current.list.map((entry) => ({ id: entry.id, object: 'model', created, owned_by: entry.provider })),
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

  server.on('error', (error) => log(ctx, 'warn', 'http server error: %s', String(error?.message ?? error)));
  server.listen(cfg.port, cfg.host, () => log(ctx, 'info', 'gateway listening on http://%s:%d/v1', cfg.host, cfg.port));
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
    .catch((error) => log(ctx, 'warn', 'catalog warm-up failed: %s', String(error?.message ?? error)));

  log(ctx, 'info', 'ready — OpenAI 客户端把 base_url 指到 http://%s:%d/v1', cfg.host, cfg.port);
}
