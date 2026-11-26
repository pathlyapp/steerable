/**
 * @steerable/pack-sdk —— 场景智能体包契约（纯类型，零运行时）。
 *
 * 一个「场景包」把一个垂直场景（如某行业的专业工具链……）需要的全部
 * 扩展声明集中在一处：Node 宿主服务/工具/表/技能/智能体种子/HTTP 路由、
 * 渲染层插槽、品牌与打包覆盖。宿主（Tauri 监督的 Node 宿主与 BS
 * headless server）按产品组装时选中的包集合，逐个槽位消费这些声明。
 *
 * 设计约束：
 *  - 本包是零依赖纯类型：不允许 import 宿主内部模块（tool-router、
 *    storage 等），否则宿主消费接口时会形成循环依赖。宿主侧类型
 *    （ToolMode 等）的单一真源在本包，宿主模块 re-export 兼容。
 *  - 槽位只开有真实场景代码论证的（既有场景包 diff 的并集），
 *    不凭空膨胀。新槽位 = 新场景的真实需求驱动。
 *  - 组合发生在构建期：产品的 composition root 静态 import 自己的包；
 *    渲染层不做运行时动态加载。
 *
 * 渲染层贡献类型在 './web' 子路径（依赖 React 类型，主进程侧勿引）。
 *
 * 槽位集合由真实场景包（应用仓库内）的 diff 并集论证。
 */

/** 场景 id。开放字符串（不再是二值联合）。 */
export type ScenarioId = string;

/** 触发当前请求或回合的入口渠道。 */
export type OriginChannel = 'desktop' | 'web' | 'cli' | 'im' | 'webhook';

/** 宿主解析并认证后的产品中立请求身份。 */
export interface Principal {
  readonly id: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly roles: readonly string[];
  readonly isAdmin: boolean;
  readonly externalId?: string | null;
  readonly attrs?: Readonly<Record<string, string>>;
}

/** 凭证代管注入载荷（明文仅注入底层传输层，工具返回与日志自动脱敏）。 */
export interface CredentialInjection {
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly env?: Record<string, string>;
}

/** 注入给场景包工具的受控凭证解析客户端。 */
export interface PackCredentialClient {
  resolve(sourceId: string): Promise<CredentialInjection | null>;
  fetch(
    sourceId: string,
    url: string | URL,
    init?: RequestInit,
  ): Promise<Response>;
}

/** 场景包声明的外部数据源与凭证需求（兼支持 R1 加密凭据与 R4 `$source` 只读查询）。 */
export interface PackDataSource {
  readonly id: string;
  readonly label?: Readonly<Record<string, string>>;
  readonly authKind?: 'bearer' | 'basic' | 'header' | 'oauth2' | 'custom_env';
  readonly scope?: 'tenant' | 'user';
  readonly requiredRoles?: readonly string[];
  readonly description?: Readonly<Record<string, string>>;
  readonly query?: (
    params: Record<string, unknown>,
    ctx: {
      readonly principal: Principal;
      readonly chatId: string;
    },
  ) => Promise<unknown>;
}

/** 交付物质检问题条目。 */
export interface VerifierIssue {
  readonly severity: 'blocking' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly location?: string;
}

/** 交付物质检结论。 */
export interface DeliverableVerificationResult {
  readonly status: 'verified' | 'warnings' | 'failed';
  readonly issues: readonly VerifierIssue[];
  readonly summary?: string;
  readonly reportPath?: string;
}

/** 交付物完成定义与质检钩子（R5）。 */
export interface DeliverableVerifier {
  readonly id: string;
  readonly matchExtensions?: readonly string[];
  readonly matchMimeTypes?: readonly string[];
  verify(ctx: {
    readonly filePath: string;
    readonly chatId: string;
    readonly principal: Principal;
    readonly executedActions: readonly {
      readonly id?: string;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
      readonly success: boolean;
    }[];
  }): Promise<DeliverableVerificationResult>;
}

/** 声明式工作台实时数据源绑定（R4）。 */
export interface UiSurfaceSourceBinding {
  readonly tool: string;
  readonly args?: Record<string, unknown>;
  readonly label?: Readonly<Record<string, string>>;
}

/** 声明式工作台受控写动作（仅允许引用已注册写工具）。 */
export interface UiSurfaceActionSpec {
  readonly id: string;
  readonly label: Readonly<Record<string, string>>;
  readonly tool: string;
  readonly checkpoint?: 'standard' | 'outward';
  readonly staticArgs?: Record<string, unknown>;
}

