import type {
  HostBridge,
  LocalBackendRequestInput,
  LocalBackendStreamEvent,
} from './host-bridge';
import type {
  CatalogProviderDescriptor,
  ChatAgentWriteInput,
  ChatLiveStream,
  GatewayModelEntry,
  LocalChat,
  LocalChatAgent,
  LocalChatMessage,
  LocalProject,
  LlmSettings,
} from './local-api';
import { pickDefaultAgentId } from '@/brand';
import { isDemoMode } from './demo-flag';
import { buildPlaybookScript, DEMO_SAMPLE_FILES } from './demo-playbook';
import browserDevData from '../fixtures/browser-dev-data.json';

type MutableChat = LocalChat & { forkedFrom?: { chatId: string; title: string } | null };
type MutableMessage = LocalChatMessage;

interface BrowserDevFixture {
  version?: number;
  exportedAt?: string | null;
  source?: string | null;
  agents?: LocalChatAgent[];
  projects?: LocalProject[];
  chats?: MutableChat[];
  messagesByChatId?: Record<string, MutableMessage[]>;
  llmSettings?: LlmSettings | null;
  skills?: Array<{ name: string; description: string; builtin?: boolean }>;
}

interface ActiveStreamRecord {
  streamId: string;
  chatId: string;
  timers: number[];
  onEvent: (payload: LocalBackendStreamEvent) => void;
  steerNote: string | null;
  snapshot: ChatLiveStream;
}

interface BrowserMockState {
  agents: LocalChatAgent[];
  projects: LocalProject[];
  chats: MutableChat[];
  messagesByChatId: Record<string, MutableMessage[]>;
  llmSettings: LlmSettings;
  webSearchSettings: { provider: 'ddg' | 'tavily'; apiKey: string };
  telemetrySettings: { endpoint: string; privacyMode: 'metadata' | 'full'; serviceName: string };
  insightsSettings: {
    installId: string;
    shareBehavior: boolean;
    shareConversation: boolean;
    shareProfile: boolean;
    promptedAt: string;
    profile: { displayName: string; email: string; company: string; note: string };
    stats: { events: number; turns: number; profile: number; pending: number };
  };
  mcpServers: Array<Record<string, unknown>>;
  skills: Array<{ name: string; description: string; builtin?: boolean }>;
  activeStreams: Map<string, ActiveStreamRecord>;
  source: 'fixture' | 'fallback';
  fixtureMeta: Pick<BrowserDevFixture, 'exportedAt' | 'source'> | null;
}

const suggestedReplyListeners = new Set<
  (payload: { chatId: string; messageId: string; suggestions: string[] }) => void
>();
const chatTitleListeners = new Set<(payload: { chatId: string; title: string }) => void>();
const chatActivityListeners = new Set<(payload: { chatId: string; updatedAt: string }) => void>();
const chatCreatedListeners = new Set<
  (payload: { chatId: string; agentId?: string | null }) => void
>();

const DEMO_MODELS: GatewayModelEntry[] = [
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    window: 128_000,
    modalities: ['text'],
    reasoningLevels: ['low', 'medium', 'high', 'max'],
    pricing: { promptPerMtok: 0.14, completionPerMtok: 0.56 },
    joinedFrom: 'demo-catalog',
    capabilities: 'known',
  },
  {
    id: 'deepseek-v3.1-0731',
    name: 'DeepSeek-V3.1-0731',
    window: 128_000,
    modalities: ['text'],
    reasoningLevels: ['low', 'medium', 'high'],
    pricing: { promptPerMtok: 0.27, completionPerMtok: 1.1 },
    joinedFrom: 'demo-catalog',
    capabilities: 'known',
  },
  {
    id: 'qwen3-coder-plus',
    name: 'Qwen3-Coder-Plus',
    window: 128_000,
    modalities: ['text'],
    reasoningLevels: ['low', 'medium'],
    pricing: { promptPerMtok: 0.3, completionPerMtok: 1.5 },
    joinedFrom: 'demo-catalog',
    capabilities: 'known',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    window: 200_000,
    modalities: ['text', 'image'],
    reasoningLevels: ['low', 'medium', 'high'],
    pricing: { promptPerMtok: 3, completionPerMtok: 15 },
    joinedFrom: 'demo-catalog',
    capabilities: 'known',
  },
];

const DEMO_CATALOG_PROVIDERS: CatalogProviderDescriptor[] = [
  {
    id: 'openrouter',
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    envVars: ['OPENROUTER_API_KEY'],
    wireKind: 'openai-compat',
    models: ['glm-5.3-flash', 'deepseek-v3.1-0731', 'qwen3-coder-plus'],
  },
  {
    id: 'deepseek',
    apiBaseUrl: 'https://api.deepseek.com/v1',
    envVars: ['DEEPSEEK_API_KEY'],
    wireKind: 'openai-compat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'anthropic',
    apiBaseUrl: 'https://api.anthropic.com',
    envVars: ['ANTHROPIC_API_KEY'],
    wireKind: 'anthropic',
    models: ['claude-sonnet-4-6'],
  },
  {
    id: 'ollama',
    apiBaseUrl: 'http://127.0.0.1:11434',
    envVars: [],
    wireKind: 'ollama',
    models: ['qwen3:8b', 'glm4:9b'],
  },
];

