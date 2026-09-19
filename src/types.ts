/**
 * Image attachment reference stored in message state.
 * Contains metadata and a runtime blob: URL for rendering.
 * The `url` field is runtime-only — not persisted to IndexedDB snapshots.
 */
export interface ImageAttachment {
  id: string;              // Unique image ID (from SSE payload)
  storageKey: string;      // IndexedDB key: `${conversationId}/${id}`
  url: string;             // Runtime blob: URL (or empty string if not yet loaded)
  mimeType: string;
  size: number;
  createdAt: number;
  persistent: boolean;     // Whether successfully saved to IndexedDB
}

/**
 * SSE image event payload — enriched with metadata.
 * base64 is transmitted once for frontend persistence, then discarded.
 */
export interface ImageSsePayload {
  imageId: string;
  base64: string;
  mimeType?: string;
  size?: number;
}

/**
 * Claim context attached to a user message: which order the customer is
 * talking about and which (already indexed) evidence video rides along.
 * Persisted in the UI snapshot so the chips survive a refresh.
 */
export interface MessageMeta {
  orderId?: string;
  evidenceVideoId?: string;
  evidenceLabel?: string;
  /** Memories.ai summary of the clip (from /evidence-status or the demo note), if known when sent. */
  evidenceSummary?: string;
  evidenceSource?: 'upload' | 'demo';
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  images?: (ImageAttachment | string)[];  // ImageAttachment (new) or base64 string (legacy compat)
  meta?: MessageMeta;
  activity?: {
    type: 'web_search';
    label: string;
    status: 'active' | 'done' | 'error';
    /**
     * Optional in-memory error code that drives the in-bubble chip's CTA.
     * Currently only `wsa_missing` is recognised — emitted by the frontend
     * detector in App.tsx when a debug_msg surfaces a WSA_API_KEY-missing
     * tool error. Not persisted to /history; cleared the next time the
     * activity transitions back to `active`.
     */
    errorCode?: 'wsa_missing';
  };
  /**
   * True while the assistant is actively producing this message
   * (between the first text_delta and the final done/error event).
   * Drives the in-bubble blinking caret to give the user feedback
   * that more content is still streaming. Cleared once done/error fires.
   */
  streaming?: boolean;
}

/**
 * Lightweight summary of a conversation, returned by /conversations.
 * Used to render the left sidebar — does NOT contain full message content.
 */
export interface ConversationSummary {
  id: string;
  title: string;
  preview?: string;
  lastMessageAt?: number;
  createdAt?: number;
  userId?: string;
  messageCount?: number;
}

export interface ListConversationsParams {
  userId: string;
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
  before?: string;
}

export interface ListConversationsResponse {
  conversations: ConversationSummary[];
  nextCursor?: string;
  previousCursor?: string;
}

/* ═══════════════════════════════════════════════════════════════
   ClaimSight domain types (SPEC.md §1–§3)
   ═══════════════════════════════════════════════════════════════ */

/** Canonical actions the agent can take. Aliases are normalised in lib/decision.ts. */
export type ClaimAction = 'refund' | 'replacement' | 'escalated' | 'denied' | 'needs_info';

/**
 * Presentation fields the backend attaches to claims, decision blocks and
 * fraud matches. Every one is optional — the UI derives a fallback when the
 * backend has not produced it yet (see lib/labels.ts).
 */
export interface ClaimPresentation {
  /** Human-friendly claim number shown everywhere, e.g. "C-A1043-F809". */
  display_id?: string;
  /** Customer's name, e.g. "Alice Moreno" (customer_id stays as the small line). */
  customer_name?: string;
  /** Same-origin still from the evidence clip, e.g. /evidence/frames/<video_id>/3.jpg. */
  evidence_frame_url?: string;
  /** "Policy engine" or "AI model · <model>". */
  mode_label?: string;
}

/** The fenced ```decision block the agent appends to its final message. */
export interface Decision extends ClaimPresentation {
  claim_id?: string;
  order_id?: string;
  action: ClaimAction | string;
  amount?: number;
  currency?: string;
  policy_clauses: string[];
  evidence?: string;
  fraud_matches?: number;
  txn_id?: string;
  latency_ms?: number;
  reason?: string;
}

