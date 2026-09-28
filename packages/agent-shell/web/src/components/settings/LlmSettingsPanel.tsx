import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  LuLoaderCircle,
  LuRefreshCw,
} from 'react-icons/lu';
import {
  getLlmSettings,
  setLlmSettings,
  getCompatFlags,
  getProviderPresets,
  getCatalogProviders,
  getLlmModels,
  resolveProviderPreset,
  type CompatFlagDescriptor,
  type GatewayModelEntry,
  type LlmSettings,
  type ProviderPresetDescriptor,
  type ProviderPresetOverride,
} from '@/lib/local-api';
import {
  FALLBACK_VENDORS,
  defaultModelForVendor,
  inferVendorId,
  llmProviderFromWireKind,
  mergeVendorOptions,
  modelPickerRows,
  usesOpenAiCompatExtras,
  type LiveCatalogStatus,
  type VendorOption,
} from '@/components/settings/llm-vendors';
import { ModelCapabilityChips } from '@/components/settings/ModelCapabilityChips';
import { modelCapabilityChips } from '@/components/settings/model-capabilities';
import { ModelIdCombobox } from '@/components/settings/ModelIdCombobox';
import { SettingsSaveButton } from '@/components/settings/SettingsSaveButton';
import { t } from '@/i18n';
import { hasHostBridge } from '@/lib/host-bridge';
import {
  COMPAT_AUTO,
  formStateFromOverrides,
  overridesFromFormState,
  type CompatFormState,
} from '@/components/settings/compat-flags-model';
import {
  choiceFromPresetMode,
  descriptorLabel,
  overrideFromDescriptor,
  overridesEqual,
  presetModeFromChoice,
  summarizePreset,
  type PresetMode,
} from '@/components/settings/preset-choice-model';

export interface LlmSettingsPanelHandle {
  save: () => Promise<void>;
}

export interface LlmSaveUi {
  saving: boolean;
  savedOk: boolean;
  loading: boolean;
}

interface LlmSettingsPanelProps {
  onSaved?: (settings: LlmSettings) => void;
  onSaveUiChange?: (ui: LlmSaveUi) => void;
  showFooterSave?: boolean;
}

// ─── 厂商参数预制（框架 llm.presets）────────────────────────────────────────
// 注册表与匹配规则都在框架侧（presets.describe / presets.resolve RPC），这里
// 只渲染与持久化选择；表单态转换在 settings/preset-choice-model.ts（可单测）。

/**
 * LlmSettingsPanel — 本地模型设置表单（服务商 / URL / Key / 模型 / 预制 / 超时）。
 *
 * 两处复用：设置页「设置」分区，以及输入区齿轮打开的 LocalLlmSettingsModal。
 * 挂载时自取当前配置；保存走 local-api `setLlmSettings`。
 */