function createDefaultState(): BrowserMockState {
  const fixture = browserDevData as BrowserDevFixture;
  const agents = Array.isArray(fixture.agents) ? structuredClone(fixture.agents) : [];
  const projects = Array.isArray(fixture.projects) ? structuredClone(fixture.projects) : [];
  const chats = Array.isArray(fixture.chats) ? structuredClone(fixture.chats) : [];
  const messagesByChatId = fixture.messagesByChatId ? structuredClone(fixture.messagesByChatId) : {};

  return {
    agents,
    projects,
    chats,
    messagesByChatId,
    llmSettings: fixture.llmSettings
      ? { ...fixture.llmSettings }
      : {
          provider: 'openai-compat',
          vendorId: 'openrouter',
          model: 'glm-5.3-flash',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: '',
          temperature: 0.3,
          maxTotalTokens: 60_000,
        },
    webSearchSettings: { provider: 'ddg', apiKey: '' },
    telemetrySettings: { endpoint: '', privacyMode: 'metadata', serviceName: 'steerable-demo' },
    insightsSettings: {
      installId: 'demo-browser-install',
      shareBehavior: false,
      shareConversation: false,
      shareProfile: false,
      promptedAt: '2026-11-17T00:00:00.000Z',
      profile: { displayName: '', email: '', company: '', note: '' },
      stats: { events: 0, turns: 4, profile: 0, pending: 0 },
    },
    mcpServers: [],
    skills: Array.isArray(fixture.skills) ? structuredClone(fixture.skills) : [],
    activeStreams: new Map(),
    source: chats.length > 0 ? 'fixture' : 'fallback',
    fixtureMeta: {
      exportedAt: fixture.exportedAt ?? null,
      source: fixture.source ?? null,
    },
  };
}

let state = createDefaultState();

export function resetBrowserDevMockForTests(): void {
  for (const active of state.activeStreams.values()) {
    active.timers.forEach((timer) => window.clearTimeout(timer));
  }
  state = createDefaultState();
}

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function paginateChats(page: number, limit: number) {
  const sorted = [...state.chats].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const start = (page - 1) * limit;
  const chats = sorted.slice(start, start + limit);
  return {
    chats,
    pagination: {
      page,
      limit,
      total: sorted.length,
      totalPages: Math.max(1, Math.ceil(sorted.length / limit)),
      hasMore: start + chats.length < sorted.length,
    },
  };
}

function parseQuery(path: string): URLSearchParams {
  const queryStart = path.indexOf('?');
  return new URLSearchParams(queryStart >= 0 ? path.slice(queryStart + 1) : '');
}

function stripQuery(path: string): string {
  const queryStart = path.indexOf('?');
  return queryStart >= 0 ? path.slice(0, queryStart) : path;
}

function matchChatSubroute(cleanPath: string): { chatId: string; rest: string } | null {
  const match = cleanPath.match(/^\/api\/v2\/chats\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const segment = decodeURIComponent(match[1]);
  if (segment === 'new' || segment === 'prune-empty') return null;
  return { chatId: segment, rest: match[2] ?? '' };
}

function updateChatTimestamp(chatId: string) {
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat) return;
  const nowIso = new Date().toISOString();
  chat.updatedAt = nowIso;
  for (const listener of chatActivityListeners) {
    listener({ chatId, updatedAt: nowIso });
  }
}

function findActiveStreamByChat(chatId: string): ActiveStreamRecord | undefined {
  for (const record of state.activeStreams.values()) {
    if (record.chatId === chatId) return record;
  }
  return undefined;
}

