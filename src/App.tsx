import { useState, useCallback, useEffect, useRef, useMemo, useReducer } from 'react';
import type {
  Message,
  MessageMeta,
  ImageAttachment,
  ImageSsePayload,
  ConversationSummary,
  EvidenceState,
} from './types';
import {
  deleteConversation,
  fetchConversationHistory,
  listConversations,
  sendMessageStream,
  stopAgent,
} from './api';
import type { RawSseEvent } from './api';
import { I18nProvider, useT } from './i18n';
import {
  base64ToBlob,
  saveImage,
  loadConversationImages,
  deleteConversationImages,
  createObjectUrl,
  revokeAllObjectUrls,
  makeStorageKey,
} from './lib/imageStore';
import { saveSnapshot, loadSnapshot, deleteSnapshot } from './lib/chatUiStore';
import { mergeConversations, removeLocalConversation, summarizeTitle, upsertLocalConversation } from './lib/localConversations';
import { extractDecision } from './lib/decision';
import { useTheme } from './lib/theme';
import { useBackendStatus } from './lib/useBackendStatus';
import { useClaimRecord } from './lib/useClaimRecord';
import { createTrace, traceReducer } from './lib/trace';
import TopBar from './components/TopBar';
import ChatWindow from './components/ChatWindow';
import ChatInput from './components/ChatInput';
import TracePanel, { type EvidenceView } from './components/TracePanel';
import ConversationSidebar from './components/ConversationSidebar';
import Drawer from './components/Drawer';
import RefundDesk from './components/RefundDesk';
import { type ViewId } from './components/ViewTabs';
import { IconAlert, IconReceipt } from './components/icons';
import styles from './App.module.css';

const CONVERSATION_ID_STORAGE_KEY = 'eo_conversation_id';
const EO_USER_ID_STORAGE_KEY = 'eo-uuid';
const CONVERSATIONS_PAGE_SIZE = 20;
/** How often the top bar probes GET /stats (status dot + Refund Desk badge). */
const STATUS_POLL_MS = 10_000;

/** Returns existing conversation ID from localStorage, or null if first visit */
function getExistingConversationId(): string | null {
  return localStorage.getItem(CONVERSATION_ID_STORAGE_KEY);
}

/** Returns existing or creates a new conversation ID */
function getOrCreateConversationId(): string {
  const cached = getExistingConversationId();
  if (cached) return cached;
  const conversationId = crypto.randomUUID();
  localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, conversationId);
  return conversationId;
}

/**
 * Stable user-level identifier persisted in localStorage. All conversations
 * created in this browser are scoped to this UUID (sent as `userId`).
 */
function getOrCreateEoUuid(): string {
  const cached = localStorage.getItem(EO_USER_ID_STORAGE_KEY);
  if (cached) return cached;
  const eoUuid = crypto.randomUUID();
  localStorage.setItem(EO_USER_ID_STORAGE_KEY, eoUuid);
  return eoUuid;
}

/** `#desk` deep-links straight into the Refund Desk (no router needed). */
function getViewFromHash(): ViewId {
  return window.location.hash.replace(/^#/, '') === 'desk' ? 'desk' : 'chat';
}

function isWebSearchToolEvent(event: RawSseEvent): boolean {
  if (event.eventType !== 'tool_called' || !event.data || typeof event.data !== 'object') return false;
  const tool = (event.data as { tool?: unknown }).tool;
  return tool === 'web_search' || tool === 'browser';
}

// Module-level dedup flag — outside React lifecycle, unaffected by StrictMode
let _historyFetchInFlight = false;

export default function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  );
}