export type ClaimStatus = 'auto_approved' | 'pending_review' | 'approved' | 'denied' | 'replacement' | 'needs_info';

export interface FraudMatch {
  video_id?: string;
  claim_id?: string;
  display_id?: string;
  score?: number;
  customer_id?: string;
  customer_name?: string;
  order_id?: string;
}

/** One tool call the agent made while deciding a claim (stored on the record). */
export interface ToolCallTrace {
  name: string;
  started_at?: number;
  ended_at?: number;
  ok?: boolean;
  error?: string;
  output_preview?: string;
}

/** KV record `claims:<claim_id>` as returned by GET /claims. */
export interface ClaimRecord extends ClaimPresentation {
  claim_id: string;
  order_id?: string;
  customer_id?: string;
  sku?: string;
  video_id?: string;
  evidence_summary?: string;
  damage_assessment?: string;
  fraud?: {
    checked?: boolean;
    is_suspicious?: boolean;
    suspicious?: boolean;
    matches?: FraudMatch[];
    note?: string;
  };
  decision?: {
    action?: string;
    amount?: number;
    currency?: string;
    reason?: string;
    policy_clauses?: string[];
    by?: 'agent' | 'human' | string;
    txn_id?: string;
    note?: string;
    recommended_action?: string;
  };
  status?: ClaimStatus | string;
  created_at?: string | number;
  decided_at?: string | number;
  updated_at?: string | number;
  latency_ms?: number;
  conversation_id?: string;
  tool_calls?: ToolCallTrace[];
  model?: string;
  trace?: { trace_id?: string; emitted?: boolean; endpoint?: string; reason?: string };
}

/** Normalised shape of GET /stats that the top bar status uses. */
export interface BackendStatus {
  online: boolean;
  backend?: string;
  memoriesStubbed?: boolean;
  /** "Demo data" | "Live" — the product-facing word for the data source. */
  backendLabel?: string;
  /** "Policy engine" | "AI model · <model>". */
  modeLabel?: string;
  pendingReview?: number;
  checkedAt?: number;
}

/** KV record `counters`. */
export interface Counters {
  claims?: number;
  auto_approved?: number;
  escalated?: number;
  denied?: number;
  refunded_total?: number;
  fraud_flags?: number;
}

/** Normalised shape of GET /stats (counters + recent claims). */
export interface StatsSnapshot {
  counters: Counters;
  recent: ClaimRecord[];
  medianLatencyMs?: number;
  currency?: string;
}

export interface OrderItem {
  sku?: string;
  name?: string;
  qty?: number;
  unit_price?: number;
  category?: string;
}

/** KV record `orders:<order_id>` as returned by POST /orders-lookup. */
export interface OrderRecord {
  order_id: string;
  customer_id?: string;
  email?: string;
  placed_at?: string | number;
  status?: string;
  items?: OrderItem[];
  total?: number;
  currency?: string;
  shipping_address?: string;
  delivered_at?: string | number;
}

/** One entry of data/demo_evidence.json (GET /demo-evidence) or src/demoEvidence.ts. */
export interface DemoEvidence {
  label: string;
  video_id: string;
  order_id: string;
  note?: string;
}

export interface EvidenceUploadResponse {
  video_id: string;
  operation: string;
}

export interface EvidenceStatusResponse {
  done: boolean;
  progress?: number;      // 0–100 (or 0–1; normalised by the hook)
  stage?: string;         // free-form, e.g. "preprocess" | "index" | "derive"
  summary?: string;
  caption?: string;
  error?: string;
}

export type EvidenceStage = 'preprocess' | 'index' | 'derive';

/** UI state machine for the evidence attachment in the composer. */
export interface EvidenceState {
  status: 'idle' | 'uploading' | 'indexing' | 'ready' | 'error';
  source?: 'upload' | 'demo';
  videoId?: string;
  operation?: string;
  label?: string;
  orderId?: string;
  progress?: number;      // 0–100
  stage?: EvidenceStage;
  summary?: string;
  error?: string;
}
