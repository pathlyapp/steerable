/**
 * 渲染层包贡献类型（ScenarioPack.renderer 的 web 侧契约）。
 *
 * 注册表实现住在宿主 apps/web/src/packs/registry.ts（re-export 本模块类型
 * 兼容既有调用方）；包的 web 代码只应依赖本模块，不反向 import 宿主实现。
 */

import type { ComponentType } from 'react';

export interface PackRouteContribution {
  /** hash 路由路径（不带前导斜杠），如 '<pack>-debug-log'。 */
  readonly path: string;
  readonly Component: ComponentType;
}

export interface PackSettingsPanelContribution {
  readonly panelId: string;
  readonly title: string;
  /** 段头图标（react-icons 组件）；缺省段头只显示标题文字。 */
  readonly Icon?: ComponentType<{ className?: string }>;
  readonly Component: ComponentType;
}

/** 聊天页右侧栏位面板的标准 props（shell 布局注入）。 */
export interface PackChatSlotProps {
  /** 当前打开的会话 id（无会话时为空串）。 */
  chatId: string;
  /** 当前标签 id。一个槽位可以按资源打开多个不同的标签。 */
  tabId?: string;
  /** 动态标签绑定的内容身份；静态槽位标签没有这一项。 */
  contentId?: string;
  /** 更新当前标签的显示标题，不改变内容身份。 */
  onTitleChange?: (title: string) => void;
  /** 关闭栏位（用户点面板右上角 ×）。 */
  onClose: () => void;
  /**
   * 把一段内容作为普通用户消息发进当前会话（包的 fallback 逃生通道，
   * 如文档包的单页修改在 sidecar 未就绪时退回主聊天发送）。未注册时返回 false。
   */
  onSubmitToChat: (input: {
    content: string;
    metadata?: Record<string, unknown>;
  }) => boolean | void | Promise<boolean | void>;
}

export interface PackChatSlotTarget {
  /** 文件完整地址、浏览器会话 id 等稳定内容身份。 */
  contentId?: string;
  /** 该标签的初始显示标题。 */
  title?: string;
}

/** 自动展开钩子拿到的布局 API。 */
export interface PackChatSlotAutoRevealApi {
  /** 请求把本槽位加进右侧标签。栏位空着时显示它；已有别的标签时只追加，不抢走当前标签。 */
  reveal: (target?: PackChatSlotTarget) => void;
  /** 当前会话 id（事件载荷据此过滤）。 */
  getCurrentChatId: () => string | null;
}

export interface PackChatSlotContribution {
  readonly slotId: string;
  /** 侧栏分段控件上的短名（如 'PPT 预览'）。 */
  readonly title: string;
  /** 分段控件图标（react-icons 组件）。 */
  readonly Icon: ComponentType<{ className?: string }>;
  /** 面板本体；shell 布局注入 {@link PackChatSlotProps}。 */
  readonly Component: ComponentType<PackChatSlotProps>;
  /** 加号每次创建独立内容实例；缺省时同 kind 只有一个静态内容。 */
  readonly multiple?: boolean;
  /** 切走后仍保持 React body 挂载；适合浏览器等实时页面。 */
  readonly keepMounted?: boolean;
  /** 静态打开或旧状态迁移时使用的内容身份；缺省为 slotId。 */
  readonly defaultContentId?: string;
  /** `multiple` 类型从加号新建实例时生成内容身份。 */
  readonly createContentId?: () => string;
  /** 用户关闭标签后释放该内容在宿主侧的资源。 */
  readonly onContentClosed?: (input: { chatId: string; contentId: string }) => void;
  /**
   * 自动展开：布局挂载时调用一次，包实现自己的事件订阅（桥接事件），
   * 命中当前会话时调 reveal()。返回 cleanup（布局卸载时调用）。
   */
  readonly setupAutoReveal?: (api: PackChatSlotAutoRevealApi) => (() => void) | void;
}

export interface PackRendererContributions {
  readonly routes?: readonly PackRouteContribution[];
  readonly settingsPanels?: readonly PackSettingsPanelContribution[];
  readonly chatSlots?: readonly PackChatSlotContribution[];
  /**
   * 包技能里由引擎自动注入、不进 "/" 菜单的技能名/目录名
   * （并入 slash-sources 的隐藏集，如某包的 90-<pack>）。
   */
  readonly hiddenSlashSkills?: readonly string[];
}