async function request<T>(input: LocalBackendRequestInput): Promise<T> {
  const method = input.method.toUpperCase();
  const path = input.path;
  const cleanPath = stripQuery(path);

  // ---- Chats collection ----
  if (method === 'GET' && cleanPath === '/api/v2/chats') {
    const query = parseQuery(path);
    const page = Number(query.get('page') ?? '1');
    const limit = Number(query.get('limit') ?? '50');
    return paginateChats(page, limit) as T;
  }

  if (method === 'POST' && cleanPath === '/api/v2/chats/new') {
    const body = (input.body ?? {}) as { agentId?: string; projectId?: string | null };
    const agentId = body.agentId || pickDefaultAgentId(state.agents) || null;
    const chatId = `chat-demo-${Date.now()}`;
    const nowIso = new Date().toISOString();
    const chat: MutableChat = {
      id: chatId,
      projectId: body.projectId ?? null,
      userId: 'demo',
      title: 'New chat',
      agentId,
      createdAt: nowIso,
      updatedAt: nowIso,
      isPinned: false,
      systemPrompt: null,
      pinnedRefs: null,
    };
    state.chats.unshift(chat);
    state.messagesByChatId[chatId] = [];
    return {
      success: true,
      chatId,
      projectId: chat.projectId,
      isTemporary: false,
    } as T;
  }

  if (method === 'POST' && cleanPath === '/api/v2/chats/prune-empty') {
    const body = input.body as { exceptChatId?: string | null } | undefined;
    const except = body?.exceptChatId ?? null;
    const deletedChatIds: string[] = [];
    for (const chat of [...state.chats]) {
      if (except && chat.id === except) continue;
      const messages = state.messagesByChatId[chat.id] ?? [];
      if (messages.length === 0) deletedChatIds.push(chat.id);
    }
    state.chats = state.chats.filter((chat) => !deletedChatIds.includes(chat.id));
    for (const id of deletedChatIds) delete state.messagesByChatId[id];
    return { deletedChatIds } as T;
  }

  // ---- Per-chat routes ----
  const chatRoute = matchChatSubroute(cleanPath);
  if (chatRoute) {
    const { chatId, rest } = chatRoute;

    if (method === 'GET' && rest === '') {
      const chat = state.chats.find((c) => c.id === chatId);
      return {
        id: chatId,
        title: chat?.title ?? 'Demo chat',
        forkedFrom: chat?.forkedFrom ?? null,
      } as T;
    }

    if (method === 'DELETE' && rest === '') {
      const onlyIfEmpty = parseQuery(path).get('onlyIfEmpty') === '1';
      if (onlyIfEmpty) {
        const messages = state.messagesByChatId[chatId] ?? [];
        const exists = state.chats.some((chat) => chat.id === chatId);
        if (!exists || messages.length > 0) {
          return { success: true, deleted: false, chatId } as T;
        }
      }
      state.chats = state.chats.filter((chat) => chat.id !== chatId);
      delete state.messagesByChatId[chatId];
      return { success: true, deleted: true, message: 'deleted in demo', chatId } as T;
    }

    if (method === 'GET' && rest === '/messages') {
      const messages = state.messagesByChatId[chatId] ?? [];
      return {
        messages: [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      } as T;
    }

    if (method === 'GET' && rest === '/live-stream') {
      const active = findActiveStreamByChat(chatId);
      return (active ? active.snapshot : { active: false }) as T;
    }

    if (method === 'POST' && rest === '/cancel') {
      const active = findActiveStreamByChat(chatId);
      if (active) {
        cancelStream(active.streamId);
        return { success: true } as T;
      }
      return { success: false, reason: 'not_running' } as T;
    }

    if (method === 'PUT' && rest === '/pin') {
      const body = (input.body ?? {}) as { isPinned?: boolean };
      const chat = state.chats.find((c) => c.id === chatId);
      if (chat) chat.isPinned = Boolean(body.isPinned);
      return {
        success: true,
        chatId,
        isPinned: Boolean(chat?.isPinned),
        message: 'updated',
      } as T;
    }

    if (method === 'PATCH' && rest === '/settings') {
      const body = (input.body ?? {}) as { title?: string; projectId?: string | null };
      const chat = state.chats.find((c) => c.id === chatId);
      if (chat) {
        if (typeof body.title === 'string' && body.title.trim()) {
          chat.title = body.title.trim();
        }
        if ('projectId' in body) {
          chat.projectId = body.projectId ?? null;
        }
        updateChatTimestamp(chatId);
      }
      return {
        id: chatId,
        title: chat?.title ?? 'Demo chat',
        projectId: chat?.projectId ?? null,
      } as T;
    }

    if (method === 'POST' && rest === '/fork') {
      const orig = state.chats.find((c) => c.id === chatId);
      const newChatId = `chat-fork-${Date.now()}`;
      const nowIso = new Date().toISOString();
      const cloned: MutableChat = {
        id: newChatId,
        projectId: orig?.projectId ?? null,
        userId: 'demo',
        title: orig ? `${orig.title} (fork)` : 'Forked chat',
        agentId: orig?.agentId ?? pickDefaultAgentId(state.agents) ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
        isPinned: false,
        systemPrompt: orig?.systemPrompt ?? null,
        pinnedRefs: orig?.pinnedRefs ?? null,
        forkedFrom: orig ? { chatId: orig.id, title: orig.title } : null,
      };
      state.chats.unshift(cloned);
      state.messagesByChatId[newChatId] = (state.messagesByChatId[chatId] ?? []).map((m) => ({
        ...m,
        id: `${m.id}-fork-${Date.now()}`,
        chatId: newChatId,
      }));
      return { chatId: newChatId } as T;
    }

    if (method === 'GET' && rest === '/branches') {
      return { activeRecordId: `rec-${chatId}`, lineage: [], children: [] } as T;
    }

    if (method === 'GET' && rest === '/branches/tree') {
      return {
        activeRecordId: `rec-${chatId}`,
        tree: null,
        nodeCount: 1,
        truncated: false,
      } as T;
    }

    if (method === 'POST' && rest === '/branches/activate') {
      const body = (input.body ?? {}) as { recordId?: string };
      return {
        activeRecordId: body.recordId ?? `rec-${chatId}`,
        messageCount: (state.messagesByChatId[chatId] ?? []).length,
      } as T;
    }

    if (method === 'GET' && rest === '/goal') {
      return { goal: null } as T;
    }

    if (method === 'POST' && rest === '/goal') {
      return { goal: null } as T;
    }

    if (method === 'GET' && rest === '/loops') {
      return { loops: [] } as T;
    }

    if (method === 'DELETE' && rest.startsWith('/loops/')) {
      return { success: true } as T;
    }

    if (method === 'GET' && rest === '/tasks') {
      return { tasks: [] } as T;
    }

    if (method === 'GET' && rest === '/project-context') {
      const chat = state.chats.find((c) => c.id === chatId);
      const project = chat?.projectId
        ? state.projects.find((p) => p.id === chat.projectId) ?? null
        : null;
      return {
        project: project
          ? {
              id: project.id,
              name: project.name,
              folderPath: project.folderPath,
              trusted: Boolean(project.trusted),
            }
          : null,
        ruleFileCount: project ? 1 : 0,
        rulesActive: Boolean(project?.trusted),
      } as T;
    }
  }

  // ---- Projects ----
  if (method === 'GET' && cleanPath === '/api/v2/projects') {
    const projects = [...state.projects].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    return { projects } as T;
  }

  if (method === 'POST' && cleanPath === '/api/v2/projects') {
    const body = (input.body ?? {}) as {
      name?: string;
      folderPath?: string;
      sourceFolders?: string[];
    };
    const nowIso = new Date().toISOString();
    const project: LocalProject = {
      id: `proj-${Date.now()}`,
      name: (body.name || 'demo-project').trim(),
      folderPath: body.folderPath || '/workspace/demo-project',
      sourceFolders: body.sourceFolders ?? [],
      trusted: true,
      sortOrder: state.projects.length,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    state.projects.push(project);
    return { success: true, project } as T;
  }

  if (method === 'PUT' && cleanPath === '/api/v2/projects/order') {
    const body = (input.body ?? {}) as { orderedIds?: string[] };
    const order = body.orderedIds ?? [];
    state.projects.forEach((p) => {
      const idx = order.indexOf(p.id);
      p.sortOrder = idx >= 0 ? idx : order.length + (p.sortOrder ?? 0);
    });
    return { success: true, projects: [...state.projects] } as T;
  }

  const projectTrustMatch = cleanPath.match(/^\/api\/v2\/projects\/([^/]+)\/trust$/);
  if (method === 'PUT' && projectTrustMatch) {
    const projectId = decodeURIComponent(projectTrustMatch[1]);
    const body = (input.body ?? {}) as { trusted?: boolean };
    const project = state.projects.find((p) => p.id === projectId);
    if (project) {
      project.trusted = Boolean(body.trusted);
      project.updatedAt = new Date().toISOString();
    }
    return { success: true, project } as T;
  }

  const projectMatch = cleanPath.match(/^\/api\/v2\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    const project = state.projects.find((p) => p.id === projectId);
    if (method === 'PUT' && project) {
      const body = (input.body ?? {}) as Partial<LocalProject>;
      if (typeof body.name === 'string') project.name = body.name;
      if (typeof body.folderPath === 'string') project.folderPath = body.folderPath;
      if (Array.isArray(body.sourceFolders)) project.sourceFolders = body.sourceFolders;
      project.updatedAt = new Date().toISOString();
      return { success: true, project } as T;
    }
    if (method === 'DELETE') {
      state.projects = state.projects.filter((p) => p.id !== projectId);
      let detachedChats = 0;
      for (const c of state.chats) {
        if (c.projectId === projectId) {
          c.projectId = null;
          detachedChats += 1;
        }
      }
      return { success: true, detachedChats } as T;
    }
  }

  // ---- Chat agents / skills / tools ----
  if (method === 'GET' && cleanPath === '/api/v2/chat-agents') {
    const includeArchived = parseQuery(path).get('include_archived') === 'true';
    const agents = includeArchived
      ? state.agents
      : state.agents.filter((agent) => !agent.isArchived);
    return { agents, total: agents.length } as T;
  }

  if (method === 'POST' && cleanPath === '/api/v2/chat-agents') {
    const body = (input.body ?? {}) as Partial<ChatAgentWriteInput>;
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `agent-demo-${Date.now()}`;
    const agent: LocalChatAgent = {
      id,
      slug: null,
      name: (body.name || 'New assistant').trim() || 'New assistant',
      icon: null,
      color: body.color ?? '#4f46e5',
      description: body.description ?? null,
      rolePrompt: body.rolePrompt ?? null,
      skillIds: body.skillIds ?? [],
      toolPolicy: body.toolPolicy ?? { mode: 'all', tools: [] },
      allowExternalSkills: body.allowExternalSkills ?? true,
      loadAllSkills: body.loadAllSkills ?? false,
      isBuiltin: false,
      isArchived: false,
      sortOrder: body.sortOrder ?? state.agents.length,
    };
    state.agents.push(agent);
    return { agent } as T;
  }

  const chatAgentMatch = cleanPath.match(/^\/api\/v2\/chat-agents\/([^/]+)$/);
  if (chatAgentMatch) {
    const agentId = decodeURIComponent(chatAgentMatch[1]);
    const reserved = new Set(['skills', 'mcp-tools', 'templates', 'tools', 'generate']);
    if (!reserved.has(agentId)) {
      const index = state.agents.findIndex((agent) => agent.id === agentId);
      if (index < 0) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      if (method === 'PATCH') {
        const body = (input.body ?? {}) as Partial<LocalChatAgent>;
        const current = state.agents[index];
        const updated: LocalChatAgent = {
          ...current,
          name: typeof body.name === 'string' ? body.name : current.name,
          color: body.color === undefined ? current.color : body.color,
          description: body.description === undefined ? current.description : body.description,
          rolePrompt: body.rolePrompt === undefined ? current.rolePrompt : body.rolePrompt,
          skillIds: body.skillIds === undefined ? current.skillIds : body.skillIds,
          toolPolicy: body.toolPolicy === undefined ? current.toolPolicy : body.toolPolicy,
          allowExternalSkills:
            body.allowExternalSkills === undefined
              ? current.allowExternalSkills
              : body.allowExternalSkills,
          loadAllSkills:
            body.loadAllSkills === undefined ? current.loadAllSkills : body.loadAllSkills,
        };
        state.agents[index] = updated;
        return { agent: updated } as T;
      }
      if (method === 'DELETE') {
        state.agents[index] = { ...state.agents[index], isArchived: true };
        return { id: agentId, status: 'archived' } as T;
      }
    }
  }

  if (method === 'GET' && cleanPath === '/api/v2/chat-agents/skills') {
    return {
      skills: state.skills.map((skill) => ({
        ...skill,
        id: skill.name,
        displayName: '',
        layer: skill.builtin ? 'eager' : 'catalog',
        origin: skill.builtin ? 'builtin' : 'user',
      })),
    } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/chat-agents/tools') {
    return {
      tools: [
        { name: 'local_exec_shell', description: 'Run a sandboxed shell command.', category: 'local' },
        { name: 'local_read_file', description: 'Read a file from the workspace.', category: 'local' },
        { name: 'local_write_file', description: 'Write or patch a workspace file.', category: 'local' },
        { name: 'web_search', description: 'Search public documentation.', category: 'local' },
      ],
    } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/chat-agents/mcp-tools') {
    return { tools: [] } as T;
  }

  if (method === 'POST' && cleanPath === '/api/v2/chat-agents/skills/import') {
    const body = input.body as { path?: string } | undefined;
    const name = body?.path?.split(/[\\/]/).filter(Boolean).pop() || 'demo-skill';
    if (!state.skills.some((skill) => skill.name === name)) {
      state.skills.push({ name, description: 'Skill imported in the interactive browser demo.' });
    }
    return { success: true, name } as T;
  }

  if (method === 'DELETE' && cleanPath.startsWith('/api/v2/chat-agents/skills/delete/')) {
    const name = decodeURIComponent(cleanPath.split('/').pop() || '');
    state.skills = state.skills.filter((skill) => skill.name !== name || skill.builtin);
    return { success: true } as T;
  }

  // ---- Children / background tasks ----
  if (method === 'GET' && cleanPath === '/api/v2/children') {
    return { children: [] } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/child-process') {
    return { recordId: parseQuery(path).get('recordId') ?? '', timeline: [] } as T;
  }

  if (method === 'GET' && /^\/api\/v2\/tasks\/[^/]+\/process$/.test(cleanPath)) {
    return { task: null, timeline: [], live: false, stale: false } as T;
  }

  // ---- LLM settings / catalog / models / diagnostics ----
  if (method === 'GET' && cleanPath === '/api/v2/local-settings/llm') {
    return state.llmSettings as T;
  }

  if (method === 'POST' && cleanPath === '/api/v2/local-settings/llm') {
    state.llmSettings = { ...state.llmSettings, ...(input.body as Partial<LlmSettings>) };
    return state.llmSettings as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/llm/credential') {
    return {
      ok: true,
      source: 'config',
      envNames: [],
      provider: state.llmSettings.provider,
      vendorId: state.llmSettings.vendorId ?? 'openrouter',
      model: state.llmSettings.model,
    } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/llm/catalog') {
    return { providers: DEMO_CATALOG_PROVIDERS } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/llm/models') {
    return {
      models: DEMO_MODELS,
      catalogStatus: 'live',
      fetchedAt: Date.now(),
      current: { model: state.llmSettings.model, reasoningEffort: 'high' },
    } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/compat/flags') {
    return {
      flags: [
        {
          key: 'supportsUsageInStreaming',
          field: 'supportsUsageInStreaming',
          kind: 'bool',
          default: true,
          description: 'Include token usage frames at the end of streamed responses.',
        },
        {
          key: 'supportsReasoningEffort',
          field: 'supportsReasoningEffort',
          kind: 'bool',
          default: true,
          description: 'Forward reasoning_effort to gateways that expose thinking levels.',
        },
      ],
    } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/llm/presets') {
    return {
      presets: [
        {
          host: 'openrouter.ai',
          modelPrefix: 'glm-5.3',
          temperature: 0.3,
          topP: null,
          maxTokens: null,
          reasoningEffort: 'high',
          extraBody: null,
        },
      ],
    } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/llm/presets/resolve') {
    return {
      preset: {
        temperature: 0.3,
        reasoningEffort: 'high',
      },
    } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/llm/account') {
    return {
      status: 'unsupported',
      provider: null,
      label: '',
      available: null,
      currency: null,
      total: null,
      granted: null,
      toppedUp: null,
    } as T;
  }

  if (method === 'POST' && cleanPath === '/api/v2/llm/diagnose') {
    return {
      ok: true,
      steps: [
        { name: 'Gateway DNS & TLS', ok: true, durationMs: 18, detail: 'Playbook endpoint reachable' },
        { name: 'Model catalog check', ok: true, durationMs: 24, detail: `${state.llmSettings.model} listed` },
      ],
      ambientProxies: [],
      hint: 'Interactive browser playbook active (run steerable-cli locally to probe live keys).',
    } as T;
  }

  // ---- Sandbox, usage, search, telemetry, insights, MCP, portable, local files ----
  if (method === 'GET' && cleanPath === '/api/v2/sidecar/sandbox-posture') {
    return {
      posture: { backend: 'seatbelt', enforcement: 'partial', reason: 'active' },
      egress: { mode: 'per-host-proxy', reason: null },
    } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/usage/summary') {
    const sinceDays = Number(parseQuery(path).get('days') ?? '30');
    return {
      sinceDays,
      byModel: [
        {
          model: 'glm-5.3-flash',
          provider: 'openai-compat',
          turns: 4,
          promptTokens: 23_110,
          completionTokens: 1_660,
          totalTokens: 24_770,
          cachedPromptTokens: 15_000,
          costUsd: 0.0051,
        },
      ],
      totals: {
        turns: 4,
        promptTokens: 23_110,
        completionTokens: 1_660,
        totalTokens: 24_770,
        cachedPromptTokens: 15_000,
        costUsd: 0.0051,
        partialTurns: 0,
      },
    } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/usage/reliability') {
    const sinceDays = Number(parseQuery(path).get('days') ?? '7');
    return {
      sinceDays,
      total: 12,
      failed: 0,
      cancelled: 0,
      recoveredByRetry: 2,
      usedDirect: 10,
      failuresByKind: [],
    } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/local-settings/web-search') {
    return state.webSearchSettings as T;
  }
  if (method === 'POST' && cleanPath === '/api/v2/local-settings/web-search') {
    state.webSearchSettings = {
      ...state.webSearchSettings,
      ...(input.body as Partial<BrowserMockState['webSearchSettings']>),
    };
    return state.webSearchSettings as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/local-settings/telemetry') {
    return state.telemetrySettings as T;
  }
  if (method === 'POST' && cleanPath === '/api/v2/local-settings/telemetry') {
    state.telemetrySettings = {
      ...state.telemetrySettings,
      ...(input.body as Partial<BrowserMockState['telemetrySettings']>),
    };
    return state.telemetrySettings as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/local-settings/insights') {
    return state.insightsSettings as T;
  }
  if (method === 'POST' && cleanPath === '/api/v2/local-settings/insights') {
    const body = (input.body ?? {}) as Record<string, unknown>;
    state.insightsSettings = {
      ...state.insightsSettings,
      ...(typeof body.shareBehavior === 'boolean' ? { shareBehavior: body.shareBehavior } : {}),
      ...(typeof body.shareConversation === 'boolean'
        ? { shareConversation: body.shareConversation }
        : {}),
      ...(typeof body.shareProfile === 'boolean' ? { shareProfile: body.shareProfile } : {}),
    };
    return state.insightsSettings as T;
  }
  if (method === 'POST' && cleanPath === '/api/v2/insights/events') {
    return { ok: true } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/mcp/servers') {
    return { servers: state.mcpServers } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/portable/config') {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      llm: state.llmSettings,
      agents: state.agents,
    } as T;
  }

  if (method === 'POST' && cleanPath === '/api/v2/local/resolve-paths') {
    return { resolved: [] } as T;
  }

  if (method === 'POST' && cleanPath === '/api/v2/local/open-path') {
    return { success: true } as T;
  }

  if (method === 'GET' && cleanPath === '/api/v2/local/download') {
    const targetPath = parseQuery(path).get('path') ?? '';
    const sample = DEMO_SAMPLE_FILES[targetPath];
    const fileName = sample?.fileName ?? (targetPath.split('/').pop() || 'demo-artifact.txt');
    const content =
      sample?.content ??
      `# Demo Artifact\n\nGenerated in browser interactive playbook for path: ${targetPath}\n`;
    return {
      fileName,
      mime: sample?.mime ?? 'text/plain; charset=utf-8',
      size: new TextEncoder().encode(content).byteLength,
      base64: encodeUtf8Base64(content),
    } as T;
  }

  // Soft fallback for any secondary diagnostic/export endpoint in demo mode
  console.warn(`[browser-dev-host-mock] Unhandled route ${method} ${path}, returning empty object.`);
  return {} as T;
}

function pushSse(
  onEvent: (payload: LocalBackendStreamEvent) => void,
  data: unknown,
  event?: string,
) {
  const prefix = event ? `event: ${event}\n` : '';
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  onEvent({ type: 'data', chunk: `${prefix}data: ${payload}\n\n` });
}

function scheduleStreamTimer(record: ActiveStreamRecord, callback: () => void, delay: number) {
  const timer = window.setTimeout(callback, delay);
  record.timers.push(timer);
}

async function startStream(
  input: LocalBackendRequestInput,
  onEvent: (payload: LocalBackendStreamEvent) => void,
): Promise<string | null> {
  const cleanPath = stripQuery(input.path);
  const runMatch = cleanPath.match(/^\/api\/v2\/chats\/([^/]+)\/run$/);
  const regenMatch = cleanPath.match(/^\/api\/v2\/chats\/([^/]+)\/messages\/([^/]+)\/regenerate$/);
  const chatId = decodeURIComponent((runMatch?.[1] ?? regenMatch?.[1] ?? '').trim());

  if (!chatId) {
    onEvent({ type: 'error', error: `Invalid mock stream path: ${input.path}` });
    return null;
  }

  const body = (input.body ?? {}) as {
    message?: string;
    model?: string;
    reasoningEffort?: string;
    execPolicy?: string;
    mode?: string;
  };

  let promptText = body.message?.trim() || '';
  if (regenMatch && !promptText) {
    const priorUser = [...(state.messagesByChatId[chatId] ?? [])]
      .reverse()
      .find((m) => m.role === 'user');
    promptText = priorUser?.content || 'Regenerate response';
  }
  if (!promptText) promptText = 'Show Steerable demo playbook';

  const streamId = `demo-stream-${Date.now()}`;
  const record: ActiveStreamRecord = {
    streamId,
    chatId,
    timers: [],
    onEvent,
    steerNote: null,
    snapshot: { active: true, status: 'running', content: '', executedActions: [], timeline: [] },
  };
  state.activeStreams.set(streamId, record);

  const isFirstTurn = (state.messagesByChatId[chatId] ?? []).length === 0;
  if (!regenMatch) {
    const userMessage: MutableMessage = {
      id: `msg-user-${Date.now()}`,
      chatId,
      role: 'user',
      content: promptText,
      createdAt: new Date().toISOString(),
      messageMetadata: null,
    };
    state.messagesByChatId[chatId] = [...(state.messagesByChatId[chatId] ?? []), userMessage];
  }

  const script = buildPlaybookScript({
    message: promptText,
    model: body.model || state.llmSettings.model,
    reasoningEffort: body.reasoningEffort ?? 'high',
    execPolicy: body.execPolicy ?? 'workspace',
    mode: body.mode ?? 'agent',
  });

  if (isFirstTurn) {
    const chat = state.chats.find((c) => c.id === chatId);
    if (chat && (chat.title === 'New chat' || !chat.title)) {
      chat.title = script.chatTitle;
      for (const listener of chatTitleListeners) {
        listener({ chatId, title: script.chatTitle });
      }
    }
  }

  let delay = 60;
  const accumulatedActions: unknown[] = [];
  const persistedTimeline: unknown[] = [];

  script.rounds.forEach((round, roundIndex) => {
    if (roundIndex > 0) {
      scheduleStreamTimer(record, () => {
        pushSse(onEvent, { type: 'completion', status: 'executing' });
      }, delay);
      delay += 120;
    }

    scheduleStreamTimer(record, () => {
      pushSse(onEvent, { type: 'reasoning', content: round.reasoning });
      persistedTimeline.push({ type: 'reasoning', content: round.reasoning });
      record.snapshot.timeline = [...persistedTimeline];
    }, delay);
    delay += 140;

    const roundCompletedActions: unknown[] = [];
    round.actions.forEach((action) => {
      const runningAction = { ...action, result: undefined };
      const runningList = [...accumulatedActions, ...roundCompletedActions, runningAction];
      scheduleStreamTimer(record, () => {
        pushSse(onEvent, { type: 'executed_actions', actions: runningList });
        record.snapshot.executedActions = runningList;
      }, delay);
      delay += 180;

      roundCompletedActions.push(action);
      const completedList = [...accumulatedActions, ...roundCompletedActions];
      scheduleStreamTimer(record, () => {
        pushSse(onEvent, { type: 'executed_actions', actions: completedList });
        record.snapshot.executedActions = completedList;
      }, delay);
      delay += 120;
    });

    accumulatedActions.push(...roundCompletedActions);
    persistedTimeline.push({ type: 'tools', actions: roundCompletedActions });
  });

  const baseReply = script.reply;
  const chunks = baseReply.match(/.{1,14}/gs) ?? [baseReply];
  chunks.forEach((chunk) => {
    scheduleStreamTimer(record, () => {
      pushSse(onEvent, { content: chunk });
      record.snapshot.content = `${record.snapshot.content ?? ''}${chunk}`;
    }, delay);
    delay += 38;
  });

  scheduleStreamTimer(record, () => {
    let finalReply = baseReply;
    if (record.steerNote) {
      const steerSuffix = `\n\n> Steered mid-turn: "${record.steerNote}"`;
      pushSse(onEvent, { content: steerSuffix });
      finalReply += steerSuffix;
    }

    if (script.turnFiles && script.turnFiles.length > 0) {
      pushSse(onEvent, {
        type: 'agent',
        event: 'turn_files',
        payload: { files: script.turnFiles },
      });
    }

    pushSse(onEvent, {
      type: 'agent',
      event: 'turn_usage',
      payload: { usage: script.usage },
    });

    const assistantId = `msg-assistant-${Date.now()}`;
    const finalTimeline = [...persistedTimeline, { type: 'text', content: finalReply }];
    const assistantMessage: MutableMessage = {
      id: assistantId,
      chatId,
      role: 'assistant',
      content: finalReply,
      createdAt: new Date().toISOString(),
      messageMetadata: JSON.stringify({
        completionStatus: 'completed',
        executedActions: accumulatedActions,
        timeline: finalTimeline,
        ...(script.turnFiles ? { turnFiles: script.turnFiles } : {}),
        usage: script.usage,
        durationMs: delay,
        suggestedReplies: script.suggestedReplies,
      }),
    };
    state.messagesByChatId[chatId] = [...(state.messagesByChatId[chatId] ?? []), assistantMessage];
    updateChatTimestamp(chatId);

    pushSse(onEvent, { type: 'message_id', messageId: assistantId });
    pushSse(onEvent, '[DONE]');
    onEvent({ type: 'end', status: 200 });
    state.activeStreams.delete(streamId);

    for (const listener of suggestedReplyListeners) {
      listener({
        chatId,
        messageId: assistantId,
        suggestions: script.suggestedReplies,
      });
    }
  }, delay + 60);

  return streamId;
}

function cancelStream(streamId: string) {
  const record = state.activeStreams.get(streamId);
  if (!record) return;
  record.timers.forEach((timer) => window.clearTimeout(timer));
  state.activeStreams.delete(streamId);
  pushSse(record.onEvent, { type: 'completion', status: 'cancelled' });
  pushSse(record.onEvent, '[DONE]');
  record.onEvent({ type: 'end', status: 200 });
}

async function steerChat(chatId: string, content: string): Promise<boolean> {
  const active = findActiveStreamByChat(chatId);
  if (!active) return false;
  active.steerNote = content.trim();
  return true;
}

export function installBrowserDevHostMock() {
  if (typeof window === 'undefined' || window.steerableHost) return;
  // DEV 浏览器预览自动安装；官网静态 demo 构建（app-demo 入口）经 demo flag
  // 显式安装。普通 prod 构建两条路都不通，本模块根本不会进产物。
  if (!import.meta.env.DEV && !isDemoMode()) return;

  window.steerableHost = {
    runtime: 'local',
    platform: 'darwin',
    local: {
      selectDirectory: async () => ({
        canceled: false,
        filePaths: ['/workspace/steerable-eval-sandbox'],
      }),
      captureScreenshot: async () => ({
        success: false as const,
        error: 'Browser demo mode cannot capture a window screenshot.',
      }),
    },
    localBackend: {
      request,
      startStream,
      cancelStream,
      steerChat,
    },
    onMenuNewChat: () => undefined,
    offMenuNewChat: () => undefined,
    onMenuOpenTerminal: () => undefined,
    offMenuOpenTerminal: () => undefined,
    onChatTitleUpdated: (callback) => {
      chatTitleListeners.add(callback);
      return () => {
        chatTitleListeners.delete(callback);
      };
    },
    onChatCreated: (callback) => {
      chatCreatedListeners.add(callback);
      return () => {
        chatCreatedListeners.delete(callback);
      };
    },
    onChatActivity: (callback) => {
      chatActivityListeners.add(callback);
      return () => {
        chatActivityListeners.delete(callback);
      };
    },
    onSuggestedReplies: (callback) => {
      suggestedReplyListeners.add(callback);
      return () => {
        suggestedReplyListeners.delete(callback);
      };
    },
  } satisfies HostBridge;

  console.info(
    '[browser-dev-host-mock] Installed mock window.steerableHost bridge.',
    state.source === 'fixture'
      ? { source: state.fixtureMeta?.source, exportedAt: state.fixtureMeta?.exportedAt }
      : { source: 'built-in fallback' },
  );
}
