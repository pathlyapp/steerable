import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  LuActivity,
  LuBlocks,
  LuBot,
  LuChartBar,
  LuCodeXml,
  LuDownload,
  LuGitFork,
  LuInfo,
  LuMonitor,
  LuNetwork,
  LuPlug,
  LuSearch,
  LuSettings,
  LuShieldCheck,
} from 'react-icons/lu';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { hasHostBridge } from '@/lib/host-bridge';
import { getLocale, t } from '@/i18n';
import { useAppRelease } from '@/components/SidebarRelease';
import { AgentsSettingsPanel } from '@/components/settings/AgentsSettingsPanel';
import { AppearanceSettingsPanel } from '@/components/settings/AppearanceSettingsPanel';
import { OrchestrationSettingsPanel } from '@/components/settings/OrchestrationSettingsPanel';
import { AppUpdateSettingsPanel } from '@/components/settings/AppUpdateSettingsPanel';
import { PortableSettingsPanel } from '@/components/settings/PortableSettingsPanel';
import { PythonRunnerSettingsPanel } from '@/components/settings/PythonRunnerSettingsPanel';
import { DiagnoseSettingsPanel } from '@/components/settings/DiagnoseSettingsPanel';
import { InsightsSettingsPanel } from '@/components/settings/InsightsSettingsPanel';
import {
  LlmSettingsPanel,
  type LlmSaveUi,
  type LlmSettingsPanelHandle,
} from '@/components/settings/LlmSettingsPanel';
import { McpSettingsPanel } from '@/components/settings/McpSettingsPanel';
import { SecuritySettingsPanel } from '@/components/settings/SecuritySettingsPanel';
import { SkillsSettingsPanel } from '@/components/settings/SkillsSettingsPanel';
import { SettingsSaveButton } from '@/components/settings/SettingsSaveButton';
import { TelemetrySettingsPanel } from '@/components/settings/TelemetrySettingsPanel';
import { UsagePanel } from '@/components/settings/UsagePanel';
import { WebSearchSettingsPanel } from '@/components/settings/WebSearchSettingsPanel';
import { SettingsNavMenu, type SettingsNavItem } from '@/components/settings/SettingsNavMenu';
import { getPackSettingsPanels } from '@/packs/registry';
import { settingsChrome } from '@/lib/host-tools';
import { isPortableEnabled } from '@/lib/portable';
import type { AgentOutletContext } from '@/layouts/AgentLayout';

type SettingsSection = 'plugins' | 'general';
type PluginTab = 'agents' | 'skills' | 'mcp' | 'web-search';

const PLUGIN_TABS: readonly PluginTab[] = ['agents', 'skills', 'mcp', 'web-search'];

/** 每次渲染现取，文案跟随当前语言。 */
function pluginTabMeta(): Record<PluginTab, { label: string; noun: string; Icon: typeof LuBot }> {
  return {
    agents: { label: t('Agents'), noun: t('agents'), Icon: LuBot },
    skills: { label: 'Skills', noun: t('skills'), Icon: LuBlocks },
    mcp: { label: 'MCP', noun: t('MCP servers'), Icon: LuPlug },
    'web-search': { label: t('Web search'), noun: t('web search'), Icon: LuSearch },
  };
}

function isPluginTab(value: string | null): value is PluginTab {
  return (PLUGIN_TABS as readonly string[]).includes(value ?? '');
}

function pluginsSummary(tabs: readonly PluginTab[]): string {
  const meta = pluginTabMeta();
  const nouns = tabs.map((id) => meta[id].noun);
  const items =
    nouns.length === 0
      ? t('plugins')
      : new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(nouns);
  return t('Manage {items}.', { items });
}

function enabledPluginTabs(): PluginTab[] {
  return PLUGIN_TABS.filter((id) => settingsChrome(id));
}

function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'plugins') return enabledPluginTabs().length > 0 ? 'plugins' : 'general';
  if ((raw === 'agents' || raw === 'skills' || raw === 'mcp') && settingsChrome(raw)) {
    return 'plugins';
  }
  return 'general';
}