/** 声明式工作台字段/区块节点（纯 JSON 受控组件树，禁止 HTML/脚本字符串）。 */
export type UiSurfaceNodeSpec =
  | {
      readonly kind: 'metric';
      readonly id: string;
      readonly label: Readonly<Record<string, string>>;
      readonly sourceKey: string;
      readonly path?: string;
    }
  | {
      readonly kind: 'table';
      readonly id: string;
      readonly label: Readonly<Record<string, string>>;
      readonly sourceKey: string;
      readonly columns: readonly { readonly key: string; readonly label: Readonly<Record<string, string>> }[];
    }
  | {
      readonly kind: 'input';
      readonly id: string;
      readonly name: string;
      readonly label: Readonly<Record<string, string>>;
      readonly inputType?: 'text' | 'number' | 'select' | 'checkbox';
      readonly required?: boolean;
      readonly defaultValue?: string | number | boolean;
      readonly options?: readonly { readonly value: string; readonly label: Readonly<Record<string, string>> }[];
    }
  | {
      readonly kind: 'callout';
      readonly id: string;
      readonly tone?: 'info' | 'warning' | 'danger';
      readonly text: Readonly<Record<string, string>>;
    };

/** 会话级声明式工作台规范（R4）。 */
export interface UiSurfaceSpec {
  readonly surfaceId: string;
  readonly title: Readonly<Record<string, string>>;
  readonly summary?: Readonly<Record<string, string>>;
  readonly sources?: Readonly<Record<string, UiSurfaceSourceBinding>>;
  readonly nodes: readonly UiSurfaceNodeSpec[];
  readonly actions?: readonly UiSurfaceActionSpec[];
}

/** 第二层 Agent Profile（角色提示词、默认工具集与技能编排，R3）。 */
export interface AgentProfileSpec {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly rolePrompt: string;
  readonly forbiddenPrompt?: string;
  readonly defaultTools?: readonly string[];
  readonly skillIds?: readonly string[];
  readonly preferredModel?: string;
}

/** 未登录启动门公开认证方式描述（R3）。 */
export type PublicAuthMethod =
  | { readonly kind: 'password'; readonly showTenantSlugInput: boolean }
  | {
      readonly kind: 'oidc';
      readonly providerId: string;
      readonly label: string;
      readonly authorizePath: string;
    }
  | {
      readonly kind: 'sso_proxy';
      readonly label: string;
      readonly loginUrl: string;
    };

/** 未登录可读取的公开启动配置载荷（GET /api/v2/auth/bootstrap）。 */
export interface PublicBootstrapPayload {
  readonly productName: string;
  readonly authRequired: boolean;
  readonly authMethods: readonly PublicAuthMethod[];
  readonly iamMode?: string;
  readonly defaultApplicationId?: string;
  readonly safeMode?: boolean;
}

/** 第三层 Application 应用形态（默认工作台、导航裁剪与登录引导，R3）。 */
export interface ApplicationManifest {
  readonly id: string;
  readonly title: Readonly<Record<string, string>>;
  readonly defaultAgentProfileId: string;
  readonly allowedPackIds: readonly ScenarioId[];
  readonly defaultWorkbenchTabs?: readonly ('preview' | 'workbench' | 'terminal' | 'fact_chain')[];
  readonly hiddenNavItems?: readonly ('skills' | 'mcp' | 'agents' | 'terminal')[];
  readonly bootstrapAuthMethods?: readonly ('password' | 'oidc' | 'sso_proxy')[];
}

/**
 * 工具安全分级与曝光层。这两个枚举的单一真源在本包（0.3a 从
 * tool-router.ts 迁入）；tool-router re-export 兼容既有调用方。
 */
export type ToolMode =
  | 'read'
  | 'ui'
  | 'synthetic'
  | 'safe_write'
  | 'destructive'
  | 'local'
  | 'external'
  | 'auto_local';

export type ToolExposure = 'direct' | 'deferred' | 'hidden';

/**
 * 会话与本机审批记录的分组。同一 `category` 共享「本会话」「始终」决定。
 * `category` 匹配 `^[a-z][a-z0-9_]{0,63}$`，且不得与内置类别
 * `network_egress`、`sandbox_escalation` 同名；宿主在装配时校验。
 */
export interface ToolApprovalSpec {
  readonly category: string;
  /** 审批卡上的类别显示名，由包提供本地化文本。 */
  readonly label: Readonly<Record<string, string>>;
}

