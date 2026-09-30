# dsh-llm-gateway

把 DSH 已配置的模型共享给本机程序——无需重复配置，用 **OpenAI 兼容接口**直接调用。

Python、Node、curl、Notebook 都能直接用，不需要额外的 SDK 适配层；模型目录从你的 DSH 配置里自动发现。

## 特性

- **OpenAI 兼容**：`/v1/models`、`/v1/chat/completions`（流式与非流式）、`/healthz`
- **真实路由**：模型目录从 DSH 的 `llm` 服务自动发现；请求里的 `model` 决定实际调哪个 provider，不是被忽略后照常回答
- **未知模型会报错**：打错一个字母得到的是 `404 model_not_found`，不会静默换成另一个模型的答案
- **歧义会报错**：某个裸 model id 同时属于多个 provider 时返回 `400 ambiguous_model`，提示改用 `provider/model`
- **可选鉴权**：配置 `apiKeys` 后校验 `Authorization: Bearer` 或 `x-api-key`（sha256 + 定长比较）
- **可在界面配置**：宿主侧声明了 Config schema，浏览器半侧把配置表单注册进 Plugins 页，端口与默认模型都能在界面上改，**改端口不需要重启 DSH**
- **零运行时依赖**：只用 Node 内置模块，不需要 `npm install`

## 快速开始

### 安装

把本包放进 profile 的 `node_modules`，并登记进 bundle 清单：

1. 将 `dsh-llm-gateway/` 整个目录放到 `<profile>/node_modules/dsh-llm-gateway/`
2. 在 profile 的 `package.json` 里，把 `"dsh-llm-gateway"` 追加进 `dsh.profile.bundles`
3. 重启 DSH（bundle 清单变更必须重启；`patchReload: live` 只管已加载插件的 config）

也可以把它作为本地依赖挂进去，这样改源码即生效：

```jsonc
// profile 的 package.json
{
  "dependencies": {
    "dsh-llm-gateway": "link:.dsh-llm-gateway-source"
  }
}
```

改完跑一次 `pnpm install` 建立符号链接。

> 别在 profile 的 `cordis.patch.yml` 里再写一条 `id: llm-gateway` 的 `insert` —— 会和包内 patch 撞 id。
> 要改默认值就写一条 id 定向的 override，只列要改的字段。

### 验证

1. DSH 日志出现 `[llm-gateway] gateway listening on http://127.0.0.1:8790/v1`
   和 `[llm-gateway] catalog ready: N providers, M models (K aliases)`
2. `curl http://127.0.0.1:8790/healthz` → `catalog.models` 应等于你在 profile 里配的模型总数
3. 非流式与流式各调一次，`finish_reason` 应是**字符串**
4. 发一个不存在的 model → 应返回 **404**（不是 200）

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

请求体支持：`model`、`messages`（`content` 为字符串或 `[{type:'text',text}]`）、`stream`、
`max_tokens`（1–200000）、`temperature`、`stop`（最多 4 条）。
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
- **纯文本**：带 `image_url` / 音频 part 的请求返回 `400 unsupported_content`。
- **不转发 tool calling**：请求里的 `tools` / `tool_calls` 不处理；上游返回 `tool-calls` 结束原因时，
  `finish_reason` 映射为 `tool_calls`，但工具调用内容不会出现在响应里。
- **单轮**：每次请求独立调用 `llm.stream`，不维护服务端会话；多轮靠客户端把历史塞回 `messages`。
- **目录是快照**：`catalogTtlMs` 到期或 id 未命中时重建；新增模型仍建议重启 DSH。
- **中途失败改不回状态码**：SSE 头一旦发出就只能下发错误数据帧（OpenAI 同样做法）；开流前的失败会给真正的 502。
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