/** `?section=agents|skills|mcp` 是旧深链，仍打开插件页上对应分类。 */
function resolvePluginTab(section: string | null, tab: string | null): PluginTab | null {
  const enabled = enabledPluginTabs();
  const requested =
    section === 'agents' || section === 'skills' || section === 'mcp' ? section : tab;
  if (isPluginTab(requested) && enabled.includes(requested)) {
    return requested;
  }
  return enabled[0] ?? null;
}

/**
 * `/settings` — 右侧内容区的设置页，按 `?section=` 分成独立页面：
 *   - `plugins`  侧栏「插件」。顶栏分类切换智能体 / Skills / MCP / 网络搜索
 *     （`?tab=`，旧的 `?section=agents|skills|mcp` 仍落到对应分类）
 *   - 缺省/`general`  侧栏底「设置」（界面 / 模型 / 搜索 / 用量 / 安全 / 洞察 / 遥测 / 关于）
 *
 * Panel 数据自管理（挂载即拉取），页面本身不持有后端状态。
 */
export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSection = searchParams.get('section');
  const section = resolveSection(rawSection);
  const pluginTab = section === 'plugins' ? resolvePluginTab(rawSection, searchParams.get('tab')) : null;
  const pluginTabs = section === 'plugins' ? enabledPluginTabs() : [];
  const selectPluginTab = useCallback((id: PluginTab) => {
    setSearchParams({ section: 'plugins', tab: id });
  }, [setSearchParams]);
  const catalog = useOutletContext<AgentOutletContext | null>();
  const release = useAppRelease();
  const llmPanelRef = useRef<LlmSettingsPanelHandle>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [renderedSectionIds, setRenderedSectionIds] = useState<Set<string> | null>(null);
  const [llmSaveUi, setLlmSaveUi] = useState<LlmSaveUi>({
    saving: false,
    savedOk: false,
    loading: true,
  });

  useEffect(() => {
    const el = pageContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 扫描右侧实际挂载且未被隐藏 (display !== 'none') 的设置分段
  const updateRenderedSections = useCallback(() => {
    const container = contentRef.current;
    if (!container) return;
    const sectionEls = container.querySelectorAll<HTMLElement>('[data-testid^="settings-section-"]');
    const ids = new Set<string>();
    sectionEls.forEach((el) => {
      const tid = el.getAttribute('data-testid');
      if (!tid) return;
      const id = tid.replace('settings-section-', '');
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
      }
      ids.add(id);
    });

    setRenderedSectionIds((prev) => {
      if (prev && prev.size === ids.size && [...ids].every((id) => prev.has(id))) {
        return prev;
      }
      return ids;
    });
  }, []);

  useLayoutEffect(() => {
    updateRenderedSections();
    const container = contentRef.current;
    if (!container || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      updateRenderedSections();
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden'],
    });
    return () => observer.disconnect();
  }, [updateRenderedSections]);

  // 页面宽度 >= 920px 视为宽屏（有足够空间并排容纳左侧边栏目录与主设置表单）
  const isWide = containerWidth >= 920;

  const allCandidates = useMemo<SettingsNavItem[]>(() => {
    if (section !== 'general') return [];
    const list: SettingsNavItem[] = [];

    if (settingsChrome('appearance')) {
      list.push({ id: 'appearance', label: t('Interface'), Icon: LuMonitor });
    }
    list.push({ id: 'orchestration', label: t('Orchestration'), Icon: LuGitFork });

    if (settingsChrome('llm')) {
      list.push({ id: 'llm', label: t('Local model settings'), Icon: LuSettings });
    }
    if (settingsChrome('web-search')) {
      list.push({ id: 'web-search', label: t('Web search'), Icon: LuSearch });
    }
    if (settingsChrome('usage')) {
      list.push({ id: 'usage', label: t('Usage and cost'), Icon: LuChartBar });
    }
    if (settingsChrome('diagnose')) {
      list.push({ id: 'diagnose', label: t('Connection diagnostics'), Icon: LuNetwork });
    }
    if (settingsChrome('security')) {
      list.push({ id: 'security', label: t('Security'), Icon: LuShieldCheck });
    }
    if (settingsChrome('insights')) {
      list.push({ id: 'insights', label: t('Help improve the product'), Icon: LuChartBar });
    }
    if (settingsChrome('telemetry')) {
      list.push({ id: 'telemetry', label: t('Telemetry (OTLP)'), Icon: LuActivity });
    }

    const packPanels = getPackSettingsPanels();
    for (const panel of packPanels) {
      list.push({
        id: panel.panelId,
        label: panel.title,
        Icon: panel.Icon ?? LuSettings,
      });
    }

    if (isPortableEnabled()) {
      list.push({ id: 'portable', label: t('Backup and migration'), Icon: LuDownload });
    }
    if (hasHostBridge()) {
      list.push({ id: 'python-runner', label: t('Python runtime'), Icon: LuCodeXml });
    }
    if (release.version) {
      list.push({ id: 'update', label: t('Software update'), Icon: LuInfo });
    }

    return list;
  }, [section, release.version]);

  // 严格过滤：右侧实际未挂载或隐藏的分段，左侧菜单一律不显示
  const menuItems = useMemo<SettingsNavItem[]>(() => {
    if (section !== 'general') return [];
    if (renderedSectionIds !== null) {
      return allCandidates.filter((item) => renderedSectionIds.has(item.id));
    }
    return allCandidates;
  }, [section, allCandidates, renderedSectionIds]);

  const handleSelectSection = useCallback((id: string) => {
    setActiveSectionId(id);
    const target = document.querySelector(`[data-testid="settings-section-${id}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current || menuItems.length === 0) return;
    const containerTop = scrollRef.current.getBoundingClientRect().top;
    let closestId: string | null = null;
    let minDistance = Infinity;

    for (const item of menuItems) {
      const el = document.querySelector(`[data-testid="settings-section-${item.id}"]`);
      if (el) {
        const top = el.getBoundingClientRect().top - containerTop;
        if (top <= 120 && Math.abs(top) < minDistance) {
          minDistance = Math.abs(top);
          closestId = item.id;
        }
      }
    }
    if (closestId) {
      setActiveSectionId(closestId);
    }
  }, [menuItems]);

  const title = section === 'plugins' ? t('Plugins') : t('Settings');
  const pluginMeta = pluginTabMeta();

  return (
    <div ref={pageContainerRef} className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex h-9 flex-shrink-0 items-center justify-between gap-2 border-b border-agent-border px-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="shrink-0 text-xs font-semibold text-agent-foreground">{title}</h1>
          {section === 'plugins' && pluginTabs.length > 1 && (
            <div
              role="tablist"
              aria-label={t('Plugins')}
              data-testid="plugins-tabs"
              className="flex min-w-0 items-center gap-1"
            >
              {pluginTabs.map((id) => {
                const meta = pluginMeta[id];
                const active = pluginTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={`plugins-tab-${id}`}
                    onClick={() => selectPluginTab(id)}
                    className={[
                      'flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors',
                      active
                        ? 'bg-agent-foreground/10 font-medium text-agent-foreground'
                        : 'text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground',
                    ].join(' ')}
                  >
                    <meta.Icon className="h-3.5 w-3.5" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {section === 'general' && settingsChrome('llm') && (
          <SettingsSaveButton
            testId="settings-header-save"
            saving={llmSaveUi.saving}
            savedOk={llmSaveUi.savedOk}
            disabled={llmSaveUi.saving || llmSaveUi.loading}
            onClick={() => void llmPanelRef.current?.save()}
          />
        )}
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div
          className={`mx-auto px-4 py-3 ${
            isWide && menuItems.length > 0 ? 'flex max-w-5xl justify-center gap-6' : 'max-w-3xl'
          }`}
        >
          {isWide && menuItems.length > 0 ? (
            <SettingsNavMenu
              items={menuItems}
              activeId={activeSectionId ?? menuItems[0]?.id ?? null}
              onSelect={handleSelectSection}
            />
          ) : null}

          <div ref={contentRef} className="min-w-0 flex-1 max-w-3xl space-y-4">
            {!hasHostBridge() && (
              <p className="rounded-agent-md border border-agent-destructive/20 bg-agent-destructive/10 p-2.5 text-xs text-agent-destructive">
                {t('Browser preview mode: no host bridge, so some settings are unavailable.')}
              </p>
            )}

          {section === 'plugins' && (
            <>
              <p className="text-xs text-agent-muted-foreground" data-testid="plugins-summary">
                {pluginsSummary(pluginTabs)}
              </p>
              {pluginTab === 'skills' && (
                <section className="space-y-2" data-testid="settings-section-skills">
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                    <LuBlocks className="h-3.5 w-3.5 text-agent-muted-foreground" />
                    {t('Local skills')}
                  </h2>
                  <SkillsSettingsPanel />
                </section>
              )}
              {pluginTab === 'mcp' && (
                <section className="space-y-2" data-testid="settings-section-mcp">
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                    <LuPlug className="h-3.5 w-3.5 text-agent-muted-foreground" />
                    {t('MCP servers')}
                  </h2>
                  <McpSettingsPanel />
                </section>
              )}
              {pluginTab === 'agents' && (
                <section className="space-y-2" data-testid="settings-section-agents">
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                    <LuBot className="h-3.5 w-3.5 text-agent-muted-foreground" />
                    {t('Agents')}
                  </h2>
                  <AgentsSettingsPanel onCatalogChange={catalog?.refreshAgents} />
                </section>
              )}
              {pluginTab === 'web-search' && settingsChrome('web-search') && (
                <section className="space-y-2" data-testid="settings-section-web-search">
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                    <LuSearch className="h-3.5 w-3.5 text-agent-muted-foreground" />
                    {t('Web search')}
                  </h2>
                  <WebSearchSettingsPanel />
                </section>
              )}
            </>
          )}

          {section === 'general' && (
            <>
              {settingsChrome('appearance') && (
              <section className="space-y-2" data-testid="settings-section-appearance">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuMonitor className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  {t('Interface')}
                </h2>
                <AppearanceSettingsPanel />
              </section>
              )}

              <section className="space-y-2" data-testid="settings-section-orchestration">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuSettings className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  {t('Orchestration')}
                </h2>
                <OrchestrationSettingsPanel />
              </section>

              {settingsChrome('llm') && (
              <section className="space-y-2" data-testid="settings-section-llm">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuSettings className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  {t('Local model settings')}
                </h2>
                <LlmSettingsPanel
                  ref={llmPanelRef}
                  showFooterSave={false}
                  onSaveUiChange={setLlmSaveUi}
                />
              </section>
              )}

              {settingsChrome('web-search') && (
              <section className="space-y-2" data-testid="settings-section-web-search">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuSearch className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  {t('Web search')}
                </h2>
                <WebSearchSettingsPanel />
              </section>
              )}

              {settingsChrome('usage') && (
              <section className="space-y-2" data-testid="settings-section-usage">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuChartBar className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  {t('Usage and cost')}
                </h2>
                <UsagePanel />
              </section>
              )}

              {settingsChrome('diagnose') && (
              <section className="space-y-2" data-testid="settings-section-diagnose">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuNetwork className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  {t('Connection diagnostics')}
                </h2>
                <DiagnoseSettingsPanel />
              </section>
              )}

              {settingsChrome('security') && (
              <section className="space-y-2" data-testid="settings-section-security">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuShieldCheck className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  {t('Security')}
                </h2>
                <SecuritySettingsPanel />
              </section>
              )}

              {settingsChrome('insights') && (
              <section className="space-y-2" data-testid="settings-section-insights">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuChartBar className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  {t('Help improve the product')}
                </h2>
                <InsightsSettingsPanel />
              </section>
              )}

              {settingsChrome('telemetry') && (
              <section className="space-y-2" data-testid="settings-section-telemetry">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuActivity className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  {t('Telemetry (OTLP)')}
                </h2>
                <TelemetrySettingsPanel />
              </section>
              )}

              {/* 场景包设置面板（1.2 起由包渲染层贡献）。
                  包经 packs/registry 注册，未激活 flavor 的产物里没有包组件。 */}
              {getPackSettingsPanels().map((panel) => (
                <section
                  key={panel.panelId}
                  className="space-y-2"
                  data-testid={`settings-section-${panel.panelId}`}
                >
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                    {panel.Icon ? (
                      <panel.Icon className="h-3.5 w-3.5 text-agent-muted-foreground" />
                    ) : null}
                    {panel.title}
                  </h2>
                  <panel.Component />
                </section>
              ))}

              {isPortableEnabled() && (
              <section className="space-y-2" data-testid="settings-section-portable">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuDownload className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  {t('Backup and migration')}
                </h2>
                <PortableSettingsPanel />
              </section>
              )}

              <PythonRunnerSettingsPanel />
              <AppUpdateSettingsPanel />
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