/**
 * 工具执行上下文（与宿主 ToolExecContext 结构对齐的最小声明）。
 * 宿主在分发时注入；包不应假设字段以外的任何宿主状态。
 */
export interface PackToolContext {
  /** 项目模式沙箱根；非空时文件/shell 工具必须落在根内。 */
  projectRoot?: string | null;
  /** 调用发生的 chat id；任务类工具按它归组。 */
  chatId?: string;
  /** 宿主认证身份（本地/单机默认注入 LOCAL_DEFAULT_PRINCIPAL）。 */
  principal?: Principal;
  /** 触发当前回合的入口渠道。 */
  originChannel?: OriginChannel;
  /** 受控凭证代管解析客户端（明文不出工具上下文与 trace）。 */
  credentials?: PackCredentialClient;
}

/** 工具 handler：接收模型 JSON 参数与调用上下文，返回可 JSON 序列化的结果。 */
export type PackToolHandler = (
  args: Record<string, unknown>,
  context: PackToolContext,
) => Promise<unknown>;

/** 一个模型可见工具的贡献：schema + 执行体。 */
export interface ToolContribution {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly mode: ToolMode;
  /** 缺省 'direct'。 */
  readonly exposure?: ToolExposure;
  /** 缺省时审批类别等于工具名。 */
  readonly approval?: ToolApprovalSpec;
  /**
   * 幂等性声明：非幂等写工具（idempotent === false）一旦越过执行前校验进入
   * 分发，超时或未知异常归类为 outcome_unknown 并阻断同名工具重试。
   */
  readonly idempotent?: boolean;
  /**
   * 签批等级：'outward' 强制逐次人类确认（禁止本会话/始终记住与 CLI 静默放行）。
   */
  readonly checkpoint?: 'standard' | 'outward';
  readonly handler: PackToolHandler;
}

/**
 * 主进程长驻领域服务（如 DomainService / DocumentEditService）。
 * 宿主在装配期调用 create，把返回值交给包内工具/路由使用；
 * 宿主不感知服务类型——包内部通过闭包共享。
 */
export interface ServiceFactory {
  readonly serviceId: string;
  /** 装配上下文目前只承诺 broadcast；需要更多宿主能力时在这里加字段。 */
  readonly create: (ctx: ServiceCreateContext) => unknown;
  /** 可选关停钩子；宿主退出时按注册逆序调用。 */
  readonly dispose?: (service: unknown) => void | Promise<void>;
}

export interface ServiceCreateContext {
  /** 向用户面广播事件（SSE 总线）。 */
  broadcast: (channel: string, payload: unknown) => void;
}

/**
 * SQLite 迁移：一串 DDL 语句（CREATE TABLE/INDEX IF NOT EXISTS …），
 * 宿主在建库迁移阶段按包声明顺序执行。表名必须带包前缀（<pack>_*
 * ppt_*），跨包不许共享表。
 */
export interface MigrationContribution {
  /** Monotonic migration generation persisted by the selected driver. */
  readonly version?: number;
  /** Table creation required before incremental column checks. */
  readonly beforeDdl?: readonly string[];
  /** DDL 语句（CREATE TABLE/INDEX IF NOT EXISTS …），合并为一次 exec 执行。 */
  readonly ddl?: readonly string[];
  /** 增量列迁移（已有库的 ALTER TABLE ADD COLUMN，列已存在则跳过）。 */
  readonly ensureColumns?: readonly { table: string; column: string; type: string }[];
}

/** 技能贡献：包内一个含 SKILL.md 的目录，构建期拷入产物技能根。 */
export interface SkillContribution {
  /** 相对包根的目录路径（目录名即技能 id，如 '90-<pack>'）。 */
  readonly dir: string;
}

/**
 * 内置智能体种子的历史身份：名字 + 提示词开头（+ 可选描述），用于识别
 * 「从未被用户改过」的内置行——改过的行永远保留用户定制。
 */
export interface AgentSeedIdentity {
  readonly name: string;
  /** 缺省表示「描述与当前代一致」才算未定制。 */
  readonly description?: string;
  /** 历史代 rolePrompt 只做前缀匹配（旧文案可能被后续版本续写）。 */
  readonly rolePromptHead: string;
}

/**
 * 内置智能体种子。宿主在包在场时种子/按 previousIdentities 静默升级、
 * 包缺席且用户从未定制过时归档；改过的行永远保留用户定制。
 */
