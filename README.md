# dsh-llm-gateway

把 DSH 已配置的模型共享给本机程序——无需重复配置，用 **OpenAI 兼容接口**直接调用。

Python、Node、curl、Notebook 都能直接用，不需要额外的 SDK 适配层；模型目录从你的 DSH 配置里自动发现。

## 特性

- **OpenAI 兼容**：`/v1/models`、`/v1/chat/completions`（流式与非流式）、`/healthz`
- **真实路由**：模型目录从 DSH 的 `llm` 服务自动发现；请求里的 `model` 决定实际调哪个 provider，不是被忽略后照常回答
- **工具调用**：`tools` 完整转发，`tool_calls` 按 OpenAI 约定分片返回；`role:'tool'` 回执与 `assistant.tool_calls` 历史都能正确落回 DSH 的消息形状
- **图片输入**：`image_url` 支持 data URL 与 http(s) 链接，图片经 DSH 的 attachments 服务落盘后交给模型；`/v1/models` 里 `input_modalities` 含 `image` 的模型可直接用
- **thinking 双向**：非流式响应带 `reasoning_content`，请求也可回传它——DeepSeek 系 thinking 模型的多轮工具对话靠这个才续得上
- **usage 带明细**：除三个基本数字外，还给出 `prompt_tokens_details.cached_tokens` 与 `completion_tokens_details.reasoning_tokens`
- **没有去路的参数会报错**：DSH 的调用配置只承载 `temperature` / `max_tokens` / `stop` / `reasoning_effort`，其余（`top_p`、`seed`、`response_format` 等）一律 `400` 说清，不静默忽略
- **未知模型会报错**：打错一个字母得到的是 `404 model_not_found`，不会静默换成另一个模型的答案
- **歧义会报错**：某个裸 model id 同时属于多个 provider 时返回 `400 ambiguous_model`，提示改用 `provider/model`
- **错误码有据可依**：按 DSH 的稳定 code 映射状态（401 / 429 / 400 / 404），`Retry-After` 一并透传
- **可选鉴权**：配置 `apiKeys` 后校验 `Authorization: Bearer` 或 `x-api-key`（sha256 + 定长比较）
- **可在界面配置**：宿主侧声明了 Config schema，浏览器半侧把配置表单注册进 Plugins 页，端口与默认模型都能在界面上改，**改端口不需要重启 DSH**
- **零运行时依赖**：只用 Node 内置模块，不需要 `npm install`

## 快速开始

### 安装

**本插件必须作为 profile 依赖安装**：`dependencies` 交给 pnpm 解析，`dsh.profile.bundles` 交给 loader 组合，两处都要登记。

只把目录丢进 `<profile>/node_modules/`、不写 `dependencies` 的「游离安装」不受支持，后果是：

- DSH 插件页看不到它 —— 那里的 `installed` 由 profile 的 `dependencies` 决定，启停、版本、卸载都无从操作；
- 「设置 → 插件」里不会出现它的配置表单，端口 / 默认模型这些参数只能改配置文件；
- `/healthz` 会返回 `installation.declared: false`，宿主日志同时打一条「游离安装」警告。

**建议安装方式：打包安装**（tarball）—— profile 与源码目录解耦，内容被复制进 profile，
Node 的依赖解析基准留在 profile 的 `node_modules` 内，不依赖符号链接。

1. bump `package.json` 的 `version`，然后打包并登记：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\build-and-pack.ps1
   ```

   脚本做三件事：`pnpm pack` 出 `<name>-<version>.tgz`、把它复制进 profile、
   把 profile 的 `dependencies.dsh-llm-gateway` 改写成 `file:<name>-<version>.tgz`。

2. 在 profile 目录里安装：

   ```powershell
   pnpm install
   ```

3. **重启 DSH** —— bundle 清单变更必须重启（`patchReload: live` 只管已加载插件的 config）。
   改动插件代码后同样要重启：重装只换磁盘上的文件，跑着的进程不会把已载入的模块换掉；
   Windows 上重装前最好先卸载，否则 pnpm 会撞 `EPERM`（旧目录还被进程占着，改不了名）。

> 别在 profile 的 `cordis.patch.yml` 里再写一条 `id: llm-gateway` 的 `insert` —— 会和包内 patch 撞 id。
> 要改默认值就写一条 id 定向的 override，只列要改的字段。

### 验证

1. DSH 日志出现 `[llm-gateway] gateway listening on http://127.0.0.1:8790/v1`
   和 `[llm-gateway] catalog ready: N providers, M models (K aliases)`
2. `curl http://127.0.0.1:8790/healthz` → `catalog.models` 应等于你在 profile 里配的模型总数
3. 非流式与流式各调一次，`finish_reason` 应是**字符串**
4. 发一个不存在的 model → 应返回 **404**（不是 200）
5. 带 `tools` 发一次 → 应返回 `finish_reason: "tool_calls"`，且 `message.tool_calls` 非空

### 调用

