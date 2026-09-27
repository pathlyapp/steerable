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
import { isElectron } from '@/lib/electron-bridge';
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

type SettingsSection = 'skills' | 'mcp' | 'agents' | 'general';

function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'skills' && settingsChrome('skills')) return 'skills';
  if (raw === 'mcp' && settingsChrome('mcp')) return 'mcp';
  if (raw === 'agents' && settingsChrome('agents')) return 'agents';
  return 'general';
}

/**
 * `/settings` — 右侧内容区的设置页，按 `?section=` 分成独立页面：
 *   - `skills`  侧栏「Skill 设置」
 *   - `mcp`     侧栏「MCP 设置」
 *   - `agents`  侧栏「智能体管理」
 *   - 缺省/`general`  侧栏底「设置」（界面 / 模型 / 搜索 / 用量 / 安全 / 洞察 / 遥测 / 关于）
 *
 * Panel 数据自管理（挂载即拉取），页面本身不持有后端状态。
 */
export function SettingsPage() {
  const [searchParams] = useSearchParams();
  const section = resolveSection(searchParams.get('section'));
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
      list.push({ id: 'appearance', label: '界面', Icon: LuMonitor });
    }
    list.push({ id: 'orchestration', label: '协同编排', Icon: LuGitFork });

    if (settingsChrome('llm')) {
      list.push({ id: 'llm', label: '本地模型设置', Icon: LuSettings });
    }
    if (settingsChrome('web-search')) {
      list.push({ id: 'web-search', label: '网络搜索', Icon: LuSearch });
    }
    if (settingsChrome('usage')) {
      list.push({ id: 'usage', label: '用量与成本', Icon: LuChartBar });
    }
    if (settingsChrome('diagnose')) {
      list.push({ id: 'diagnose', label: '链路诊断', Icon: LuNetwork });
    }
    if (settingsChrome('security')) {
      list.push({ id: 'security', label: '安全', Icon: LuShieldCheck });
    }
    if (settingsChrome('insights')) {
      list.push({ id: 'insights', label: '帮助改进产品', Icon: LuChartBar });
    }
    if (settingsChrome('telemetry')) {
      list.push({ id: 'telemetry', label: '遥测(OTLP)', Icon: LuActivity });
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
      list.push({ id: 'portable', label: '备份与迁移', Icon: LuDownload });
    }
    if (isElectron()) {
      list.push({ id: 'python-runner', label: 'Python 运行环境', Icon: LuCodeXml });
    }
    if (release.version) {
      list.push({ id: 'update', label: '软件更新', Icon: LuInfo });
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

  const title =
    section === 'mcp'
      ? 'MCP 设置'
      : section === 'skills'
        ? 'Skill 设置'
        : section === 'agents'
          ? '智能体管理'
          : '设置';

  return (
    <div ref={pageContainerRef} className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex h-9 flex-shrink-0 items-center justify-between gap-2 border-b border-agent-border px-2.5">
        <h1 className="text-xs font-semibold text-agent-foreground">{title}</h1>
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
            {!isElectron() && (
              <p className="rounded-agent-md border border-agent-destructive/20 bg-agent-destructive/10 p-2.5 text-xs text-agent-destructive">
                浏览器预览模式 — 没有 Electron IPC 桥接，部分设置不可用。
              </p>
            )}

          {section === 'skills' && (
            <section className="space-y-2" data-testid="settings-section-skills">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                <LuBlocks className="h-3.5 w-3.5 text-agent-muted-foreground" />
                本地技能
              </h2>
              <SkillsSettingsPanel />
            </section>
          )}

          {section === 'mcp' && (
            <section className="space-y-2" data-testid="settings-section-mcp">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                <LuPlug className="h-3.5 w-3.5 text-agent-muted-foreground" />
                MCP 服务
              </h2>
              <McpSettingsPanel />
            </section>
          )}

          {section === 'agents' && (
            <section className="space-y-2" data-testid="settings-section-agents">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                <LuBot className="h-3.5 w-3.5 text-agent-muted-foreground" />
                智能体
              </h2>
              <AgentsSettingsPanel onCatalogChange={catalog?.refreshAgents} />
            </section>
          )}

          {section === 'general' && (
            <>
              {settingsChrome('appearance') && (
              <section className="space-y-2" data-testid="settings-section-appearance">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuMonitor className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  界面
                </h2>
                <AppearanceSettingsPanel />
              </section>
              )}

              <section className="space-y-2" data-testid="settings-section-orchestration">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuSettings className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  协同编排
                </h2>
                <OrchestrationSettingsPanel />
              </section>

              {settingsChrome('llm') && (
              <section className="space-y-2" data-testid="settings-section-llm">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuSettings className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  本地模型设置
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
                  网络搜索
                </h2>
                <WebSearchSettingsPanel />
              </section>
              )}

              {settingsChrome('usage') && (
              <section className="space-y-2" data-testid="settings-section-usage">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuChartBar className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  用量与成本
                </h2>
                <UsagePanel />
              </section>
              )}

              {settingsChrome('diagnose') && (
              <section className="space-y-2" data-testid="settings-section-diagnose">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuNetwork className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  链路诊断
                </h2>
                <DiagnoseSettingsPanel />
              </section>
              )}

              {settingsChrome('security') && (
              <section className="space-y-2" data-testid="settings-section-security">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuShieldCheck className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  安全
                </h2>
                <SecuritySettingsPanel />
              </section>
              )}

              {settingsChrome('insights') && (
              <section className="space-y-2" data-testid="settings-section-insights">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuChartBar className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  帮助改进产品
                </h2>
                <InsightsSettingsPanel />
              </section>
              )}

              {settingsChrome('telemetry') && (
              <section className="space-y-2" data-testid="settings-section-telemetry">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
                  <LuActivity className="h-3.5 w-3.5 text-agent-muted-foreground" />
                  遥测(OTLP)
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
                  备份与迁移
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