function AppInner() {
  const { t } = useT();
  const { theme, toggle: toggleTheme } = useTheme();

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);

  // Top-level view: Chat | Refund Desk (mirrored into the URL hash).
  const [view, setViewState] = useState<ViewId>(getViewFromHash);
  const [deskPending, setDeskPending] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);

  // Backend reachability + mode for the top bar; also feeds the pending badge.
  const status = useBackendStatus(STATUS_POLL_MS);
  const pendingCount = view === 'desk' && deskPending !== null ? deskPending : (status.pendingReview ?? deskPending ?? 0);

  // Decision trace (right panel) — reduced from the SSE stream.
  const [trace, dispatchTrace] = useReducer(traceReducer, undefined, createTrace);
  const [debugEvents, setDebugEvents] = useState<RawSseEvent[]>([]);
  const [composerEvidence, setComposerEvidence] = useState<EvidenceState>({ status: 'idle' });

  // Conversation list state (Claims history drawer)
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsLoadingMore, setConversationsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [activeConversationId, setActiveConversationId] = useState<string>(() => getOrCreateConversationId());

  // Stable user identifier — derived once, never changes for the lifetime of this browser
  const eoUuidRef = useRef<string>(getOrCreateEoUuid());

  const botMsgIdRef = useRef<string>('');
  const abortCtrlRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string>(activeConversationId);

  useEffect(() => {
    conversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  // ── View switching (hash-synced, no router) ──
  const setView = useCallback((next: ViewId) => {
    setViewState(next);
    const hash = next === 'desk' ? '#desk' : '';
    if (window.location.hash !== hash) {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => setViewState(getViewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    document.title = t('app.title');
  }, [t]);

  // ── Persist UI snapshot whenever messages change (debounced) ──
  const initDoneRef = useRef(false);
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (messages.length === 0) return;
    if (!initDoneRef.current) return; // Skip snapshot save during restore phase
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      saveSnapshot(conversationIdRef.current, messages);
    }, 500);
    return () => {
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    };
  }, [messages]);

  /** Load a conversation's messages, snapshot and image cache and put them on screen. */
  const loadConversation = useCallback(async (convId: string) => {
    setHistoryLoading(true);
    setMessages([]);
    setDebugEvents([]);
    dispatchTrace({ type: 'reset' });
    initDoneRef.current = false;
    revokeAllObjectUrls();

    try {
      const [history, snapshot, storedImages] = await Promise.all([
        fetchConversationHistory(convId, eoUuidRef.current),
        loadSnapshot(convId),
        loadConversationImages(convId),
      ]);

      const imageUrlMap = new Map<string, { url: string; mimeType: string; size: number; storageKey: string }>();
      for (const record of storedImages) {
        const url = createObjectUrl(record.storageKey, record.blob);
        imageUrlMap.set(record.imageId, { url, mimeType: record.mimeType, size: record.size, storageKey: record.storageKey });
      }

      function rebuildImages(images: Message['images']): Message['images'] {
        if (!images || images.length === 0) return images;
        return images.map(img => {
          if (typeof img === 'string') return img;
          const urlInfo = imageUrlMap.get(img.id);
          return urlInfo ? { ...img, url: urlInfo.url, persistent: true } : img;
        });
      }

      let merged: Message[];
      if (snapshot.length > 0) {
        merged = snapshot.map(msg => ({ ...msg, images: rebuildImages(msg.images) }));
      } else if (history.length > 0) {
        merged = history;
      } else {
        merged = [];
      }
      setMessages(merged);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  /** Refresh the conversation list — usually after sending or switching. */
  const refreshConversations = useCallback(async (mode: 'replace' | 'append' = 'replace', cursor?: string) => {
    if (mode === 'append') setConversationsLoadingMore(true);
    else setConversationsLoading(true);
    try {
      const res = await listConversations({
        userId: eoUuidRef.current,
        limit: CONVERSATIONS_PAGE_SIZE,
        order: 'desc',
        after: cursor,
      });
      setNextCursor(res.nextCursor);
      if (mode === 'append') {
        setConversations(prev => {
          const seen = new Set(prev.map(c => c.id));
          const merged = [...prev];
          for (const c of res.conversations) {
            if (!seen.has(c.id)) merged.push(c);
          }
          return merged;
        });
      } else {
        setConversations(mergeConversations(res.conversations));
      }
    } finally {
      if (mode === 'append') setConversationsLoadingMore(false);
      else setConversationsLoading(false);
    }
  }, []);

  // Initial load: history (only if previously visited) + conversations list
  useEffect(() => {
    void refreshConversations('replace');
    if (!getExistingConversationId() || _historyFetchInFlight) {
      if (!getExistingConversationId()) setHistoryLoading(false);
      return;
    }
    _historyFetchInFlight = true;
    loadConversation(conversationIdRef.current).finally(() => {
      _historyFetchInFlight = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Update the current bot message's content via an updater function. */
  const updateBotMessage = useCallback((updater: (content: string) => string) => {
    setMessages(prev => prev.map(m => (m.id === botMsgIdRef.current ? { ...m, content: updater(m.content) } : m)));
  }, []);

  const setBotActivity = useCallback((activity: Message['activity']) => {
    setMessages(prev => prev.map(m => (m.id === botMsgIdRef.current ? { ...m, activity } : m)));
  }, []);

  const finishBotActivity = useCallback(() => {
    setMessages(prev => {
      let changed = false;
      const next = prev.map(m => {
        if (m.id === botMsgIdRef.current && m.activity?.status === 'active') {
          changed = true;
          return { ...m, activity: { ...m.activity, status: 'done' as const } };
        }
        return m;
      });
      return changed ? next : prev;
    });
  }, []);

  /** Clear the assistant message's `streaming` flag (hides the blinking caret). */
  const clearBotStreaming = useCallback(() => {
    setMessages(prev => {
      let changed = false;
      const next = prev.map(m => {
        if (m.id === botMsgIdRef.current && m.streaming) {
          changed = true;
          const { streaming, ...rest } = m;
          void streaming;
          return rest;
        }
        return m;
      });
      return changed ? next : prev;
    });
  }, []);

  /** Handle an incoming image SSE event: persist to IndexedDB and append ref to message. */
  const handleImageEvent = useCallback(async (payload: ImageSsePayload) => {
    const { imageId, base64, mimeType = 'image/png', size } = payload;
    const convId = conversationIdRef.current;
    const msgId = botMsgIdRef.current;
    const storageKey = makeStorageKey(convId, imageId);

    const blob = base64ToBlob(base64, mimeType);
    const actualSize = size || blob.size;
    let persistent = false;
    try {
      await saveImage({ conversationId: convId, messageId: msgId, imageId, blob, mimeType });
      persistent = true;
    } catch (e) {
      console.warn('[image] IndexedDB save failed, using temporary URL:', e);
    }

    const url = persistent ? createObjectUrl(storageKey, blob) : URL.createObjectURL(blob);
    const attachment: ImageAttachment = { id: imageId, storageKey, url, mimeType, size: actualSize, createdAt: Date.now(), persistent };
    setMessages(prev => prev.map(m => (m.id === msgId ? { ...m, images: [...(m.images || []), attachment] } : m)));
  }, []);

  const finishStream = useCallback(() => {
    setLoading(false);
    abortCtrlRef.current = null;
  }, []);

  const handleSend = useCallback(async (text: string, meta: MessageMeta = {}) => {
    initDoneRef.current = true;

    const hasMeta = Boolean(meta.orderId || meta.evidenceVideoId);
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      ...(hasMeta ? { meta } : {}),
    };

    const botMsgId = crypto.randomUUID();
    botMsgIdRef.current = botMsgId;
    const botMsg: Message = { id: botMsgId, role: 'assistant', content: '', timestamp: Date.now(), streaming: true };

    setMessages(prev => [...prev, userMsg, botMsg]);
    setLoading(true);
    setDebugEvents([]);
    dispatchTrace({ type: 'start', at: Date.now() });

    // Optimistic history-list update as soon as the backend emits its first SSE
    // event; also written to the local index so the drawer survives a backend
    // that cannot list conversations (local dev).
    let sidebarPrimed = false;
    const optimisticTitle = summarizeTitle(text, meta.orderId);

    const primeSidebar = () => {
      if (sidebarPrimed) return;
      sidebarPrimed = true;
      const convId = conversationIdRef.current;
      const now = Date.now();
      setConversations(prev => {
        const idx = prev.findIndex(c => c.id === convId);
        if (idx === -1) {
          const summary: ConversationSummary = { id: convId, title: optimisticTitle, lastMessageAt: now, createdAt: now, userId: eoUuidRef.current };
          upsertLocalConversation(summary);
          return [summary, ...prev];
        }
        const next = [...prev];
        const [moved] = next.splice(idx, 1);
        const bumped = { ...moved, lastMessageAt: now };
        upsertLocalConversation(bumped);
        next.unshift(bumped);
        return next;
      });
    };

    const ctrl = sendMessageStream(text, {
      onTextDelta(delta) {
        finishBotActivity();
        updateBotMessage(content => content + delta);
      },

      onToolCalled(toolName) {
        if (toolName === 'web_search' || toolName === 'browser') {
          setBotActivity({ type: 'web_search', label: 'Web searching...', status: 'active' });
        }
      },

      onImage(payload) {
        finishBotActivity();
        handleImageEvent(payload);
      },

      onRawEvent(event) {
        primeSidebar();
        dispatchTrace({ type: 'event', event, at: Date.now() });

        if (!isWebSearchToolEvent(event)) finishBotActivity();

        // WSA_API_KEY-missing tool errors (template web-search feature) surface as debug_msg previews.
        if (event.eventType === 'debug_msg') {
          const preview = (event.data as { preview?: string } | null)?.preview;
          if (
            typeof preview === 'string' &&
            preview.includes('WSA_API_KEY') &&
            (preview.includes('tool_result') || preview.includes('tool_use_result') || preview.includes('ToolResultBlock'))
          ) {
            setBotActivity({ type: 'web_search', label: 'Web search unavailable', status: 'error', errorCode: 'wsa_missing' });
          }
        }

        // Coalesce consecutive text_delta events into one growing entry for the raw log.
        if (event.eventType === 'text_delta') {
          const delta = (event.data as { delta?: string } | null)?.delta ?? '';
          setDebugEvents(prev => {
            const last = prev[prev.length - 1];
            if (last && last.eventType === 'text_delta') {
              const prevDelta = (last.data as { delta?: string } | null)?.delta ?? '';
              const merged: RawSseEvent = { ...last, data: { delta: prevDelta + delta }, raw: last.raw + delta, timestamp: event.timestamp };
              return [...prev.slice(0, -1), merged];
            }
            return [...prev, event];
          });
          return;
        }
        setDebugEvents(prev => [...prev, event]);
      },

      onDone() {
        finishBotActivity();
        clearBotStreaming();
        finishStream();
        dispatchTrace({ type: 'finish', at: Date.now() });
        void refreshConversations('replace');
        // The agent may just have escalated — light up the Refund Desk badge.
        void status.refresh();
      },

      onError(err) {
        finishBotActivity();
        clearBotStreaming();
        updateBotMessage(content => content || t('status.error'));
        finishStream();
        dispatchTrace({ type: 'finish', at: Date.now(), error: err.message });
      },
    }, conversationIdRef.current, { userMsgId: userMsg.id, botMsgId }, eoUuidRef.current, {
      orderId: meta.orderId,
      evidenceVideoId: meta.evidenceVideoId,
    });

    abortCtrlRef.current = ctrl;
  }, [updateBotMessage, setBotActivity, finishBotActivity, handleImageEvent, finishStream, refreshConversations, status, t]);

  const handleClearHistory = useCallback(() => {
    const oldConvId = conversationIdRef.current;
    // The trash button deletes the conversation entirely (same as the history drawer's trash icon).
    setConversations(prev => prev.filter(c => c.id !== oldConvId));
    removeLocalConversation(oldConvId);
    deleteConversation(oldConvId, eoUuidRef.current).then(ok => {
      if (!ok) console.warn('[delete-conversation] backend request failed');
    }).finally(() => {
      void refreshConversations('replace');
    });

    revokeAllObjectUrls();
    deleteConversationImages(oldConvId).catch(() => {});
    deleteSnapshot(oldConvId).catch(() => {});

    const newId = crypto.randomUUID();
    localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, newId);
    conversationIdRef.current = newId;
    setActiveConversationId(newId);
    setMessages([]);
    setDebugEvents([]);
    dispatchTrace({ type: 'reset' });
    initDoneRef.current = false;
  }, [refreshConversations]);

  const handleStop = useCallback(() => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    finishBotActivity();
    // fetch.abort() throws AbortError that sendMessageStream swallows — neither
    // onDone nor onError fires, so tidy up here.
    clearBotStreaming();
    updateBotMessage(content => (content ? `${content}\n\n${t('status.stopped')}` : t('status.stopped')));
    setLoading(false);
    dispatchTrace({ type: 'finish', at: Date.now(), stopped: true });

    stopAgent(conversationIdRef.current).then(ok => {
      if (!ok) updateBotMessage(content => `${content}\n\n${t('status.backendError')}`);
    });
  }, [finishBotActivity, clearBotStreaming, updateBotMessage, t]);

  /** User picked a conversation in the history drawer. */
  const handleSelectConversation = useCallback((id: string) => {
    if (loading) return;
    if (id === conversationIdRef.current) return;
    localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, id);
    conversationIdRef.current = id;
    setActiveConversationId(id);
    void loadConversation(id);
  }, [loading, loadConversation]);

  /** "New claim" in the history drawer. */
  const handleCreateConversation = useCallback(() => {
    if (loading) return;
    revokeAllObjectUrls();
    const newId = crypto.randomUUID();
    localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, newId);
    conversationIdRef.current = newId;
    setActiveConversationId(newId);
    setMessages([]);
    setDebugEvents([]);
    dispatchTrace({ type: 'reset' });
    initDoneRef.current = false;
    setHistoryLoading(false);
  }, [loading]);

  const handleLoadMoreConversations = useCallback(() => {
    if (!nextCursor || conversationsLoadingMore) return;
    void refreshConversations('append', nextCursor);
  }, [nextCursor, conversationsLoadingMore, refreshConversations]);

  /** Trash icon on a history item: optimistic delete, fire-and-forget backend call. */
  const handleDeleteConversation = useCallback((id: string) => {
    if (loading) return;
    if (!id) return;
    const confirmed = window.confirm(t('sidebar.deleteConfirm'));
    if (!confirmed) return;

    const isActive = id === conversationIdRef.current;
    setConversations(prev => prev.filter(c => c.id !== id));
    removeLocalConversation(id);

    if (isActive) {
      revokeAllObjectUrls();
      const newId = crypto.randomUUID();
      localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, newId);
      conversationIdRef.current = newId;
      setActiveConversationId(newId);
      setMessages([]);
      setDebugEvents([]);
      dispatchTrace({ type: 'reset' });
      initDoneRef.current = false;
      setHistoryLoading(false);
    }

    void deleteSnapshot(id).catch(() => {});
    void deleteConversationImages(id).catch(() => {});
    void deleteConversation(id, eoUuidRef.current).catch(e => {
      console.warn('[delete-conversation] backend request failed:', e);
    });
  }, [loading, t]);

  const sidebarHasMore = useMemo(() => Boolean(nextCursor), [nextCursor]);

  // ── Decision trace panel inputs ──
  const lastDecision = useMemo(() => {
    if (trace.decision) return trace.decision;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant' || !m.content) continue;
      const d = extractDecision(m.content, !!m.streaming).decision;
      if (d) return d;
    }
    return null;
  }, [trace.decision, messages]);

  const lastUserMeta = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && m.meta?.evidenceVideoId) return m.meta;
    }
    return null;
  }, [messages]);

  const evidenceView: EvidenceView | null = useMemo(() => {
    if (composerEvidence.status !== 'idle') {
      return {
        label: composerEvidence.label,
        videoId: composerEvidence.videoId,
        summary: composerEvidence.summary,
        source: composerEvidence.source,
        status: composerEvidence.status,
        progress: composerEvidence.progress,
        stage: composerEvidence.stage,
      };
    }
    if (lastUserMeta) {
      return {
        label: lastUserMeta.evidenceLabel,
        videoId: lastUserMeta.evidenceVideoId,
        summary: lastUserMeta.evidenceSummary,
        source: lastUserMeta.evidenceSource,
      };
    }
    return null;
  }, [composerEvidence, lastUserMeta]);

  const { record: traceRecord } = useClaimRecord(lastDecision?.claim_id, !!lastDecision);
  const clearDebug = useCallback(() => setDebugEvents([]), []);

  const tracePanel = (
    <TracePanel
      trace={trace}
      evidence={evidenceView}
      decision={lastDecision}
      record={traceRecord}
      debugEvents={debugEvents}
      onClearDebug={clearDebug}
    />
  );

  const offline = !status.checking && !status.online;

  return (
    <div className={styles.shell}>
      <TopBar
        view={view}
        onChangeView={setView}
        pendingCount={pendingCount}
        status={status}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenHistory={() => setHistoryOpen(true)}
        historyOpen={historyOpen}
      />

      {offline && (
        <div className={styles.offline} role="alert">
          <IconAlert size={14} />
          <span>{t('banner.offline')}</span>
        </div>
      )}

      <main className={styles.main}>
        {/* The chat stays mounted while the desk is open so an in-flight
            stream or evidence upload keeps running in the background. */}
        <div className={`${styles.chatStage} ${view === 'desk' ? styles.hidden : ''}`} aria-hidden={view === 'desk'}>
          <div className={styles.conversation}>
            <button type="button" className={`btn btn-sm ${styles.traceFab}`} onClick={() => setTraceOpen(true)}>
              <IconReceipt size={14} />
              {t('trace.open')}
            </button>
            <div className={styles.messagesShell}>
              <ChatWindow messages={messages} loading={loading} />
              {historyLoading && messages.length === 0 && (
                <div className={styles.historyOverlay}>
                  <div className={styles.historySpinner} />
                </div>
              )}
            </div>
            <div className={styles.composerShell}>
              <ChatInput
                onSend={handleSend}
                onStop={handleStop}
                onClear={handleClearHistory}
                disabled={loading}
                onEvidenceChange={setComposerEvidence}
              />
            </div>
          </div>
          <div className={styles.tracePane}>{tracePanel}</div>
        </div>

        {view === 'desk' && (
          <RefundDesk active onPendingCount={setDeskPending} onGoToChat={() => setView('chat')} />
        )}
      </main>

      <footer className={styles.footer}>
        <span>{t('footer.partners')}</span>
        <span className={styles.footerStore}>{t('footer.store')}</span>
      </footer>

      <ConversationSidebar
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        conversations={conversations}
        activeConversationId={activeConversationId}
        loading={conversationsLoading}
        loadingMore={conversationsLoadingMore}
        hasMore={sidebarHasMore}
        disabled={loading}
        onSelect={handleSelectConversation}
        onCreate={handleCreateConversation}
        onLoadMore={handleLoadMoreConversations}
        onDelete={handleDeleteConversation}
      />

      <Drawer open={traceOpen} onClose={() => setTraceOpen(false)} side="right" width={420} label={t('trace.title')} closeLabel={t('desk.detail.close')}>
        {tracePanel}
      </Drawer>
    </div>
  );
}
