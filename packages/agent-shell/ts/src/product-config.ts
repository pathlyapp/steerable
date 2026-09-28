/**
 * 产品注入配置（3.1）：shell 不硬编码任何产品特有的端点/链接/目录名，
 * 由产品组装根（products/<id>/active.ts）在模块求值早期注入。
 *
 * 与 brand.ts 的分工：brand 是「产品身份」（显示名/自称/默认智能体），
 * 本模块是「产品资源」（遥测端点、帮助链接、数据目录）。两者都由产品
 * 组装根注入；缺省时 shell 表现为中性框架（无遥测、无帮助链接、
 * 数据目录 .agent-shell）。
 *
 * 本模块只允许依赖 node 内置模块（与 brand.ts 同约束）。
 */

export interface ProductLinks {
  /** 帮助菜单「打开发布页」URL（通常是产品的下载/更新通道页）。 */
  releasePage?: string;
  /** 帮助菜单「访问官网」URL。 */
  website?: string;
}

export interface ProductConfig {
  /**
   * 云端遥测端点（insights flush 的 API base）。空 = 不上报（中性默认）；
   * 用户设置里的 apiBase 与环境变量仍可覆盖。
   */
  insightsApiBase?: string;
  /** 帮助菜单链接；缺省的项不渲染。 */
  links?: ProductLinks;
  /**
   * 未设置 `DEEPPATH_USER_DATA_DIR` 时的 userData 目录名（~/ 下）。
   * Tauri 宿主总是注入该环境变量，不经此字段。
   */
  dataDirName?: string;
  /**
   * 主 SQLite 文件名（userData 目录下）。产品必须显式声明以保住存量
   * 数据；中性 shell 缺省 'agent-shell.db'。
   */
  dbFileName?: string;
  /**
   * 宿主工具族：产品声明引入哪些工具。缺省全开。
   * 形状由 host-tools 解析；本模块只存声明、不依赖解析器。
   */
  hostTools?: Record<string, boolean | { capability?: boolean; chrome?: boolean }>;
  /**
   * 命令安全询问：host = 弹宿主审批；off = 本轮不挂审批。缺省 host。
   * STEERABLE_APPROVAL=0 仍是调试逃生口。
   */
  approval?: 'host' | 'off';
  /**
   * 白名单外出网询问：host = 弹宿主审批；off = 自动加入当前代理会话。
   * 缺省 host。自动放行仅存活到代理进程退出，不修改持久白名单。
   */
  egressApproval?: 'host' | 'off';
  /**
   * 对话模式。缺省 `['agent','plan']`。只留一种时渲染层不显示切换。
   */
  chatModes?: Array<'agent' | 'plan'>;
  /**
   * 设置入口。缺省全开。`false` 藏对应侧栏页或综合设置分段。
   */
  settings?: Record<string, boolean>;
  /**
   * 对话与配置的导出/导入。缺省关。只有显式 `true` 的产品才有入口和接口。
   */
  portable?: boolean;
  /**
   * 产品钉死的大模型。`settings.llm === false` 时必填，运行时用这份，
   * 不再读设置页。密钥用 `apiKeyEnv` 指向环境变量，不要把 key 写进仓库。
   */
  llm?: {
    provider?: string;
    vendorId?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    temperature?: number;
    maxTotalTokens?: number;
  };
  /**
   * shell 内置智能体。按需引入，缺省全关。
   * `true` 才种子；未声明或 `false` 不写入，已有行归档。
   */
  builtinAgents?: Partial<Record<'local-assistant' | 'all-round-assistant', boolean>>;
  /**
   * shell 内置技能。按需引入，缺省全关。
   * `true` 引入全部；对象里 `true` 的目录才引入。设置页入口不受影响。
   */
  builtinSkills?: boolean | Partial<Record<string, boolean>>;
  /**
   * 产品预置 MCP 服务。按需引入，缺省空。已有同名服务不覆盖。
   * 设置页入口不受影响。
   */
  builtinMcp?: Array<
    | {
        name: string;
        transport?: 'stdio';
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        enabled?: boolean;
      }
    | {
        name: string;
        transport: 'streamable-http';
        url: string;
        headers?: Record<string, string>;
        headersFromEnv?: Record<string, string>;
        bearerTokenEnvVar?: string;
        enabled?: boolean;
      }
  >;
  /**
   * P3.1 多智能体编排六件套 (agent_spawn / agent_wait / agent_send / agent_interrupt / agent_close / agent_list)。
   * 缺省关（仅开 delegate_subagent）；设为 true 或配置对象时在回合中启用。
   * STEERABLE_ORCHESTRATION 环境变量（'1' 开启，'0' 显式关闭）优先级更高。
   */
  orchestration?: boolean | { enabled?: boolean; maxDepth?: number; maxParallel?: number };
  /**
   * 界面语言。缺省只有 `en`。译文在应用层语言包，不在本包。
   * `locales` 是这个产品装进包里的语言；多于一种时设置页才出现切换。
   */
  i18n?: {
    locales: string[];
    defaultLocale: string;
  };
}

/** shell 内置智能体：只有产品显式 `true` 才开。 */
export function isShellBuiltinAgentEnabled(
  id: 'local-assistant' | 'all-round-assistant',
  config: ProductConfig = getProductConfig(),
): boolean {
  return config.builtinAgents?.[id] === true;
}

/** 对话与配置能否导出/导入。缺省关，产品必须显式打开。 */
export function isPortableProduct(config: ProductConfig = getProductConfig()): boolean {
  return config.portable === true;
}

/** shell 内置技能：`true` 全开；否则只有对象里显式 `true` 的目录开。 */
export function isShellBuiltinSkillEnabled(
  id: string,
  config: ProductConfig = getProductConfig(),
): boolean {
  const value = config.builtinSkills;
  if (value === true) return true;
  if (!value || typeof value !== 'object') return false;
  return value[id] === true;
}

let productConfig: ProductConfig | null = null;

/**
 * 注入产品配置（产品组装根在第一个 import 时调用）。重复注入抛错
 * （组装期笔误，fail fast——与 setProductBrand 同语义）。
 */
export function setProductConfig(config: ProductConfig): void {
  if (productConfig) {
    throw new Error('[product-config] product config already set');
  }
  productConfig = config;
}

/** 读取已注入的产品配置；未注入返回空对象（中性框架行为）。 */
export function getProductConfig(): ProductConfig {
  return productConfig ?? {};
}

/** 测试用：清掉已注入的产品配置，避免用例互相污染。 */
export function resetProductConfigForTests(): void {
  productConfig = null;
}