```python
from openai import OpenAI

c = OpenAI(base_url="http://127.0.0.1:8790/v1", api_key="any")  # 未配 apiKeys 时不校验

print([m.id for m in c.models.list()])
print(c.chat.completions.create(
    model="provider/model",
    messages=[{"role": "user", "content": "ping"}],
).choices[0].message.content)
```

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"provider/model","messages":[{"role":"user","content":"ping"}]}'
```

## 接口

| 方法   | 路径                     | 说明                                                           |
| ---- | ---------------------- | ------------------------------------------------------------ |
| GET  | `/v1/models`           | 全部 `provider/model`；某个裸 model id 只属于一个 provider 时，同时以裸 id 列出 |
| GET  | `/healthz`             | 网关状态 + 目录统计（provider 数 / 模型数 / 别名数 / 目录年龄）                   |
| POST | `/v1/chat/completions` | OpenAI 兼容，`stream` 真/假都支持                                    |

`/models`、`/chat/completions`、`/v1/healthz` 是等价别名。

请求体支持的参数：`model`、`messages`、`stream`、`max_tokens`（或新名 `max_completion_tokens`，1–200000）、
`temperature`、`stop`（最多 4 条）、`tools`、`reasoning_effort`。

**不在这份名单里的一律 `400 unsupported_parameter`。** 例外只有 `n=1`、`stream_options`、`user` 和
`tool_choice:"auto"` —— 这几个等于不表态，却几乎每个 SDK 都会默认带上，拒绝等于自断门路。

`messages[].content` 可以是字符串，也可以是 part 数组：

| part                                  | 说明                                                             |
| ------------------------------------- | -------------------------------------------------------------- |
| `{type:'text', text}`                 | 文本                                                             |
| `{type:'image_url', image_url:{url}}` | 图片；`url` 支持 `data:image/png;base64,…` 与 `http(s)://`（后者由网关代下载） |

消息角色除 `user` / `assistant` / `system` / `developer` 外，还支持工具对话的两个形状：

- `{role:'tool', tool_call_id, content}` —— 工具回执
- `{role:'assistant', tool_calls:[…], reasoning_content}` —— 带工具调用或思考过程的历史

`system` / `developer` 消息会合并成 DSH 的 `options.system`。

`model` 解析顺序：规范 id `provider/model` → 唯一的裸 model id → 请求缺 `model` 时用 `defaultModel`。

## 配置

| 键                    | 默认          | 说明                                                |
| -------------------- | ----------- | ------------------------------------------------- |
| `host`               | `127.0.0.1` | **别改成 `0.0.0.0`**，除非同时配 `apiKeys`                 |
| `port`               | `8790`      | 监听端口；改动会重建 HTTP 服务                                |
| `defaultModel`       | （空）         | 请求没带 `model` 时使用；留空则强制显式指定                        |
| `apiKeys`            | `[]`        | 非空则校验 `Authorization: Bearer` 或 `x-api-key`（定长比较） |
| `excludeProviders`   | `[]`        | 从目录剔除的 provider id                                |
| `excludeModels`      | `[]`        | 从目录剔除的 model id 或 `provider/model`                |
| `catalogTtlMs`       | `30000`     | 目录缓存时长；未命中会强制刷新一次                                 |
| `reasoningAsContent` | `true`      | 上游只出 reasoning 不出 text 时，把 reasoning 兜底当 content  |
| `requestLog`         | `true`      | 每个请求打一行 `方法 路径 -> 状态 (耗时)`                        |
| `maxBodyBytes`       | `8388608`   | 请求体上限                                             |

## 已知边界

- **默认无鉴权**：只绑回环所以安全；一旦把 `host` 改到局域网或公网，**必须**同时配 `apiKeys`。
- **图片要靠 attachments 服务**：DSH 没挂载 attachment provider 时返回 `501`。图片的类型、张数、
  总字节由那个 provider 的策略决定，它拒绝时网关把原话（如 `INVALID_IMAGE`）直接透传，不替它改口。
- **音频、视频不支持**：`input_audio` 之类的 part 返回 `400 unsupported_content`。
- **采样参数没有去路**：DSH 的调用配置只有六个字段，`top_p` / `seed` / `response_format` / `logprobs` /
  penalties 等都返回 `400` —— 宁可报错，也不静默忽略。
- **thinking 模型要多传一个字段**：多轮请求必须把上一轮的 `reasoning_content` 带回，否则上游会以 `400`
  拒绝。这是模型的要求，不是网关的。
- **`reasoning_tokens` 未必有**：字段实现了，但取不取得到取决于上游是否上报；成文时测到的 provider
  都没给这个数。
- **单轮**：每次请求独立调用 `llm.stream`，不维护服务端会话；多轮靠客户端把历史塞回 `messages`。
- **目录是快照**：`catalogTtlMs` 到期或 id 未命中时重建，新增模型建议重启 DSH。空目录不算有效快照，
  适配器就绪后会自愈。
- **中途失败改不回状态码**：SSE 头一旦发出就只能下发错误数据帧（OpenAI 同样做法）；开流前的失败会给
  真实的错误状态。
- 插件加载失败不会拖垮 DSH：单个插件异常只影响本插件。

## 文件清单

```
dsh-llm-gateway/
  package.json       # 包描述，dsh.bundle.patch 与 dsh.client 声明
  cordis.patch.yml   # bundle 层：插入 llm-gateway 条目
  lib/
    index.js         # 宿主半侧：HTTP 服务、模型目录、OpenAI 兼容层、Config schema
    client.js        # 浏览器半侧：Plugins 页上的配置表单
```

宿主半侧依赖 `@deepseek-ai/schemastery`（由 DSH 运行时提供）；浏览器半侧通过 DSH 的客户端模块表使用
`@deepseek-ai/dsh-client-ui-primitives`。除此外没有第三方依赖。

## 许可

MIT