export interface AgentSeed {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly icon?: string;
  readonly color?: string;
  readonly description?: string;
  readonly rolePrompt: string;
  readonly forbiddenPrompt?: string;
  readonly skillIds?: readonly string[];
  readonly loadAllSkills?: boolean;
  /**
   * 列表位置。0 = 主打智能体：宿主默认智能体在出厂状态下让位到 1
   * （双方都未脱离出厂位置才交换，用户调过序不动）。
   */
  readonly sortOrder?: number;
  readonly previousIdentities?: readonly AgentSeedIdentity[];
}

/** HTTP 路由贡献（/host/<packId>/* 命名空间，见 host/http-routes.ts）。 */
export interface HttpRouteContribution {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 路径模式，如 '/api/v2/ppt-edits/:id'。必须带包前缀路径段。 */
  readonly path: string;
  readonly handler: (req: HttpRouteRequest) => Promise<unknown>;
}

export interface HttpRouteRequest {
  readonly params: Record<string, string>;
  readonly query: Record<string, string>;
  readonly body: unknown;
  readonly principal?: Principal;
  readonly originChannel?: OriginChannel;
}

/** 主进程面贡献集合。 */
export interface MainContribution {
  readonly services?: readonly ServiceFactory[];
  readonly tools?: readonly ToolContribution[];
  readonly migrations?: readonly MigrationContribution[];
  readonly skills?: readonly SkillContribution[];
  readonly agentSeeds?: readonly AgentSeed[];
  readonly httpRoutes?: readonly HttpRouteContribution[];
  readonly dataSources?: readonly PackDataSource[];
  readonly deliverableVerifiers?: readonly DeliverableVerifier[];
  readonly agentProfiles?: readonly AgentProfileSpec[];
  readonly applications?: readonly ApplicationManifest[];
}

/**
 * 渲染层组件引用。主进程侧不依赖 React，这里用结构化最小类型；
 * 渲染层注册表（apps/web）消费时收窄到具体组件类型。
 */
export type ComponentRef = unknown;

export interface SettingsPanelContribution {
  readonly panelId: string;
  readonly title: string;
  readonly component: ComponentRef;
}

export interface RouteContribution {
  /** hash 路由路径，如 '/<pack>-debug-log'。 */
  readonly path: string;
  readonly component: ComponentRef;
  /** 独立窗口（无侧栏）还是嵌进 AgentLayout。 */
  readonly standalone?: boolean;
}

export interface ChatSlotContribution {
  readonly slotId: string;
  readonly component: ComponentRef;
}

/** 消息卡片渲染器：按工具名/块类型匹配。 */
export interface CardRendererContribution {
  readonly match: string;
  readonly component: ComponentRef;
}

/** 渲染层面贡献集合。 */
export interface RendererContribution {
  readonly settingsPanels?: readonly SettingsPanelContribution[];
  readonly routes?: readonly RouteContribution[];
  readonly chatSlots?: readonly ChatSlotContribution[];
  readonly cardRenderers?: readonly CardRendererContribution[];
}

/** 品牌规格：运行时文案与默认智能体。 */
export interface BrandSpec {
  /** UI 显示名：窗口标题、通知标题等。 */
  readonly displayName: string;
  /**
   * 品牌锁头里 logo 旁的标题。省略则只显示 logo，并按原比例缩放。
   * 一体字标（图形+文字已在 logo 里）不要配此项。
   */
  readonly title?: string;
  /** LLM 身份自称（系统提示词里用）。 */
  readonly agentName: string;
  /** 一句话定位（fallback prompt 用）。 */
  readonly tagline: string;
  /**
   * 新对话落地页 / 空会话首屏副文案。省略用 shell 默认句；
   * 空字符串表示不显示。只进渲染层，不进系统提示词。
   */
  readonly homeHint?: string;
  /** 新对话未显式选智能体时绑定的内置智能体 id。 */
  readonly defaultAgentId: string;
}

/**
 * 包贡献给产品命令行的一个子命令。产品组装根在启动 CLI 时注册。
 * `request` 走进程内宿主，和桌面版同一套路由。
 */
export interface CliCommandIO {
  write(text: string): void;
  writeError(text: string): void;
  request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }>;
}

export interface CliCommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly run: (args: readonly string[], io: CliCommandIO) => number | Promise<number>;
}

