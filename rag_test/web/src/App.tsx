import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronRight,
  Download,
  FileText,
  Files,
  Library,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Send,
  Square,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  Pencil,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import './App.css';

type AuthState = 'checking' | 'anonymous' | 'authenticated';

type ServiceHealth = {
  id: string;
  label: string;
  reachable: boolean;
  latencyMs: number;
  detail: string;
  url: string;
};

type HealthPayload = {
  ok: boolean;
  apiKeyConfigured?: boolean;
  checks: ServiceHealth[];
};

type ReviewIssue = {
  id: string;
  paragraphIndex: number;
  issueType: string;
  severity: string;
  docId?: string;
  fileName?: string;
  page?: number;
  blockId?: string;
  bbox?: number[];
  sourceText: string;
  evidenceText: string;
  suggestion: string;
  reason: string;
  confidence: number;
  status: string;
};

type ReviewTask = {
  id: string;
  fileName: string;
  status: string;
  issueCount: number;
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  issues: ReviewIssue[];
};

type UserAccount = {
  id: string;
  username: string;
  role: 'admin' | 'member';
  status: string;
  createdAt?: string;
  lastLoginAt?: string | null;
};

type Dataset = {
  id: string;
  name: string;
  document_count: number;
  chunk_count: number;
  done_count?: number;
  embedding_model: string;
};

type RagDocument = {
  id: string;
  name: string;
  run: string;
  size: number;
  chunk_count?: number;
  progress?: number;
  progress_msg?: string;
};

type Chunk = {
  id: string;
  content: string;
  highlight?: string;
  document_id: string;
  document_keyword: string;
  dataset_id: string;
  similarity: number;
  term_similarity: number;
  vector_similarity: number;
  page?: number;
  positions?: number[];
  bbox?: number[] | null;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  exact?: Chunk[];
  similar?: Chunk[];
  reviewTask?: ReviewTask;
  pending?: boolean;
  error?: boolean;
  createdAt: number;
};

type ChatSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

function createSession(): ChatSession {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: '新会话',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}



function stripHtml(value: string) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function readCookie(name: string) {
  const value = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : '';
}

function csrfFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  const csrfToken = readCookie('zhisuo_csrf');
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  return window.fetch(input, {
    ...init,
    headers,
    credentials: 'same-origin',
  });
}

async function consumeSse(
  response: Response,
  onEvent: (event: string, payload: any) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('浏览器不支持流式响应');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const event = chunk.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
      if (!dataLine) continue;
      onEvent(event, JSON.parse(dataLine));
    }
  }
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

const runMeta: Record<string, { label: string; tone: string }> = {
  UNSTART: { label: '等待处理', tone: 'waiting' },
  RUNNING: { label: '解析中', tone: 'running' },
  DONE: { label: '已入库', tone: 'done' },
  FAIL: { label: '失败', tone: 'failed' },
  CANCEL: { label: '已取消', tone: 'waiting' },
  SCHEDULE: { label: '排队中', tone: 'running' },
};