export const LlmSettingsPanel = forwardRef<LlmSettingsPanelHandle, LlmSettingsPanelProps>(
  function LlmSettingsPanel(
    { onSaved, onSaveUiChange, showFooterSave = true },
    ref,
  ) {
  const [settings, setSettings] = useState<LlmSettings>({
    provider: 'openai-compat',
    vendorId: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    // temperature 缺省 = 自动（命中厂商预制用预制值，否则不下发）。
    maxTotalTokens: 60000,
  });
  const [vendors, setVendors] = useState<VendorOption[]>(() => mergeVendorOptions(FALLBACK_VENDORS));
  const [liveEntries, setLiveEntries] = useState<GatewayModelEntry[]>([]);
  const [liveCatalogStatus, setLiveCatalogStatus] = useState<LiveCatalogStatus>('idle');
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [keyTest, setKeyTest] = useState<
    | { status: 'idle' }
    | { status: 'testing' }
    | { status: 'ok'; count: number }
    | { status: 'fail'; detail: string }
  >({ status: 'idle' });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const savedOkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 超时设置（秒）。字符串存储以支持"留空 = 用默认值"。
  // execTimeoutSeconds 随 LlmSettings 持久化；场景包的超时项由包自带的
  // 设置面板承载（3.1 起 shell 设置页无包内联区块）。
  const [execTimeoutInput, setExecTimeoutInput] = useState('');

  // W1.3.2 compat 旗标：词汇表由 sidecar compat.describe 服务化（框架是
  // 单一真源）；表单三态字符串，'auto' = 不覆盖、走框架 URL 自动探测。
  const [compatFlags, setCompatFlags] = useState<CompatFlagDescriptor[]>([]);
  const [compatForm, setCompatForm] = useState<CompatFormState>({});

  // 厂商参数预制：注册表由 sidecar presets.describe 服务化；resolvedPreset
  // 是「自动」档下当前 baseUrl+model 的命中预览（presets.resolve）。
  const [presetMode, setPresetMode] = useState<PresetMode>('auto');
  const [presetList, setPresetList] = useState<ProviderPresetDescriptor[]>([]);
  const [presetPinnedIdx, setPresetPinnedIdx] = useState(-1);
  const [resolvedPreset, setResolvedPreset] = useState<ProviderPresetOverride | null>(null);

  const reload = useCallback(async () => {
    if (!hasHostBridge()) {
      setError(t('Open this in the desktop app'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await getLlmSettings();
      let nextVendors = mergeVendorOptions(FALLBACK_VENDORS);
      try {
        const { providers } = await getCatalogProviders();
        if (providers.length > 0) nextVendors = mergeVendorOptions(providers);
      } catch (err) {
        console.warn('Failed to read provider catalog:', err);
      }
      setVendors(nextVendors);
      const vendorId = inferVendorId(data, nextVendors);
      setSettings((prev) => ({
        ...prev,
        ...data,
        vendorId,
        baseUrl: data.baseUrl || '',
        apiKey: data.apiKey || '',
      }));
      // compat 旗标词汇表：sidecar 未就绪时留空（设置区显示提示，不阻塞
      // 其余设置项）。表单初值以已持久化的覆盖为准。
      try {
        const { flags } = await getCompatFlags();
        setCompatFlags(flags);
        setCompatForm(formStateFromOverrides(data.compat, flags));
      } catch (err) {
        console.warn('Failed to read compat flag vocabulary:', err);
        setCompatFlags([]);
        setCompatForm({});
      }
      // 预制注册表：同样服务化；初值以已持久化的选择为准（钉死的 override
      // 若在注册表里找到同参数行则选中该行，否则按「自定义」展示）。
      try {
        const { presets } = await getProviderPresets();
        setPresetList(presets);
        const mode = presetModeFromChoice(data.presets);
        setPresetMode(mode);
        if (mode === 'pinned' && data.presets?.override) {
          const idx = presets.findIndex((d) =>
            overridesEqual(overrideFromDescriptor(d), data.presets!.override!),
          );
          setPresetPinnedIdx(idx);
        } else {
          setPresetPinnedIdx(-1);
        }
      } catch (err) {
        console.warn('Failed to read vendor preset registry:', err);
        setPresetList([]);
        setPresetMode(presetModeFromChoice(data.presets));
      }
      setExecTimeoutInput(
        data.execTimeoutSeconds && data.execTimeoutSeconds > 0
          ? String(data.execTimeoutSeconds)
          : '',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () => () => {
      if (savedOkTimerRef.current) clearTimeout(savedOkTimerRef.current);
    },
    [],
  );

  // 「自动」档的命中预览：baseUrl/model 变化后向框架求一次 resolve
  // （防抖 300ms；sidecar 未就绪时静默留空，预览区显示提示）。
  useEffect(() => {
    if (!usesOpenAiCompatExtras(settings.provider) || presetMode !== 'auto') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      resolveProviderPreset(settings.baseUrl || undefined, settings.model || undefined)
        .then(({ preset }) => {
          if (!cancelled) setResolvedPreset(preset);
        })
        .catch(() => {
          if (!cancelled) setResolvedPreset(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [settings.provider, settings.baseUrl, settings.model, presetMode]);

  const selectedVendor =
    vendors.find((v) => v.id === (settings.vendorId || inferVendorId(settings, vendors))) ??
    vendors.find((v) => v.id === 'custom') ??
    vendors[0];

  const catalogModels = selectedVendor?.models ?? [];
  const modelOptions = modelPickerRows(
    liveEntries,
    catalogModels,
    settings.model,
    liveCatalogStatus,
  );
  const selectedEntry = liveEntries.find((entry) => entry.id === settings.model) ?? null;
  const selectedKnownEmpty =
    selectedEntry?.capabilities === 'known' &&
    modelCapabilityChips(selectedEntry, { detail: true }).length === 0;

  const featuredVendors = vendors.filter((v) => v.featured);
  const otherVendors = vendors.filter((v) => !v.featured);

  useEffect(() => {
    const baseUrl = settings.baseUrl?.trim();
    if (!baseUrl) {
      setLiveEntries([]);
      setLiveCatalogStatus('idle');
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      getLlmModels({
        baseUrl,
        apiKey: settings.apiKey || undefined,
        provider: settings.provider,
      })
        .then((catalog) => {
          if (cancelled) return;
          setLiveEntries(catalog.models);
          setLiveCatalogStatus(catalog.catalogStatus);
        })
        .catch(() => {
          if (cancelled) return;
          setLiveEntries([]);
          setLiveCatalogStatus('offline');
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [settings.baseUrl, settings.apiKey, settings.provider]);

  useEffect(() => {
    setKeyTest({ status: 'idle' });
  }, [settings.baseUrl, settings.apiKey, settings.provider]);

  const handleSwitchVendor = (vendorId: string) => {
    const vendor = vendors.find((v) => v.id === vendorId);
    if (!vendor) return;
    setLiveEntries([]);
    setLiveCatalogStatus('idle');
    setSettings((prev) => ({
      ...prev,
      vendorId: vendor.id,
      provider: llmProviderFromWireKind(vendor.wireKind),
      baseUrl: vendor.apiBaseUrl ?? '',
      model: defaultModelForVendor(vendor, prev.model),
    }));
  };

  const handleRefreshModels = async () => {
    const baseUrl = settings.baseUrl?.trim();
    if (!baseUrl || modelsRefreshing) return;
    setModelsRefreshing(true);
    try {
      const catalog = await getLlmModels({
        baseUrl,
        apiKey: settings.apiKey || undefined,
        provider: settings.provider,
        refresh: true,
      });
      setLiveEntries(catalog.models);
      setLiveCatalogStatus(catalog.catalogStatus);
    } catch {
      setLiveEntries([]);
      setLiveCatalogStatus('offline');
    } finally {
      setModelsRefreshing(false);
    }
  };

  const handleTestKey = async () => {
    const baseUrl = settings.baseUrl?.trim();
    if (!baseUrl || keyTest.status === 'testing') return;
    setKeyTest({ status: 'testing' });
    try {
      const catalog = await getLlmModels({
        baseUrl,
        apiKey: settings.apiKey || undefined,
        provider: settings.provider,
        refresh: true,
      });
      setLiveEntries(catalog.models);
      setLiveCatalogStatus(catalog.catalogStatus);
      if (catalog.catalogStatus === 'offline') {
        setKeyTest({
          status: 'fail',
          detail: catalog.error || t('Gateway catalog unavailable'),
        });
        return;
      }
      setKeyTest({ status: 'ok', count: catalog.models.length });
    } catch (err) {
      setLiveEntries([]);
      setLiveCatalogStatus('offline');
      setKeyTest({
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSave = async () => {
    if (!hasHostBridge()) {
      setError(t('Open this in the desktop app'));
      return;
    }
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const parseSeconds = (raw: string): number | undefined => {
        const n = parseInt(raw.trim(), 10);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      const execTimeoutSeconds = parseSeconds(execTimeoutInput);
      const saved = await setLlmSettings({
        provider: settings.provider,
        vendorId: settings.vendorId,
        model: settings.model,
        baseUrl: settings.baseUrl?.trim() || undefined,
        apiKey: settings.apiKey?.trim() || undefined,
        temperature: settings.temperature,
        systemPrompt: settings.systemPrompt?.trim() || undefined,
        maxTotalTokens: settings.maxTotalTokens,
        execTimeoutSeconds,
        compat:
          settings.provider === 'openai-compat'
            ? overridesFromFormState(compatForm, compatFlags)
            : undefined,
        presets: usesOpenAiCompatExtras(settings.provider)
          ? choiceFromPresetMode(presetMode, presetPinnedIdx, presetList, settings.presets)
          : undefined,
      });
      setSettings((prev) => ({ ...prev, ...saved }));
      setSavedOk(true);
      onSaved?.(saved);
      if (savedOkTimerRef.current) clearTimeout(savedOkTimerRef.current);
      savedOkTimerRef.current = setTimeout(() => setSavedOk(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  useImperativeHandle(ref, () => ({
    save: () => handleSaveRef.current(),
  }), []);

  useEffect(() => {
    onSaveUiChange?.({ saving, savedOk, loading });
  }, [saving, savedOk, loading, onSaveUiChange]);

  return (
    <div className="space-y-3">
          {loading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-agent-muted-foreground">
              <LuLoaderCircle className="h-4 w-4 animate-spin" />
              {t('Loading current settings...')}
            </div>
          ) : (
            <>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-agent-muted-foreground">
                    {t('Provider')}
                  </label>
                  <select
                    data-testid="llm-vendor-select"
                    value={selectedVendor?.id ?? 'custom'}
                    onChange={(e) => handleSwitchVendor(e.target.value)}
                    className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-2 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
                  >
                    {featuredVendors.length > 0 && (
                      <optgroup label={t('Common')}>
                        {featuredVendors.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {otherVendors.length > 0 && (
                      <optgroup label={t('All')}>
                        {otherVendors.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <p className="mt-1.5 text-[11px] text-agent-muted-foreground">
                    {selectedVendor?.id === 'ollama'
                      ? t('Make sure `ollama serve` is running on this computer and you have run `ollama pull <model>`.')
                      : selectedVendor?.id === 'custom'
                        ? t('Any gateway compatible with OpenAI Chat Completions. For Anthropic / Gemini, pick the matching provider from the list above.')
                        : selectedVendor?.wireKind === 'anthropic'
                          ? t('Uses the native Anthropic Messages protocol.')
                          : selectedVendor?.wireKind === 'google'
                            ? t('Uses the native Google Gemini protocol.')
                            : selectedVendor?.wireKind === 'openai-responses'
                              ? t('Uses the OpenAI Responses API (e.g. xAI Grok).')
                              : t('A cloud or local gateway compatible with OpenAI Chat Completions.')}
                  </p>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-agent-muted-foreground">
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={settings.baseUrl || ''}
                    onChange={(e) =>
                      setSettings((prev) => ({ ...prev, baseUrl: e.target.value }))
                    }
                    placeholder={
                      selectedVendor?.apiBaseUrl ||
                      (selectedVendor?.id === 'custom'
                        ? 'https://your-gateway.example/v1'
                        : t('This provider has no default URL. Enter it manually.'))
                    }
                    className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
                  />
                  <p className="mt-1.5 text-[11px] text-agent-muted-foreground">
                    {selectedVendor?.apiBaseUrl
                      ? t('The provider default URL is filled in. Change it for a private deployment.')
                      : t('The catalog has no default URL. Enter it manually.')}
                  </p>
                </div>

                {settings.provider !== 'ollama' && (
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-agent-muted-foreground">
                      API Key
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={settings.apiKey || ''}
                        onChange={(e) =>
                          setSettings((prev) => ({ ...prev, apiKey: e.target.value }))
                        }
                        placeholder={
                          selectedVendor?.id === 'custom'
                            ? t('sk-... (optional, can be blank for a private deployment)')
                            : t('sk-... (required, create one in the provider console)')
                        }
                        className="h-8 min-w-0 flex-1 rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
                      />
                      <button
                        type="button"
                        data-testid="llm-key-test"
                        title={t('Fetch the model catalog from the gateway once with the current URL and key')}
                        disabled={!settings.baseUrl?.trim() || keyTest.status === 'testing'}
                        onClick={() => void handleTestKey()}
                        className="inline-flex h-8 shrink-0 items-center justify-center rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs font-medium text-agent-foreground transition-colors hover:bg-agent-foreground/5 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {keyTest.status === 'testing' ? (
                          <LuLoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                          t('Test')
                        )}
                      </button>
                    </div>
                    <p
                      className={[
                        'mt-1.5 text-[11px]',
                        keyTest.status === 'fail'
                          ? 'text-agent-destructive'
                          : keyTest.status === 'idle' && !settings.apiKey?.trim()
                            ? 'text-amber-600'
                            : 'text-agent-muted-foreground',
                      ].join(' ')}
                    >
                      {keyTest.status === 'testing'
                        ? t('Verifying credentials…')
                        : keyTest.status === 'ok'
                          ? t('Credentials work. The gateway returned {count} models.', { count: keyTest.count })
                          : keyTest.status === 'fail'
                            ? t('Verification failed: {detail}', { detail: keyTest.detail })
                            : !settings.apiKey?.trim()
                              ? t(
                                  'No API key yet: create a key in the provider console (DeepSeek: platform.deepseek.com → API Keys), paste it in the box above, click "Test", and save once it passes.',
                                )
                              : t(
                                  'Web search is configured on the settings page: choose free search or a Tavily key. OpenAI can use this chat key for hosted search.',
                                )}
                    </p>
                  </div>
                )}

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-agent-muted-foreground">
                    {t('Model')}
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <ModelIdCombobox
                        value={settings.model}
                        options={modelOptions}
                        placeholder={liveEntries[0]?.id || catalogModels[0] || t('Choose or enter a model id')}
                        onChange={(model) => setSettings((prev) => ({ ...prev, model }))}
                      />
                    </div>
                    <button
                      type="button"
                      data-testid="llm-model-refresh"
                      title={t('Fetch the model list from the gateway again')}
                      aria-label={t('Refresh model catalog')}
                      disabled={!settings.baseUrl?.trim() || modelsRefreshing}
                      onClick={() => void handleRefreshModels()}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-agent-md border border-agent-border bg-agent-canvas text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <LuRefreshCw className={`h-4 w-4 ${modelsRefreshing ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                  {(liveCatalogStatus === 'live' || liveCatalogStatus === 'stale') && (
                    <div
                      data-testid="llm-model-capabilities"
                      className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-agent-muted-foreground"
                    >
                      <span>{t('Current')}</span>
                      {selectedEntry ? (
                        selectedKnownEmpty ? (
                          <span>{t('Text chat')}</span>
                        ) : (
                          <ModelCapabilityChips entry={selectedEntry} detail />
                        )
                      ) : (
                        <span>{t('Capabilities unrecognized (not in the gateway catalog)')}</span>
                      )}
                    </div>
                  )}
                  <p className="mt-1.5 text-[11px] text-agent-muted-foreground">
                    {liveCatalogStatus === 'live'
                      ? t('Fetched {count} models from the gateway. You can also type one in.', {
                          count: liveEntries.length,
                        })
                      : liveCatalogStatus === 'stale'
                        ? t('Failed to refresh the gateway catalog. Using the last cached copy; you can also type one in.')
                        : liveCatalogStatus === 'idle' && (settings.baseUrl || '').trim()
                          ? t('Fetching the model catalog from the gateway…')
                          : liveCatalogStatus === 'idle'
                            ? t('Enter a Base URL to fetch the gateway model catalog, or type a model in.')
                            : catalogModels.length > 0
                              ? t('Gateway catalog unavailable. Using the provider built-in list for now; you can also type one in.')
                              : t('Gateway catalog unavailable. Enter the model id directly.')}
                  </p>
                </div>

                {usesOpenAiCompatExtras(settings.provider) && (
                  <div className="rounded-agent-md border border-agent-border/60 p-3 space-y-3">
                    <div>
                      <h4 className="text-xs font-semibold text-agent-muted-foreground uppercase tracking-wide">
                        {t('Vendor parameter presets')}
                      </h4>
                      <p className="mt-1 text-[11px] text-agent-muted-foreground">
                        {t(
                          'Fill requests automatically with the best sampling parameters from vendor docs (temperature / top_p / top_k, etc.).',
                        )}{' '}
                        {t(
                          '"Auto" matches the built-in registry by Base URL + model name. Explicit manual settings such as Temperature always take precedence over presets.',
                        )}
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      {(
                        [
                          { value: 'auto', label: 'Auto (recommended)' },
                          { value: 'off', label: 'Off' },
                          { value: 'pinned', label: 'Pick a preset' },
                        ] as { value: PresetMode; label: string }[]
                      ).map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          data-preset-mode={opt.value}
                          onClick={() => setPresetMode(opt.value)}
                          className={`h-7 flex-1 rounded-agent-md text-xs transition-all ${
                            presetMode === opt.value
                              ? 'bg-agent-foreground text-agent-canvas'
                              : 'bg-agent-muted text-agent-muted-foreground hover:text-agent-foreground'
                          }`}
                        >
                          {t(opt.label)}
                        </button>
                      ))}
                    </div>
                    {presetMode === 'pinned' &&
                      (presetList.length > 0 ? (
                        <select
                          value={presetPinnedIdx}
                          onChange={(e) => setPresetPinnedIdx(Number(e.target.value))}
                          className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-2 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
                        >
                          {presetPinnedIdx === -1 && (
                            <option value={-1}>
                              {settings.presets?.override ? t('Custom (saved override)') : t('Select…')}
                            </option>
                          )}
                          {presetList.map((d, i) => (
                            <option key={i} value={i}>
                              {descriptorLabel(d)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-[11px] text-agent-muted-foreground">
                          {t('The preset registry comes from the sidecar. Nothing is available while the sidecar is not ready.')}
                        </p>
                      ))}
                    <p className="text-[11px] text-agent-muted-foreground/80" data-preset-preview>
                      {presetMode === 'off'
                        ? t('Off: vendor preset parameters are not sent.')
                        : presetMode === 'pinned'
                          ? t('Effective parameters: {summary}', {
                              summary: summarizePreset(
                                presetPinnedIdx >= 0 && presetList[presetPinnedIdx]
                                  ? overrideFromDescriptor(presetList[presetPinnedIdx])
                                  : (settings.presets?.override ?? null),
                              ),
                            })
                          : resolvedPreset
                            ? t('Matched preset: {summary}', { summary: summarizePreset(resolvedPreset) })
                            : t('The current Base URL + model match no preset. No extra sampling parameters are sent.')}
                    </p>
                  </div>
                )}

                {settings.provider === 'openai-compat' && (
                  <div className="rounded-agent-md border border-agent-border/60 p-3 space-y-3">
                    <div>
                      <h4 className="text-xs font-semibold text-agent-muted-foreground uppercase tracking-wide">
                        {t('Advanced compatibility flags (optional)')}
                      </h4>
                      <p className="mt-1 text-[11px] text-agent-muted-foreground">
                        {t(
                          'Change these only when the vendor gateway differs from the OpenAI protocol and auto-detection does not cover it. "Auto" = the framework matches known vendors by Base URL host name (DeepSeek / Moonshot / OpenRouter / DashScope) and falls back to OpenAI reference behavior otherwise.',
                        )}
                      </p>
                    </div>
                    {compatFlags.length === 0 ? (
                      <p className="text-[11px] text-agent-muted-foreground">
                        {t('The flag vocabulary comes from the sidecar. This stays empty while the sidecar is not ready; saving is not affected.')}
                      </p>
                    ) : (
                      compatFlags.map((flag) => (
                        <div key={flag.key} data-compat-flag={flag.key}>
                          <label className="mb-1 block text-xs font-medium text-agent-muted-foreground">
                            {flag.key}
                          </label>
                          {flag.kind === 'bool' ? (
                            <div className="flex gap-1.5">
                              {[
                                { value: COMPAT_AUTO, label: 'Auto' },
                                { value: 'true', label: 'Yes' },
                                { value: 'false', label: 'No' },
                              ].map((opt) => (
                                <button
                                  key={opt.value}
                                  type="button"
                                  onClick={() =>
                                    setCompatForm((prev) => ({ ...prev, [flag.key]: opt.value }))
                                  }
                                  className={`h-7 flex-1 rounded-agent-md text-xs transition-all ${
                                    (compatForm[flag.key] ?? COMPAT_AUTO) === opt.value
                                      ? 'bg-agent-foreground text-agent-canvas'
                                      : 'bg-agent-muted text-agent-muted-foreground hover:text-agent-foreground'
                                  }`}
                                >
                                  {t(opt.label)}
                                </button>
                              ))}
                            </div>
                          ) : flag.kind.startsWith('enum:') ? (
                            <select
                              value={compatForm[flag.key] ?? COMPAT_AUTO}
                              onChange={(e) =>
                                setCompatForm((prev) => ({ ...prev, [flag.key]: e.target.value }))
                              }
                              className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-2 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
                            >
                              <option value={COMPAT_AUTO}>{t('Auto')}</option>
                              {flag.kind
                                .slice('enum:'.length)
                                .split(',')
                                .map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={compatForm[flag.key] === COMPAT_AUTO ? '' : (compatForm[flag.key] ?? '')}
                              onChange={(e) =>
                                setCompatForm((prev) => ({
                                  ...prev,
                                  [flag.key]: e.target.value || COMPAT_AUTO,
                                }))
                              }
                              placeholder={t('Comma-separated; blank = auto')}
                              className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-2 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
                            />
                          )}
                          <p className="mt-1 text-[11px] text-agent-muted-foreground/80">
                            {flag.description}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                )}

                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-xs font-medium text-agent-muted-foreground">
                      Temperature
                      {settings.temperature !== undefined && ` (${settings.temperature.toFixed(2)})`}
                    </label>
                    <div className="flex gap-1">
                      {(
                        [
                          { value: 'auto', label: 'Auto' },
                          { value: 'manual', label: 'Manual' },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          data-temperature-mode={opt.value}
                          onClick={() =>
                            setSettings((prev) => ({
                              ...prev,
                              temperature:
                                opt.value === 'auto'
                                  ? undefined
                                  : (prev.temperature ?? resolvedPreset?.temperature ?? 0.3),
                            }))
                          }
                          className={`h-6 rounded-agent-md px-2.5 text-[11px] transition-all ${
                            (settings.temperature === undefined ? 'auto' : 'manual') === opt.value
                              ? 'bg-agent-foreground text-agent-canvas'
                              : 'bg-agent-muted text-agent-muted-foreground hover:text-agent-foreground'
                          }`}
                        >
                          {t(opt.label)}
                        </button>
                      ))}
                    </div>
                  </div>
                  {settings.temperature === undefined ? (
                    <p className="text-[11px] text-agent-muted-foreground">
                      {t(
                        'Auto: uses the preset temperature when a vendor preset matches{match}. Otherwise nothing is sent (the vendor server default applies). An explicit manual value takes precedence over the preset.',
                        {
                          match:
                            presetMode === 'auto' && resolvedPreset?.temperature != null
                              ? t(' (current match: {value})', { value: resolvedPreset.temperature })
                              : '',
                        },
                      )}
                    </p>
                  ) : (
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.temperature}
                      onChange={(e) =>
                        setSettings((prev) => ({ ...prev, temperature: Number(e.target.value) }))
                      }
                      className="w-full"
                    />
                  )}
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-agent-muted-foreground">
                    {t('Token budget limit')}
                  </label>
                  <input
                    type="number"
                    value={settings.maxTotalTokens ?? 60000}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      setSettings((prev) => ({ ...prev, maxTotalTokens: isNaN(val) ? undefined : val }));
                    }}
                    placeholder="60000"
                    className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
                  />
                  <p className="mt-1.5 text-[11px] text-agent-muted-foreground">
                    {t(
                      'Maximum tokens a single conversation may consume in total (default 60,000). It stops automatically when the limit is exceeded, to prevent endless model loops or unexpected token usage.',
                    )}
                  </p>
                </div>

                {/* ───── 超时设置 ───── */}
                <div className="border-t border-agent-border/60 pt-3 space-y-3">
                  <h4 className="text-xs font-semibold text-agent-muted-foreground uppercase tracking-wide">
                    {t('Timeouts')}
                  </h4>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-agent-muted-foreground">
                      {t('Default local command timeout (seconds)')}
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={execTimeoutInput}
                      onChange={(e) => setExecTimeoutInput(e.target.value)}
                      placeholder={t('Blank = default (background 30s / terminal 60s)')}
                      className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
                    />
                    <p className="mt-1.5 text-[11px] text-agent-muted-foreground">
                      {t(
                        'Default wait time for local commands that do not set a timeout explicitly. Launch commands containing "gui" are exempt: on timeout they are treated as "program started and still running", not as a failure or a repeated launch.',
                      )}
                    </p>
                  </div>

                </div>
            </>
          )}

          {error && (
            <div className="rounded-agent-md border border-agent-destructive/20 bg-agent-destructive/10 p-2.5 text-xs text-agent-destructive">
              {error}
            </div>
          )}

          {showFooterSave && (
            <div className="flex justify-end">
              <SettingsSaveButton
                testId="llm-settings-save"
                saving={saving}
                savedOk={savedOk}
                disabled={saving || loading}
                onClick={() => void handleSave()}
              />
            </div>
          )}
    </div>
  );
});