/** 打包覆盖：产品组装期消费，不进运行时。 */
export interface PackagingSpec {
  readonly appId: string;
  readonly productName: string;
  /** 发布产物目录名（release-<x>）与下载通道段。 */
  readonly artifactDirName: string;
  readonly downloadChannel: string;
  /** 包需要额外打进产物的资源（相对包根）。 */
  readonly extraResources?: readonly string[];
}

/**
 * 场景包契约。所有槽位可选；一个包至少要有 brand（纯品牌产品）
 * 或一个实质贡献槽。
 */
export interface ScenarioPack {
  readonly id: ScenarioId;
  readonly brand: BrandSpec;
  readonly main?: MainContribution;
  readonly renderer?: RendererContribution;
  readonly packaging?: PackagingSpec;
  /** 命令行子命令。产品组装根注册后，由 agent-cli 在内置命令之后分发。 */
  readonly cliCommands?: () => readonly CliCommandSpec[];
}

// ─── local-backend 包路由（/api/v2/<包前缀>/*）契约 ───
// 注册表实现住在宿主 src/local-backend/pack-backend-routes.ts；这里只放类型。

/** 包路由响应：与宿主 router 的 LocalBackendResponse 结构对齐。 */
export interface PackBackendRouteResponse<T = unknown> {
  status: number;
  data: T;
}

/** 二进制文件流响应：由宿主 HTTP 层按字节流式输出并自动支持 Range 206。 */
export interface PackBackendBinaryFileResponse {
  readonly status: number;
  readonly kind: 'file';
  readonly filePath: string;
  readonly contentType: string;
  readonly fileName?: string;
  readonly cacheControl?: string;
  readonly etag?: string;
}

/** 内存二进制响应：由宿主 HTTP 层直接输出字节，不经过 JSON/base64 编码。 */
export interface PackBackendBinaryBytesResponse {
  readonly status: number;
  readonly kind: 'bytes';
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly fileName?: string;
  readonly cacheControl?: string;
}

export type PackBackendBinaryResponse =
  | PackBackendBinaryFileResponse
  | PackBackendBinaryBytesResponse;

export type PackBackendAnyResponse<T = unknown> =
  | PackBackendRouteResponse<T>
  | PackBackendBinaryResponse;

/** 包路由请求：段参数 + query + 反序列化后的 body。 */
export interface PackBackendRouteRequest {
  readonly params: Record<string, string>;
  /** URL query（searchParams 原样透传，多值键取逗号拼接语义同 URL 规范）。 */
  readonly query: URLSearchParams;
  readonly body: unknown;
  /** 原始请求头（HTTP 模式下透传，便于检查 Range / If-None-Match）。 */
  readonly headers?: Record<string, string | string[] | undefined>;
  /** 宿主认证身份（本地/单机默认注入 LOCAL_DEFAULT_PRINCIPAL）。 */
  readonly principal?: Principal;
  /** 触发当前请求的入口渠道。 */
  readonly originChannel?: OriginChannel;
}

export interface PackBackendRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 路径模式，如 '/api/v2/ppt-preview/edits/:id/cancel'。 */
  readonly path: string;
  readonly handler: (req: PackBackendRouteRequest) => Promise<PackBackendAnyResponse>;
}

// ─── 回合级钩子契约 ───
// 注册表实现住在宿主 src/local-backend/pack-turn-hooks.ts；这里只放类型。

/** 一条正在流式的回合的包侧观察器（beginTurn 的返回值）。 */
export interface PackTurnObserver {
  /** 模型发起一次工具调用（尚未执行）。 */
  onToolStart?(call: { tool: string; arguments: unknown }): void;
  /** 一次工具调用执行完毕（结果已进 executedActions）。 */
  onToolSettled?(): void | Promise<void>;
}

export interface PackTurnHooks {
  /** 回合 exec 沙箱的额外可写根（按会话解析）。 */
  execWritableRoots?(chatId: string): string[];
  /** 并入 buildWorldState 的附加字段（如 ppt_workspace）。 */
  worldState?(chatId: string): Record<string, unknown>;
  /** 强制技能正文（"/技能名" 一次性注入）的额外占位符变量。 */
  forcedSkillVars?(chatId: string): Record<string, string>;
  /**
   * 回合开始时调用；返回 null 表示本回合不观察。broadcast 是宿主的用户面
   * 事件出口（CS=窗口广播，BS=SSE），包观察器经它推自己的更新事件。
   */
  beginTurn?(ctx: {
    chatId: string;
    broadcast: ((channel: string, payload: unknown) => void) | undefined;
  }): PackTurnObserver | null;
}