function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [consoleUser, setConsoleUser] = useState('');
  const [consoleRole, setConsoleRole] = useState<'admin' | 'member'>('member');
  const [userManagementEnabled, setUserManagementEnabled] = useState(false);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [userLoading, setUserLoading] = useState(false);
  const [userError, setUserError] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'member'>('member');
  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [input, setInput] = useState('');
  const [editingSessionId, setEditingSessionId] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const [openSessionMenuId, setOpenSessionMenuId] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [previewChunk, setPreviewChunk] = useState<Chunk | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const wordInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  const selectedDataset = useMemo(
    () => datasets.find((item) => item.id === selectedDatasetId),
    [datasets, selectedDatasetId],
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );
  const completedCount = documents.filter((document) => document.run === 'DONE').length;
  const processingCount = documents.filter((document) => ['UNSTART', 'RUNNING', 'SCHEDULE'].includes(document.run)).length;
  const failedCount = documents.filter((document) => ['FAIL', 'CANCEL'].includes(document.run)).length;
  const sessionIsRunning = Boolean(activeSession?.messages.some((message) => message.pending));

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages]);

  const api = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await csrfFetch(`/api/ragflow${path}`, {
      ...init,
      headers: {
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers || {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      setAuthState('anonymous');
      throw new Error(payload?.message || '登录已过期，请重新登录');
    }
    if (!response.ok || (payload && payload.code !== 0)) {
      throw new Error(payload?.message || `请求失败: HTTP ${response.status}`);
    }
    return payload as T;
  }, []);

  const checkSession = useCallback(async () => {
    try {
      const response = await csrfFetch('/api/auth/session');
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.authenticated) {
        setConsoleUser(payload.data?.username || 'admin');
        setConsoleRole(payload.data?.role === 'admin' ? 'admin' : 'member');
        setAuthState('authenticated');
      } else {
        setAuthState('anonymous');
      }
    } catch {
      setAuthState('anonymous');
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const response = await csrfFetch('/api/config');
      const payload = await response.json().catch(() => null);
      setUserManagementEnabled(Boolean(payload?.userManagementEnabled));
    } catch {
      setUserManagementEnabled(false);
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const response = await csrfFetch('/api/health');
      setHealth(await response.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      const response = await csrfFetch('/api/conversations');
      const payload = await response.json().catch(() => null);
      if (response.status === 401) {
        setAuthState('anonymous');
        return;
      }
      if (!response.ok || payload?.code !== 0) throw new Error(payload?.message || '会话加载失败');
      const nextSessions: ChatSession[] = (payload.data || []).map((conversation: any) => ({
        id: conversation.id,
        title: conversation.title || '新会话',
        createdAt: Date.parse(conversation.createdAt) || Date.now(),
        updatedAt: Date.parse(conversation.updatedAt) || Date.now(),
        messages: (conversation.messages || []).map((message: any) => ({
          id: message.id,
          role: message.role,
          content: message.content || '',
          exact: message.exact || [],
          similar: message.similar || [],
          reviewTask: message.metadata?.reviewTask,
          pending: message.status === 'streaming',
          error: message.status === 'error',
          createdAt: Date.parse(message.createdAt) || Date.now(),
        })),
      }));
      setSessions(nextSessions);
      setActiveSessionId((current) => (
        current && nextSessions.some((session) => session.id === current)
          ? current
          : nextSessions[0]?.id || ''
      ));
    } catch {
      // Keep the current UI state if conversation loading fails.
    }
  }, []);

  const refreshDatasets = useCallback(async (silent = false) => {
    if (!silent) setWorkspaceLoading(true);
    try {
      const payload = await api<{ data: Dataset[] }>('/datasets?page=1&page_size=100&include_parsing_status=true');
      let nextDatasets = payload.data || [];
      if (!nextDatasets.length) {
        const created = await api<{ data: Dataset }>('/datasets', {
          method: 'POST',
          body: JSON.stringify({
            name: '默认知识库',
            language: 'Chinese',
            description: '知索单知识库模式自动创建',
            chunk_method: 'naive',
            parser_config: {
              layout_recognize: 'PaddleOCR',
              paddleocr_algorithm: 'PP-StructureV3',
              chunk_token_num: 512,
              delimiter: '\n',
              auto_keywords: 0,
              auto_questions: 0,
            },
          }),
        });
        nextDatasets = [created.data];
      }
      setDatasets(nextDatasets);
      setSelectedDatasetId((current) => (
        current && nextDatasets.some((dataset) => dataset.id === current)
          ? current
          : nextDatasets[0]?.id || ''
      ));
    } catch (error) {
      if (error instanceof Error && error.message.includes('登录')) setAuthState('anonymous');
    } finally {
      if (!silent) setWorkspaceLoading(false);
    }
  }, [api]);

  const refreshDocuments = useCallback(async (silent = false) => {
    if (!selectedDatasetId) return;
    if (!silent) setWorkspaceLoading(true);
    try {
      const payload = await api<{ data: { docs: RagDocument[] } | RagDocument[] }>(
        `/datasets/${selectedDatasetId}/documents?page=1&page_size=100&orderby=create_time&desc=true`,
      );
      setDocuments(Array.isArray(payload.data) ? payload.data : payload.data.docs || []);
    } finally {
      if (!silent) setWorkspaceLoading(false);
    }
  }, [api, selectedDatasetId]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    void refreshConfig();
    void refreshHealth();
    void refreshDatasets();
    void refreshConversations();
  }, [authState, refreshConfig, refreshConversations, refreshDatasets, refreshHealth]);

  useEffect(() => {
    if (authState !== 'authenticated' || !selectedDatasetId) return;
    void refreshDocuments();
  }, [authState, refreshDocuments, selectedDatasetId]);

  useEffect(() => {
    if (!processingCount || !selectedDatasetId) return;
    const timer = window.setInterval(() => {
      void refreshDocuments(true);
      void refreshDatasets(true);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [processingCount, refreshDatasets, refreshDocuments, selectedDatasetId]);

  const login = async () => {
    setLoginLoading(true);
    setLoginError('');
    try {
      const response = await csrfFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.code !== 0) throw new Error(payload?.message || '登录失败');
      setConsoleUser(payload.data?.username || loginUsername);
      setConsoleRole(payload.data?.role === 'admin' ? 'admin' : 'member');
      setLoginPassword('');
      setAuthState('authenticated');
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoginLoading(false);
    }
  };

  const logout = async () => {
    await csrfFetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    setAuthState('anonymous');
    setSystemOpen(false);
    setKnowledgeOpen(false);
    setDatasets([]);
    setDocuments([]);
    setSelectedDatasetId('');
    setSessions([]);
    setActiveSessionId('');
    setConsoleRole('member');
    setUsers([]);
    setUserError('');
  };

  const refreshUsers = useCallback(async () => {
    if (consoleRole !== 'admin') {
      setUsers([]);
      return;
    }
    setUserLoading(true);
    setUserError('');
    try {
      const response = await csrfFetch('/api/users');
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.code !== 0) throw new Error(payload?.message || '用户列表加载失败');
      setUsers(payload.data || []);
    } catch (error) {
      setUserError(error instanceof Error ? error.message : String(error));
    } finally {
      setUserLoading(false);
    }
  }, [consoleRole]);

  useEffect(() => {
    if (authState === 'authenticated' && consoleRole === 'admin' && userManagementEnabled) void refreshUsers();
  }, [authState, consoleRole, refreshUsers, userManagementEnabled]);

  const createUserAccount = async () => {
    if (!newUsername.trim() || !newPassword) return;
    setUserLoading(true);
    setUserError('');
    try {
      const response = await csrfFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, role: newRole }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.code !== 0) throw new Error(payload?.message || '创建用户失败');
      setNewUsername('');
      setNewPassword('');
      setNewRole('member');
      await refreshUsers();
    } catch (error) {
      setUserError(error instanceof Error ? error.message : String(error));
    } finally {
      setUserLoading(false);
    }
  };

  const updateUserAccount = async (userId: string, patch: Record<string, unknown>) => {
    setUserLoading(true);
    setUserError('');
    try {
      const response = await csrfFetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.code !== 0) throw new Error(payload?.message || '用户更新失败');
      await refreshUsers();
    } catch (error) {
      setUserError(error instanceof Error ? error.message : String(error));
    } finally {
      setUserLoading(false);
    }
  };

  const deleteUserAccount = async (userId: string) => {
    setUserLoading(true);
    setUserError('');
    try {
      const response = await csrfFetch(`/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.code !== 0) throw new Error(payload?.message || '删除用户失败');
      await refreshUsers();
    } catch (error) {
      setUserError(error instanceof Error ? error.message : String(error));
    } finally {
      setUserLoading(false);
    }
  };

  const updateSession = (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
    setSessions((current) => current.map((session) => (
      session.id === sessionId ? updater(session) : session
    )));
  };

  const newSession = () => {
    setActiveSessionId('');
    setInput('');
    setEditingSessionId('');
    setOpenSessionMenuId('');
    setDeleteConfirmId('');
    setSidebarOpen(false);
  };

  const startRename = (session: ChatSession) => {
    setEditingSessionId(session.id);
    setEditingTitle(session.title || '新会话');
    setOpenSessionMenuId('');
    setDeleteConfirmId('');
  };

  const saveRename = async (sessionId: string) => {
    const title = editingTitle.trim();
    if (title) {
      try {
        await csrfFetch(`/api/conversations/${encodeURIComponent(sessionId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title.slice(0, 80) }),
        });
      } catch {
        // Keep optimistic state even if the request fails.
      }
      updateSession(sessionId, (session) => ({ ...session, title: title.slice(0, 40) }));
    }
    setEditingSessionId('');
    setEditingTitle('');
  };

  const cancelRename = () => {
    setEditingSessionId('');
    setEditingTitle('');
  };

  const deleteSession = async (sessionId: string) => {
    try {
      await csrfFetch(`/api/conversations/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    } catch {
      // Remove local state even if the server request fails.
    }
    const next = sessions.filter((session) => session.id !== sessionId);
    setSessions(next);
    if (activeSessionId === sessionId) setActiveSessionId(next[0]?.id || '');
    setDeleteConfirmId('');
    setOpenSessionMenuId('');
  };

  const uploadPdfs = async (files: FileList | File[]) => {
    if (!selectedDatasetId || !files.length) return;
    const form = new FormData();
    Array.from(files).forEach((file) => form.append('file', file));
    setUploading(true);
    try {
      const uploadPayload = await api<{ data: RagDocument[] }>(`/datasets/${selectedDatasetId}/documents`, {
        method: 'POST',
        body: form,
      });
      const documentIds = (uploadPayload.data || []).map((document) => document.id).filter(Boolean);
      if (documentIds.length) {
        await api(`/datasets/${selectedDatasetId}/chunks`, {
          method: 'POST',
          body: JSON.stringify({ document_ids: documentIds }),
        });
      }
      await refreshDocuments();
      await refreshDatasets(true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const retryDocuments = async () => {
    const ids = documents.filter((document) => ['UNSTART', 'FAIL', 'CANCEL'].includes(document.run)).map((document) => document.id);
    if (!ids.length) return;
    setWorkspaceLoading(true);
    try {
      await api(`/datasets/${selectedDatasetId}/chunks`, {
        method: 'POST',
        body: JSON.stringify({ document_ids: ids }),
      });
      await refreshDocuments();
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const deletePdf = async (document: RagDocument) => {
    if (!window.confirm(`确定删除《${document.name}》吗？`)) return;
    setWorkspaceLoading(true);
    try {
      const response = await csrfFetch(`/api/documents/${encodeURIComponent(document.id)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.code !== 0) throw new Error(payload?.message || '删除失败');
      await refreshDocuments();
      await refreshDatasets(true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const reindexPdf = async (document: RagDocument) => {
    setWorkspaceLoading(true);
    try {
      const response = await csrfFetch(`/api/documents/${encodeURIComponent(document.id)}/reindex`, { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.code !== 0) throw new Error(payload?.message || '重新索引失败');
      await refreshDocuments();
      await refreshDatasets(true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const downloadPdf = (document: RagDocument) => {
    window.open(`/api/documents/${encodeURIComponent(document.id)}/download`, '_blank', 'noopener,noreferrer');
  };

  const sendWordReview = async (file: File) => {
    if (!/\.docx$/i.test(file.name)) {
      window.alert('当前仅支持 .docx 文件');
      return;
    }
    if (sessionIsRunning) return;

    let sessionId = activeSession?.id;
    if (!sessionId) {
      const session = createSession();
      sessionId = session.id;
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
    }

    const assistantId = crypto.randomUUID();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: `请审核 Word 文件《${file.name}》。`,
      createdAt: Date.now(),
    };
    const pendingMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '正在解析 Word、逐段比对 PDF 证据，并检查数据、单位和语义问题…',
      pending: true,
      createdAt: Date.now(),
    };

    updateSession(sessionId, (session) => ({
      ...session,
      title: session.messages.length === 0 ? `审核 ${file.name}` : session.title,
      messages: [...session.messages, userMessage, pendingMessage],
      updatedAt: Date.now(),
    }));

    const patchAssistant = (patch: Partial<ChatMessage>) => {
      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) => (
          message.id === assistantId ? { ...message, ...patch } : message
        )),
        updatedAt: Date.now(),
      }));
    };

    try {
      const form = new FormData();
      form.append('file', file);
      form.append('conversationId', sessionId);
      const response = await csrfFetch('/api/chat/word-review', { method: 'POST', body: form });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.code !== 0) throw new Error(payload?.message || 'Word 审核失败');
      const reviewTask = payload.data?.reviewTask as ReviewTask;
      patchAssistant({
        content: payload.data?.assistantMessage?.content || 'Word 审核完成。',
        reviewTask,
        pending: false,
      });
      await refreshConversations();
    } catch (error) {
      patchAssistant({
        content: error instanceof Error ? error.message : String(error),
        error: true,
        pending: false,
      });
    } finally {
      if (wordInputRef.current) wordInputRef.current.value = '';
    }
  };

  const openReviewIssue = (issue: ReviewIssue) => {
    if (!issue.docId || !issue.page) return;
    setPreviewChunk({
      id: issue.blockId || issue.id,
      content: issue.evidenceText || issue.sourceText,
      highlight: issue.evidenceText || issue.sourceText,
      document_id: issue.docId,
      document_keyword: issue.fileName || issue.docId,
      dataset_id: 'knowledge',
      similarity: issue.confidence,
      term_similarity: issue.confidence,
      vector_similarity: issue.confidence,
      page: issue.page,
      positions: [issue.page],
      bbox: issue.bbox || [],
    });
  };

  const sendMessage = async (
    preset?: string,
    options: { regenerate?: boolean; assistantMessageId?: string } = {},
  ) => {
    const question = (preset ?? input).trim();
    if (!question || sessionIsRunning) return;

    let sessionId = activeSession?.id;
    if (!sessionId) {
      const session = createSession();
      sessionId = session.id;
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
    }

    const assistantId = crypto.randomUUID();
    const pendingMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      pending: true,
      createdAt: Date.now(),
    };
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: question,
      createdAt: Date.now(),
    };

    setInput('');
    setSessions((current) => current.map((session) => {
      if (session.id !== sessionId) return session;
      const baseMessages = options.regenerate
        ? session.messages.filter((message) => message.id !== options.assistantMessageId)
        : [...session.messages, userMessage];
      return {
        ...session,
        title: session.messages.length === 0 ? question.slice(0, 18) : session.title,
        messages: [...baseMessages, pendingMessage],
        updatedAt: Date.now(),
      };
    }));

    let streamed = '';
    const patchAssistant = (patch: Partial<ChatMessage>) => {
      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) => (
          message.id === assistantId ? { ...message, ...patch } : message
        )),
        updatedAt: Date.now(),
      }));
    };

    const controller = new AbortController();
    streamAbortRef.current = controller;

    try {
      const response = await csrfFetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: sessionId,
          question,
          regenerate: Boolean(options.regenerate),
          assistantMessageId: options.assistantMessageId,
        }),
        signal: controller.signal,
      });
      if (response.status === 401) {
        setAuthState('anonymous');
        throw new Error('登录已过期，请重新登录');
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || `回答失败: HTTP ${response.status}`);
      }

      let completed = false;
      await consumeSse(response, (event, payload) => {
        if (event === 'meta' && payload.conversationId) {
          setActiveSessionId(payload.conversationId);
        }
        if (event === 'citations') {
          patchAssistant({ exact: payload.exact || [], similar: payload.similar || [] });
        }
        if (event === 'token' && payload.token) {
          streamed += payload.token;
          patchAssistant({ content: streamed, pending: true });
        }
        if (event === 'done') {
          completed = true;
          if (payload.conversationId) setActiveSessionId(payload.conversationId);
          patchAssistant({ content: payload.answer || streamed, pending: false });
          void refreshConversations();
        }
        if (event === 'error') {
          throw new Error(payload.message || '回答生成失败');
        }
      });
      if (!completed) throw new Error('回答连接提前结束');
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      patchAssistant({
        content: aborted
          ? `${streamed}${streamed ? '\n\n' : ''}[已停止]`
          : error instanceof Error ? error.message : String(error),
        error: !aborted,
        pending: false,
      });
      if (aborted) void refreshConversations();
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
    }
  };

  const stopGeneration = () => {
    streamAbortRef.current?.abort();
  };

  const regenerateMessage = (sessionId: string, assistantId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    const index = session.messages.findIndex((message) => message.id === assistantId);
    const previousUser = [...session.messages.slice(0, Math.max(index, 0))].reverse().find((message) => message.role === 'user');
    if (previousUser) {
      void sendMessage(previousUser.content, { regenerate: true, assistantMessageId: assistantId });
    }
  };

  const allServicesOnline = health?.checks?.every((service) => service.reachable) ?? false;

  if (authState === 'checking') {
    return (
      <div className="auth-page">
        <div className="auth-loading"><LoaderCircle size={26} className="spin" /><span>正在进入知索…</span></div>
      </div>
    );
  }

  if (authState === 'anonymous') {
    return (
      <LoginScreen
        username={loginUsername}
        password={loginPassword}
        error={loginError}
        loading={loginLoading}
        onUsernameChange={setLoginUsername}
        onPasswordChange={setLoginPassword}
        onSubmit={() => void login()}
      />
    );
  }

  return (
    <div className="chat-app">
      <aside className={`chat-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <span className="brand-mark">知</span>
          <strong>知索</strong>
          <button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏"><X size={18} /></button>
        </div>

        <button className="new-chat-button" onClick={newSession}>
          <MessageSquarePlus size={18} />新建会话
        </button>

        <section className="sidebar-section sessions-section">
          <div className="sidebar-section-heading">
            <span>会话</span>
            <small>{sessions.length}</small>
          </div>
          <div className="session-list">
          {sessions.map((session) => {
            const running = session.messages.some((message) => message.pending);
            const editing = editingSessionId === session.id;
            const menuOpen = openSessionMenuId === session.id;
            return (
              <div className={`session-item ${session.id === activeSession?.id ? 'active' : ''} ${running ? 'running' : ''} ${menuOpen ? 'menu-open' : ''}`} key={session.id}>
                {editing ? (
                  <input
                    className="session-title-input"
                    value={editingTitle}
                    autoFocus
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveRename(session.id);
                      if (event.key === 'Escape') cancelRename();
                    }}
                    onBlur={() => saveRename(session.id)}
                  />
                ) : (
                  <button className="session-select" onClick={() => {
                    setActiveSessionId(session.id);
                    setOpenSessionMenuId('');
                    setDeleteConfirmId('');
                    setSidebarOpen(false);
                  }}>
                    <span>{session.title || '新会话'}</span>
                    <small>{new Date(session.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small>
                  </button>
                )}

                <div
                  className="session-menu-anchor"
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  {running && <span className="session-running" title="正在执行"><LoaderCircle size={13} className="spin" /></span>}
                  {!editing && (
                    <button className="session-more" onClick={(event) => {
                      event.stopPropagation();
                      setOpenSessionMenuId(menuOpen ? '' : session.id);
                      setDeleteConfirmId('');
                    }} aria-label="会话操作">
                      <MoreHorizontal size={15} />
                    </button>
                  )}

                  {menuOpen && (
                    <div className="session-popover">
                      {deleteConfirmId === session.id ? (
                        <div className="session-confirm">
                          <span>确认删除这个会话？</span>
                          <div>
                            <button className="danger" onClick={(event) => { event.stopPropagation(); deleteSession(session.id); }}>删除</button>
                            <button onClick={(event) => { event.stopPropagation(); setDeleteConfirmId(''); }}>取消</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <button onClick={(event) => { event.stopPropagation(); startRename(session); }}><Pencil size={13} />重命名</button>
                          <button onClick={(event) => { event.stopPropagation(); setDeleteConfirmId(session.id); }}><Trash2 size={13} />删除会话</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          </div>
        </section>

        <section className="sidebar-management">
          <div className="sidebar-section-heading"><span>管理</span></div>
          <button className="sidebar-tool" onClick={() => setKnowledgeOpen(true)}>
            <span className="sidebar-tool-icon"><Library size={17} /></span>
            <span className="sidebar-tool-copy"><strong>知识库</strong><small>{completedCount} 份文档已入库</small></span>
            <ChevronRight size={15} />
          </button>
          <button className="sidebar-tool" onClick={() => setSystemOpen(true)}>
            <span className="sidebar-tool-icon"><Settings2 size={17} /></span>
            <span className="sidebar-tool-copy"><strong>系统设置</strong><small>服务状态与退出</small></span>
            <ChevronRight size={15} />
          </button>
        </section>
      </aside>

      {sidebarOpen && <div className="mobile-backdrop" onClick={() => setSidebarOpen(false)} />}

      <main className="chat-main">
        <header className="chat-header">
          <button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开会话列表"><Menu size={20} /></button>
          <div>
            <strong>{activeSession?.title || '新会话'}</strong>
            <span className={`status-dot ${allServicesOnline ? 'online' : 'offline'}`} />
            {sessionIsRunning && <span className="header-running"><LoaderCircle size={12} className="spin" />执行中</span>}
          </div>
        </header>

        <section className={`chat-scroll ${activeSession?.messages.length ? 'has-messages' : 'empty-chat'}`}>
          {!activeSession?.messages.length ? (
            <div className="chat-welcome">
              <span className="welcome-icon"><Sparkles size={28} /></span>
              <h1>你好，我是知索</h1>
              <div className="suggestion-row">
                <button onClick={() => void sendMessage('帮我总结一下当前知识库的主要内容')}>总结已上传资料</button>
                <button onClick={() => void sendMessage('帮我查找发票号码相关的信息')}>查找发票内容</button>
                <button onClick={() => setKnowledgeOpen(true)}>上传新的 PDF</button>
                <button onClick={() => wordInputRef.current?.click()}>审核 Word 文件</button>
              </div>
            </div>
          ) : (
            <div className="message-list">
              {activeSession.messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onSelectChunk={setPreviewChunk}
                  onOpenReviewIssue={openReviewIssue}
                  onRegenerate={message.role === 'assistant' && activeSession ? () => regenerateMessage(activeSession.id, message.id) : undefined}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}

        </section>

        <div className="composer-dock">
          <div className="composer-wrap">
            <div className="composer">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder="仅支持知识库问题：查找文字或直接提问…"
                rows={activeSession?.messages.length ? 1 : 2}
              />
              <div className="composer-footer">
                <div className="composer-actions">
                  <button
                    className="composer-tool word-review-button"
                    type="button"
                    onClick={() => wordInputRef.current?.click()}
                    disabled={sessionIsRunning}
                    title="上传 Word 进行一致性审核"
                  >
                    <FileText size={15} />
                    <span>审核 Word</span>
                  </button>
                  <span>{completedCount ? `${completedCount} 份文档可检索` : '请先在知识库中上传资料'}</span>
                </div>
                {sessionIsRunning ? (
                  <button className="send-button stop" onClick={stopGeneration} title="停止生成">
                    <Square size={15} />
                  </button>
                ) : (
                  <button className="send-button" onClick={() => void sendMessage()} disabled={!input.trim()}>
                    <Send size={18} />
                  </button>
                )}
              </div>
            </div>
            <small>仅知识库检索 · Enter 发送 · Shift + Enter 换行</small>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          hidden
          onChange={(event) => event.target.files && void uploadPdfs(event.target.files)}
        />
        <input
          ref={wordInputRef}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          hidden
          onChange={(event) => event.target.files?.[0] && void sendWordReview(event.target.files[0])}
        />
      </main>

      {knowledgeOpen && (
        <KnowledgeDrawer
          dataset={selectedDataset}
          documents={documents}
          completedCount={completedCount}
          processingCount={processingCount}
          failedCount={failedCount}
          uploading={uploading}
          loading={workspaceLoading}
          onUpload={uploadPdfs}
          onRefresh={() => void refreshDocuments()}
          onRetry={() => void retryDocuments()}
          onDelete={deletePdf}
          onReindex={reindexPdf}
          onDownload={downloadPdf}
          onClose={() => setKnowledgeOpen(false)}
        />
      )}

      {systemOpen && (
        <SystemDrawer
          health={health}
          username={consoleUser}
          role={consoleRole}
          users={users}
          userLoading={userLoading}
          userError={userError}
          newUsername={newUsername}
          newPassword={newPassword}
          newRole={newRole}
          onUsernameChange={setNewUsername}
          onPasswordChange={setNewPassword}
          onRoleChange={setNewRole}
          onCreateUser={() => void createUserAccount()}
          onDeleteUser={(userId) => void deleteUserAccount(userId)}
          onUpdateUser={(userId, patch) => void updateUserAccount(userId, patch)}
          onRefresh={() => void refreshHealth()}
          onLogout={() => void logout()}
          onClose={() => setSystemOpen(false)}
          showUserManagement={userManagementEnabled}
        />
      )}

      {previewChunk && <PdfEvidenceModal chunk={previewChunk} onClose={() => setPreviewChunk(null)} />}
    </div>
  );
}

function LoginScreen({
  username,
  password,
  error,
  loading,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: {
  username: string;
  password: string;
  error: string;
  loading: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand"><span className="brand-mark">知</span><strong>知索</strong></div>
        <h1>欢迎回来</h1>
        <label className="auth-field">
          <span>账号</span>
          <div><UserRound size={17} /><input value={username} onChange={(event) => onUsernameChange(event.target.value)} autoComplete="username" /></div>
        </label>
        <label className="auth-field">
          <span>密码</span>
          <div><LockKeyhole size={17} /><input type="password" value={password} onChange={(event) => onPasswordChange(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && onSubmit()} autoComplete="current-password" /></div>
        </label>
        {error && <div className="auth-error"><XCircle size={16} />{error}</div>}
        <button className="button primary auth-submit" onClick={onSubmit} disabled={loading || !username.trim() || !password}>
          {loading ? <LoaderCircle size={18} className="spin" /> : <ShieldCheck size={18} />}登录
        </button>
      </div>
    </div>
  );
}

function MarkdownContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className={`markdown-body${streaming ? ' streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => (
            <div className="markdown-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function WordReviewResult({ task, onOpenIssue }: { task: ReviewTask; onOpenIssue: (issue: ReviewIssue) => void }) {
  return (
    <section className="chat-review-result">
      <div className="chat-review-heading">
        <div>
          <span className="eyebrow">Word 一致性审核</span>
          <strong>{task.issueCount ? `${task.issueCount} 个疑似问题` : '未发现明显问题'}</strong>
          <small>{task.fileName}</small>
        </div>
        <span className="status-pill done">{task.status === 'done' ? '已完成' : task.status}</span>
      </div>
      {!!task.issues.length && (
        <div className="review-issue-list chat-review-list">
          {task.issues.map((issue) => (
            <button className="review-issue" key={issue.id} onClick={() => onOpenIssue(issue)}>
              <div className="review-issue-head">
                <span className={`review-type ${issue.severity}`}>{issue.issueType}</span>
                {issue.page ? <span>第 {issue.page} 页</span> : null}
                <span>{Math.round(issue.confidence * 100)}%</span>
              </div>
              <p><strong>原文：</strong>{issue.sourceText}</p>
              {issue.evidenceText && <p><strong>证据：</strong>{issue.evidenceText}</p>}
              <p><strong>建议：</strong>{issue.suggestion || '需人工复核'}</p>
              <p className="review-reason">{issue.reason}</p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function MessageBubble({
  message,
  onSelectChunk,
  onOpenReviewIssue,
  onRegenerate,
}: {
  message: ChatMessage;
  onSelectChunk: (chunk: Chunk) => void;
  onOpenReviewIssue: (issue: ReviewIssue) => void;
  onRegenerate?: () => void;
}) {
  const sources = [...(message.exact || []), ...(message.similar || [])];
  if (message.role === 'user') {
    return <div className="message-row user"><div className="message-bubble">{message.content}</div></div>;
  }

  return (
    <div className="message-row assistant">
      <span className="assistant-avatar">知</span>
      <div className="assistant-content">
        <div className={`message-bubble ${message.error ? 'error' : ''}`}>
          {message.content ? (
            <MarkdownContent content={message.content} streaming={message.pending} />
          ) : (
            <span className="typing"><i /><i /><i /></span>
          )}
          {message.reviewTask && !message.pending && (
            <WordReviewResult task={message.reviewTask} onOpenIssue={onOpenReviewIssue} />
          )}
          {!message.pending && onRegenerate && (
            <button className="message-regenerate" onClick={onRegenerate}><RefreshCw size={12} />重新生成</button>
          )}
        </div>
        {!!sources.length && !message.pending && (
          <details className="source-panel">
            <summary><Search size={14} />查看检索依据 <span>{sources.length}</span></summary>
            <div className="source-groups">
              <SourceGroup title="精确命中" chunks={message.exact || []} tone="exact" onSelectChunk={onSelectChunk} />
              <SourceGroup title="相似结果" chunks={message.similar || []} tone="similar" onSelectChunk={onSelectChunk} />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function SourceGroup({
  title,
  chunks,
  tone,
  onSelectChunk,
}: {
  title: string;
  chunks: Chunk[];
  tone: 'exact' | 'similar';
  onSelectChunk: (chunk: Chunk) => void;
}) {
  if (!chunks.length) return null;
  return (
    <div className={`source-group ${tone}`}>
      <h4>{title}</h4>
      {chunks.slice(0, 3).map((chunk, index) => (
        <button
          type="button"
          className="source-item source-item-button"
          key={`${chunk.id}-${index}`}
          onClick={() => onSelectChunk(chunk)}
        >
          <div>
            <FileText size={13} />
            <span>{chunk.document_keyword || 'PDF 文档'}</span>
            {chunk.page ? <em>第 {chunk.page} 页</em> : null}
            <strong>{Math.round((chunk.similarity || 0) * 100)}%</strong>
          </div>
          <p>{stripHtml(chunk.highlight || chunk.content).slice(0, 260)}</p>
        </button>
      ))}
    </div>
  );
}

function PdfEvidenceModal({ chunk, onClose }: { chunk: Chunk; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pageImage, setPageImage] = useState<{
    image: string;
    width: number;
    height: number;
    page_width?: number;
    page_height?: number;
    page?: number;
  } | null>(null);

  useEffect(() => {
    if (!chunk.document_id || !chunk.page) {
      setError('该引用没有可用的文档或页码');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    const imagePath = chunk.id
      ? `/api/knowledge/documents/${encodeURIComponent(chunk.document_id)}/blocks/${encodeURIComponent(chunk.id)}/image`
      : `/api/knowledge/documents/${encodeURIComponent(chunk.document_id)}/pages/${encodeURIComponent(String(chunk.page))}/image`;
    csrfFetch(imagePath)
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.code !== 0) {
          throw new Error(payload?.message || `页面加载失败: HTTP ${response.status}`);
        }
        setPageImage(payload.data);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }, [chunk]);

  const pageWidth = pageImage?.page_width || pageImage?.width || 1;
  const pageHeight = pageImage?.page_height || pageImage?.height || 1;
  const bbox = chunk.bbox && chunk.bbox.length === 4 ? chunk.bbox : null;
  const boxStyle = bbox ? {
    left: `${(bbox[0] / pageWidth) * 100}%`,
    top: `${(bbox[1] / pageHeight) * 100}%`,
    width: `${((bbox[2] - bbox[0]) / pageWidth) * 100}%`,
    height: `${((bbox[3] - bbox[1]) / pageHeight) * 100}%`,
  } : undefined;

  return (
    <div className="evidence-modal-backdrop" onClick={onClose}>
      <section className="evidence-modal" onClick={(event) => event.stopPropagation()}>
        <header className="evidence-modal-header">
          <div>
            <span>检索依据</span>
            <h2>{chunk.document_keyword || 'PDF 文档'}</h2>
            <p>{chunk.page ? `第 ${chunk.page} 页` : '未知页码'} · {chunk.id}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="evidence-modal-body">
          <div className="evidence-page-preview">
            {loading && <div className="evidence-state"><LoaderCircle size={20} className="spin" />正在加载页面...</div>}
            {error && <div className="evidence-state error">{error}</div>}
            {pageImage && !error && (
              <div className="evidence-page-wrap">
                <img src={pageImage.image} alt={`${chunk.document_keyword || 'PDF'} 第 ${chunk.page} 页`} />
                {boxStyle && <span className="evidence-bbox" style={boxStyle} />}
              </div>
            )}
          </div>
          <aside className="evidence-copy">
            <h3>命中段落</h3>
            <p>{stripHtml(chunk.highlight || chunk.content)}</p>
            <dl>
              <div><dt>block_id</dt><dd>{chunk.id || '-'}</dd></div>
              <div><dt>bbox</dt><dd>{chunk.bbox?.join(', ') || '-'}</dd></div>
              <div><dt>相似度</dt><dd>{Math.round((chunk.similarity || 0) * 100)}%</dd></div>
            </dl>
          </aside>
        </div>
      </section>
    </div>
  );
}

function KnowledgeDrawer({
  dataset,
  documents,
  completedCount,
  processingCount,
  failedCount,
  uploading,
  loading,
  onUpload,
  onRefresh,
  onRetry,
  onDelete,
  onReindex,
  onDownload,
  onClose,
}: {
  dataset?: Dataset;
  documents: RagDocument[];
  completedCount: number;
  processingCount: number;
  failedCount: number;
  uploading: boolean;
  loading: boolean;
  onUpload: (files: FileList | File[]) => void;
  onRefresh: () => void;
  onRetry: () => void;
  onDelete: (document: RagDocument) => void;
  onReindex: (document: RagDocument) => void;
  onDownload: (document: RagDocument) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer knowledge-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div><span className="eyebrow">知识库</span><h2>已上传资料</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭知识库"><X size={19} /></button>
        </div>

        <div className="knowledge-metrics">
          <div><strong>{documents.length}</strong><span>全部文档</span></div>
          <div><strong>{completedCount}</strong><span>已入库</span></div>
          <div><strong>{processingCount}</strong><span>处理中</span></div>
        </div>

        <div className="drawer-upload" onClick={() => inputRef.current?.click()}>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            hidden
            onChange={(event) => event.target.files && onUpload(event.target.files)}
          />
          {uploading ? <LoaderCircle size={25} className="spin" /> : <UploadCloud size={25} />}
          <div><strong>{uploading ? '正在上传…' : '上传 PDF'}</strong><span>支持一次多选和后续分批追加</span></div>
        </div>

        <div className="drawer-document-actions">
          <button className="button secondary compact" onClick={onRefresh} disabled={loading}><RefreshCw size={15} />刷新</button>
          {failedCount > 0 && <button className="button secondary compact" onClick={onRetry}><RefreshCw size={15} />重试失败</button>}
        </div>

        <div className="drawer-document-list">
          {documents.map((document) => {
            const meta = runMeta[document.run] || runMeta.UNSTART;
            return (
              <div className="drawer-document" key={document.id}>
                <span className="document-icon"><FileText size={17} /></span>
                <div><strong>{document.name}</strong><small>{formatBytes(document.size)} · {document.chunk_count || 0} 个片段</small></div>
                <span className={`status-pill ${meta.tone}`}>{meta.label}</span>
                <span className="document-actions">
                  <button className="icon-button" onClick={() => onDownload(document)} title="下载原文件"><Download size={14} /></button>
                  <button className="icon-button" onClick={() => onReindex(document)} title="重新索引" disabled={loading}><RefreshCw size={14} /></button>
                  <button className="icon-button danger" onClick={() => onDelete(document)} title="删除文档" disabled={loading}><Trash2 size={14} /></button>
                </span>
              </div>
            );
          })}
          {!documents.length && (
            <div className="drawer-empty">
              <Files size={30} />
              <strong>还没有上传 PDF</strong>
              <span>上传后会自动解析并加入检索。</span>
            </div>
          )}
        </div>
        <p className="drawer-footnote">{dataset ? '所有 PDF 自动进入当前唯一知识库。' : '正在准备知识库…'}</p>
      </aside>
    </div>
  );
}

function SystemDrawer({
  health,
  username,
  role,
  users,
  userLoading,
  userError,
  newUsername,
  newPassword,
  newRole,
  onUsernameChange,
  onPasswordChange,
  onRoleChange,
  onCreateUser,
  onDeleteUser,
  onUpdateUser,
  onRefresh,
  onLogout,
  onClose,
  showUserManagement,
}: {
  health: HealthPayload | null;
  username: string;
  role: 'admin' | 'member';
  users: UserAccount[];
  userLoading: boolean;
  userError: string;
  newUsername: string;
  newPassword: string;
  newRole: 'admin' | 'member';
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onRoleChange: (value: 'admin' | 'member') => void;
  onCreateUser: () => void;
  onDeleteUser: (userId: string) => void;
  onUpdateUser: (userId: string, patch: Record<string, unknown>) => void;
  onRefresh: () => void;
  onLogout: () => void;
  onClose: () => void;
  showUserManagement: boolean;
}) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div><span className="eyebrow">系统设置</span><h2>服务状态</h2><p className="drawer-user">当前账号：{username} · {role === 'admin' ? '管理员' : '成员'}</p></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭系统设置"><X size={19} /></button>
        </div>
        <div className="service-list">
          {(health?.checks || []).map((service) => (
            <div className="service-row" key={service.id}>
              <span className={`status-dot ${service.reachable ? 'online' : 'offline'}`} />
              <div><strong>{service.label}</strong><small>{service.reachable ? `${service.detail} · ${service.latencyMs}ms` : service.detail}</small></div>
            </div>
          ))}
          {!health?.checks?.length && <div className="drawer-empty"><Server size={24} /><strong>正在读取服务状态</strong></div>}
        </div>

        {role === 'admin' && showUserManagement && (
          <section className="user-admin">
            <div className="user-admin-heading">
              <div><span className="eyebrow">管理员</span><h3>用户管理</h3></div>
              <span>{users.length} 个账号</span>
            </div>
            <div className="user-create-form">
              <input value={newUsername} onChange={(event) => onUsernameChange(event.target.value)} placeholder="用户名" />
              <input value={newPassword} onChange={(event) => onPasswordChange(event.target.value)} placeholder="初始密码" type="password" />
              <select value={newRole} onChange={(event) => onRoleChange(event.target.value as 'admin' | 'member')}>
                <option value="member">成员</option>
                <option value="admin">管理员</option>
              </select>
              <button className="button primary compact" onClick={onCreateUser} disabled={userLoading || !newUsername.trim() || !newPassword}>
                <UserRound size={15} />创建
              </button>
            </div>
            {userError && <div className="user-admin-error"><XCircle size={14} />{userError}</div>}
            <div className="user-list">
              {users.map((user) => (
                <div className="user-row" key={user.id}>
                  <span className="user-avatar"><UserRound size={15} /></span>
                  <div><strong>{user.username}</strong><small>{user.status === 'active' ? '已启用' : '已禁用'}</small></div>
                  <div className="user-row-actions">
                    <select
                      value={user.role}
                      onChange={(event) => onUpdateUser(user.id, { role: event.target.value })}
                      disabled={userLoading || user.username === username}
                      title="修改角色"
                    >
                      <option value="member">成员</option>
                      <option value="admin">管理员</option>
                    </select>
                    <button
                      className="icon-button"
                      disabled={userLoading || user.username === username}
                      onClick={() => onUpdateUser(user.id, { status: user.status === 'active' ? 'disabled' : 'active' })}
                      title={user.status === 'active' ? '禁用用户' : '启用用户'}
                    >
                      <ShieldCheck size={15} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={userLoading}
                      onClick={() => {
                        const password = window.prompt(`为 ${user.username} 设置新密码`);
                        if (password) onUpdateUser(user.id, { password });
                      }}
                      title="重置密码"
                    >
                      <LockKeyhole size={15} />
                    </button>
                    <button className="icon-button danger" onClick={() => onDeleteUser(user.id)} disabled={userLoading || user.username === username} title="删除用户">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
              {!users.length && <div className="drawer-empty"><UserRound size={24} /><strong>暂无其他用户</strong><span>可以创建成员账号。</span></div>}
            </div>
          </section>
        )}

        <div className="drawer-actions">
          <button className="button secondary" onClick={onRefresh}><RefreshCw size={16} />重新检查</button>
          <button className="button ghost" onClick={onLogout}><LogOut size={16} />退出登录</button>
        </div>
      </aside>
    </div>
  );
}

export default App;
