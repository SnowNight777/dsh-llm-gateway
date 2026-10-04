/**
 * dsh-llm-gateway — 浏览器半侧。
 *
 * 把网关的开关做成「插件管理页里这张包卡片自己的配置区」：Host 侧的 Config
 * schema 让 `llm-gateway` 成为一个被服务的 settings 命名空间，这里用
 * `ctx.configForms.get("llm-gateway")` 绑定它，再注册进 `plugins.bundle.config`
 * （key 取包名），于是包详情页多出一块「配置」，端口与默认模型都能在界面里改。
 *
 * 两个口径按源码而不是猜测定下：
 *   - 命名空间 = patchId（`llm-gateway`），不是 loader entryId
 *     （`include:llm-gateway`）—— dsh-settings 以 `entry.options.id` 建 ns。
 *   - `plugins.bundle.config` 的 key = 包名，由插件的 config-ledger 读
 *     `entry.options.key` 判定「这张卡片有没有配置区」。
 *
 * 本文件不是 ES 模块，而是客户端模块表的预构建产物，格式与官方伴生包一致
 * （对照 @deepseek-ai/dsh-client-ui-settings-shell/lib/client.js）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-gateway',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let react_jsx_runtime = require('react/jsx-runtime');
    let primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    //#region locales
    /** English copy. */
    const en = {
      title: 'LLM gateway',
      description: 'Expose every provider/model this profile has configured over an OpenAI-compatible endpoint on loopback.',
      port: 'Listen port',
      portHint: 'Rebuilds the HTTP server. If a port change does not take effect, restart DSH.',
      defaultModel: 'Default model',
      defaultModelHint: 'Route used when a request carries no model, written as provider/model. Leave blank to require an explicit model.',
      host: 'Listen address',
      hostHint: 'Do not use 0.0.0.0 unless API keys are configured.',
      apiKeys: 'API keys',
      apiKeysHint: 'Comma-separated. Non-empty means Authorization: Bearer and x-api-key are verified.',
      excludeProviders: 'Excluded providers',
      excludeProvidersHint: 'Comma-separated provider ids dropped from the model catalog.',
      excludeModels: 'Excluded models',
      excludeModelsHint: 'Comma-separated model ids or provider/model dropped from the model catalog.',
      catalogTtlMs: 'Catalog cache (ms)',
      catalogTtlMsHint: 'How long the discovered model catalog is reused before it is rebuilt.',
      maxBodyBytes: 'Request body cap (bytes)',
      maxBodyBytesHint: 'Requests larger than this are rejected before parsing.',
      reasoningAsContent: 'Reasoning as content',
      reasoningAsContentHint: 'When the upstream yields reasoning but no text, return the reasoning as the content.',
      requestLog: 'Request log',
      requestLogHint: 'Log one line per request: method, path, status, elapsed.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalid: 'That value is not accepted for this field.',
    };
    /** Simplified Chinese copy. */
    const zh = {
      title: 'LLM 网关',
      description: '把本 profile 已配置的全部 provider / model 以 OpenAI 兼容接口暴露到本机回环，供任意本地程序调用。',
      port: '监听端口',
      portHint: '改动会重建 HTTP 服务。若端口改动未生效，重启 DSH。',
      defaultModel: '默认模型',
      defaultModelHint: '请求未带 model 时使用的路由，写成 provider/model。留空则强制客户端显式指定。',
      host: '监听地址',
      hostHint: '别改成 0.0.0.0，除非同时配置了 API 密钥。',
      apiKeys: 'API 密钥',
      apiKeysHint: '逗号分隔。非空则校验 Authorization: Bearer 与 x-api-key。',
      excludeProviders: '剔除的 provider',
      excludeProvidersHint: '逗号分隔的 provider id，会从模型目录里移除。',
      excludeModels: '剔除的模型',
      excludeModelsHint: '逗号分隔的 model id 或 provider/model，会从模型目录里移除。',
      catalogTtlMs: '目录缓存（毫秒）',
      catalogTtlMsHint: '发现到的模型目录复用多久后重建。',
      maxBodyBytes: '请求体上限（字节）',
      maxBodyBytesHint: '超过此大小的请求在解析前就被拒绝。',
      reasoningAsContent: 'reasoning 兜底为 content',
      reasoningAsContentHint: '上游只出 reasoning 不出 text 时，把 reasoning 当作正文返回。',
      requestLog: '请求日志',
      requestLogHint: '每个请求打一行：方法、路径、状态、耗时。',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalid: '这个值不被该字段接受。',
    };
    /**
     * The form frame's copy, read from this page's dictionary.
     * @param t - the page's locale reader.
     * @returns the labels the shared settings form renders.
     */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      };
    }
    //#endregion

    //#region field specs
    /**
     * A comma-separated list field. The shared helpers only cover numbers and free
     * text, and three of this schema's fields are string arrays, so the array
     * conversion lives here: an empty draft clears the field, any other draft
     * splits on commas and drops empty entries.
     * @param field - field name inside the namespace section.
     * @returns the field's conversion spec.
     */
    function listField(field) {
      return {
        field,
        format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed === '') return { kind: 'clear' };
          return {
            kind: 'set',
            value: trimmed
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          };
        },
      };
    }
    /**
     * A boolean field carried as the literal text `true` / `false`. The model
     * stages text, so a checkbox edit travels as that text; a draft that is
     * neither spelling blocks the save rather than guessing.
     * @param field - field name inside the namespace section.
     * @returns the field's conversion spec.
     */
    function booleanField(field) {
      return {
        field,
        format: (value) => (typeof value === 'boolean' ? String(value) : ''),
        parse: (text) => {
          const trimmed = text.trim().toLowerCase();
          if (trimmed === '') return { kind: 'clear' };
          if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes') return { kind: 'set', value: true };
          if (trimmed === 'false' || trimmed === '0' || trimmed === 'no') return { kind: 'set', value: false };
          return undefined;
        },
      };
    }
    //#endregion

    //#region BooleanField
    /**
     * Render one boolean field. The shared value field draws a text input only,
     * so a checkbox gets its own labelled row; it reports the requested state as
     * the text the model stages and never writes by itself.
     * @param props - the field's copy, its staged text, and the edit actions.
     * @returns the labelled checkbox row.
     */
    function BooleanField(props) {
      return react_jsx_runtime.jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px' },
        children: [
          react_jsx_runtime.jsx(primitives.Checkbox, {
            checked: props.text === 'true',
            disabled: props.disabled,
            label: props.label,
            onChange: (next) => {
              props.onEdit(next ? 'true' : 'false');
            },
          }),
          react_jsx_runtime.jsx('p', {
            style: { margin: 0, fontSize: '12px', lineHeight: '18px', opacity: 0.7 },
            children: props.hint,
          }),
        ],
      });
    }
    //#endregion

    //#region GatewayCard
    /**
     * Render the gateway's one-liner or its settings form, as the Plugins page asks.
     * @param props - the view asked for, locale copy, the form snapshot, and its actions.
     * @returns the one-liner, or the form.
     */
    function GatewayCard(props) {
      const t = props.t;
      const state = props.useGatewayConfig((snapshot) => snapshot);
      if (props.view === 'summary') return t('description');
      const disabled = !state.writable;
      const valueField = (field, label, hint, numeric) =>
        react_jsx_runtime.jsx(
          primitives.SettingsValueField,
          {
            id: 'plugin-config-llm-gateway-' + field,
            label,
            hint,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalid'),
            numeric,
            disabled,
            text: state[field].text,
            overridden: state[field].overridden,
            invalid: state[field].invalid,
            onEdit: (text) => {
              props.edit(field, text);
            },
            onReset: () => {
              props.resetField(field);
            },
          },
          field,
        );
      const boolField = (field, label, hint) =>
        react_jsx_runtime.jsx(
          BooleanField,
          {
            id: 'plugin-config-llm-gateway-' + field,
            label,
            hint,
            disabled,
            text: state[field].text,
            onEdit: (text) => {
              props.edit(field, text);
            },
          },
          field,
        );
      return react_jsx_runtime.jsxs(primitives.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          valueField('port', t('port'), t('portHint'), true),
          valueField('defaultModel', t('defaultModel'), t('defaultModelHint'), false),
          valueField('host', t('host'), t('hostHint'), false),
          valueField('apiKeys', t('apiKeys'), t('apiKeysHint'), false),
          valueField('excludeProviders', t('excludeProviders'), t('excludeProvidersHint'), false),
          valueField('excludeModels', t('excludeModels'), t('excludeModelsHint'), false),
          valueField('catalogTtlMs', t('catalogTtlMs'), t('catalogTtlMsHint'), true),
          valueField('maxBodyBytes', t('maxBodyBytes'), t('maxBodyBytesHint'), true),
          boolField('reasoningAsContent', t('reasoningAsContent'), t('reasoningAsContentHint')),
          boolField('requestLog', t('requestLog'), t('requestLogHint')),
        ],
      });
    }
    //#endregion

    //#region controller
    /** The editable fields, in the order the form renders them. */
    const FIELDS = [
      primitives.settingsNumberField('port'),
      primitives.settingsTextField('defaultModel'),
      primitives.settingsTextField('host'),
      listField('apiKeys'),
      listField('excludeProviders'),
      listField('excludeModels'),
      primitives.settingsNumberField('catalogTtlMs'),
      primitives.settingsNumberField('maxBodyBytes'),
      booleanField('reasoningAsContent'),
      booleanField('requestLog'),
    ];
    /** Bridges the gateway entry's form onto the page's staged form. */
    var GatewayConfigController = class {
      form;
      store;
      /** @param scope - the shared configuration form of the gateway entry. */
      constructor(scope) {
        this.form = new primitives.SettingsFormModel(scope, FIELDS);
        this.store = this.form.bind(() => this.projection());
      }
      projection() {
        const out = { ...this.form.shell() };
        for (const spec of FIELDS) out[spec.field] = this.form.field(spec.field);
        return out;
      }
      /**
       * Build the face the page's slot registration injects.
       * @returns the page's snapshot and its form actions.
       */
      inject() {
        return {
          hooks: { gatewayConfig: this.store },
          ...this.form.actions(),
        };
      }
      /** Release the form subscription. */
      dispose() {
        this.form.dispose();
      }
    };
    //#endregion

    //#region index
    /** The bundle key `plugins.bundle.config` is registered under; the page matches it against the package name. */
    const PKG = 'dsh-llm-gateway';
    /** The settings namespace this form prefers. */
    const NS = 'llm-gateway';
    /**
     * Namespace spellings worth watching. The Host has used the loader entry id,
     * the patch id and the package name across versions, and only a running
     * deployment can say which one it serves — so bind whichever shows up.
     */
    const NS_CANDIDATES = [NS, PKG, 'include:' + NS];
    /** Dictionary namespace owned by this plugin. */
    const DICT = 'settings.llm-gateway';
    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'configForms'];
    /**
     * Mount the gateway's configuration section on its own package page while the
     * Host serves the namespace. A deployment without the schema shows no trace
     * of it, because nothing serves `llm-gateway` to bind a form to.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(DICT);
      ctx.effect(
        () =>
          ctx.locale.register(DICT, {
            zh,
            en,
          }),
        'dsh-llm-gateway: dictionaries',
      );
      ctx.effect(
        () =>
          ctx.configForms.whileServed(NS_CANDIDATES, (served) => {
            const ns = NS_CANDIDATES.find((candidate) => served.has(candidate));
            if (ns === undefined) return undefined;
            const bound = new GatewayConfigController(ctx.configForms.get(ns));
            const off = ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: PKG,
                  locale: DICT,
                  inject: () => bound.inject(),
                },
                GatewayCard,
              ),
            );
            return () => {
              off();
              bound.dispose();
            };
          }),
        'dsh-llm-gateway: settings section',
      );
    }
    //#endregion

    exports.PKG = PKG;
    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
