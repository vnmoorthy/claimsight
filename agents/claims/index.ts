/**
 * ClaimSight agent — EdgeOne Makers
 * ==================================
 *
 * File path agents/claims/index.ts maps to **POST /claims**
 *
 * Body: `{ message, order_id?, evidence_video_id?, email?, stream?, skip_twin?, userId?, userMsgId?, botMsgId? }`
 *   - `skip_twin: true` (or header `x-claimsight-eval: 1`): never request a Damage Twin render for this
 *     claim (twin.status "skipped") — evaluations and load tests use it so they cannot fill the render queue
 *   - default: SSE stream (same events as the template chat: text_delta / tool_called / done …,
 *     plus `claim` at start and `decision` once the decision is recorded)
 *   - `stream: false`: runs the agent to completion and returns JSON `{ text, decision, … }`
 *     (used by the Python eval harness)
 *
 * The agent gets ONE custom MCP server (`claimsight`, see ./_tools.ts) and no built-in tools:
 * the sandbox MCP (`context.tools`) is deliberately NOT attached — the refund agent gets no
 * shell, files or browser (least privilege). Every claim ends with a fenced ```decision block
 * that the UI renders as a Decision Card; if the model forgets it, the handler appends the block
 * recorded by `record_decision`.
 */

import type { AgentContext } from '@edgeone/types';
import { createSdkMcpServer, getSessionInfo, query } from '@anthropic-ai/claude-agent-sdk';
import { collectGatewayEnv } from '../_model';
import { createLogger } from '../_logger';
import { createChatStream } from '../chat/_stream';
import {
  getClaimsStore, getPolicy, resolveEnv, newId, selfBaseUrl, jsonResponse, type Env, type Policy,
} from '../_kv';
import { createMemoriesClient } from '../_memories';
import { createClaimsTools, TOOL_NAMES, type ClaimsToolSet, type DecisionBlock } from './_tools';
import { runDeterministicClaim } from './_deterministic';

const logger = createLogger('claims');

const MCP_SERVER_NAME = 'claimsight';
const DEFAULT_MODEL = '@makers/deepseek-v4-pro';
const FALLBACK_MODEL = '@makers/kimi-k2.6';
const MAX_TURNS = 12;

export type AgentMode = 'llm' | 'deterministic';

/**
 * AGENT_MODE=llm|deterministic. Deterministic is auto-selected when no model credential is
 * configured (neither AI_GATEWAY_API_KEY nor ANTHROPIC_API_KEY) — the same tool sequence runs
 * in code (see ./_deterministic.ts). It is also the on-stage fallback for a flaky gateway.
 */
export function resolveAgentMode(env: Env): { mode: AgentMode; reason: string } {
  const explicit = env.AGENT_MODE?.trim().toLowerCase();
  if (explicit === 'deterministic') return { mode: 'deterministic', reason: 'AGENT_MODE=deterministic' };
  if (explicit === 'llm') return { mode: 'llm', reason: 'AGENT_MODE=llm' };
  const hasKey = !!(env.AI_GATEWAY_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim());
  return hasKey
    ? { mode: 'llm', reason: 'model key present' }
    : { mode: 'deterministic', reason: 'no AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY configured' };
}

/** Never forward these to the Claude CLI subprocess — the model must not be able to see them. */
const SECRET_ENV_KEYS = [
  'MEMORIES_API_KEY', 'SLACK_WEBHOOK_URL', 'AGENTX_API_KEY', 'ADMIN_TOKEN', 'VELODB_PASSWORD', 'PAGES_BLOB_TOKEN',
];

// The SDK writes to stdout; on the platform the pipe may close early — swallow EPIPE.
if (typeof process !== 'undefined' && process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err && err.code === 'EPIPE') return;
  });
}

const DECISION_RE = /```decision\s*([\s\S]*?)```/;

export function parseDecisionBlock(text: string): DecisionBlock | null {
  const m = DECISION_RE.exec(text);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim()) as DecisionBlock;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function formatDecisionBlock(block: DecisionBlock): string {
  return `\n\n\`\`\`decision\n${JSON.stringify(block)}\n\`\`\`\n`;
}

function normalizeUuid(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(trimmed) ? trimmed : null;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function buildSystemPrompt(policy: Policy, claimId: string): string {
  const clauses = Object.entries(policy.clauses).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  return [
    `You are ClaimSight, the after-sales specialist for ${policy.store}. You review the customer's evidence, apply the refund policy exactly as written, carry out the decision through the store's systems, and explain it in plain language. You are accurate, warm and brief.`,
    '',
    `You handle ONE claim per message. Its internal claim id is ${claimId} — pass it to execute_refund, create_replacement, escalate and record_decision, but never show it to the customer; the customer-facing reference is the display_id returned by lookup_order (for example C-A1043-F809).`,
    '',
    'Facts come only from tool results. Never guess or invent order details, what the video shows, fraud results, amounts or transaction ids. If a tool did not return it, you do not know it.',
    '',
    'Policy (get_policy returns the same text):',
    clauses,
    `  return_window_days=${policy.return_window_days}, auto_approve_limit=$${policy.auto_approve_limit}, replacement_first_categories=${policy.replacement_first_categories.join('/')}, fraud similarity threshold=${policy.fraud.similarity_threshold} (action: ${policy.fraud.action}).`,
    '',
    'Procedure — call the tools in exactly this order, one at a time, waiting for each result before the next call:',
    '1. lookup_order — with the order_id from the intake context (or the customer message). If found is false, reply with its customer_message only and stop: no further tool calls and no record_decision (the claim is parked automatically).',
    '2. get_policy.',
    '3. inspect_evidence — with the evidence_video_id. If no video is attached and no intake evidence summary is given, ask the customer to attach a short video of the damage and stop (no further tool calls, no record_decision).',
    '4. fraud_check — always, immediately after inspect_evidence (skip only when there is no video).',
    '5. Decide, testing the rules in this order and citing every clause you rely on:',
    '   a. within_return_window is false → action "denied", clauses [P1]. No execution.',
    '   b. the item is apparel and the evidence shows it was worn (looks_worn) → "denied", [P6].',
    '   c. damage_confirmed is false (no damage visible, evidence not ready, or the evidence shows a different product) → escalate with recommended_action "deny", clauses [P2] (a teammate decides).',
    '   d. fraud_check.is_suspicious → escalate with recommended_action "deny", [P5, P2].',
    '   e. the damaged item\'s line_total is above auto_approve_limit → escalate with recommended_action "refund" (or "replacement" if replacement_possible), [P3, P2].',
    '   f. the item is replacement_first and replacement_possible, and the customer has not explicitly refused a replacement → create_replacement, clauses [P2, P4].',
    '   g. otherwise → execute_refund for the damaged item\'s line_total (never more than the customer paid), clauses [P2] (add P4 when the item is replacement-first but out of stock).',
    '6. Execute exactly one of: execute_refund / create_replacement (auto-approvable cases) or escalate (anything a teammate must decide). Denials need no execution. If a server call is rejected, do not retry: follow its next_step (requires_human_approval → escalate; out_of_stock → execute_refund) and reuse its `reason` text.',
    '7. record_decision — always, exactly once, as the LAST tool call, with the action, amount, clauses, evidence_summary and txn_id (when one exists).',
    '',
    'Writing the reason (escalate.reason, record_decision.reason): one plain-English sentence a customer could read, e.g. "Evidence matches footage submitted for order A1042 by another customer (similarity 0.93)" or "Refund needs a teammate: a refund was already issued for this order". Never include video ids, customer ids, claim ids, thresholds or error codes — those stay in the structured tool results.',
    '',
    'Reply to the customer in under 120 words, 2–5 sentences: what the evidence showed, which rule applied, and what happens next — the transaction id when a refund or replacement was issued, or the display_id reference and that a teammate will review it. Do not reveal customer ids, video ids, fraud scores or thresholds. If the message is not about a damaged or defective item, answer briefly without calling any tool.',
    '',
    'Output contract: the final message MUST end with a fenced block containing the `decision` object returned by record_decision, copied verbatim (it already includes display_id, mode_label and evidence_frame_url), valid JSON on a single line:',
    '```decision',
    '{"claim_id":"…","display_id":"C-A1042-F809","order_id":"A1042","action":"refund|replacement|escalated|denied","amount":24.0,"policy_clauses":["P2","P4"],"reason":"…","evidence":"white ceramic mug, chip on rim at 0:03","evidence_frame_url":"/evidence/frames/…/3.jpg","fraud_matches":0,"txn_id":"txn_…","latency_ms":18342,"mode":"llm","mode_label":"AI model · …"}',
    '```',
    'Nothing may follow the block. Never say a refund or replacement was issued unless you hold a txn_id from execute_refund / create_replacement. Amounts are USD numbers.',
  ].join('\n');
}

function buildUserPrompt(message: string, claimId: string, hints: { orderId?: string; videoId?: string; email?: string; evidenceSummary?: string }): string {
  const lines = [
    `Customer message: ${message}`,
    '',
    'Context from the claim intake form:',
    `- claim_id: ${claimId}`,
    `- order_id: ${hints.orderId ?? 'not provided (look for it in the message, otherwise ask)'}`,
    `- evidence_video_id: ${hints.videoId ?? 'none attached'}`,
  ];
  if (hints.email) lines.push(`- customer_email: ${hints.email}`);
  if (!hints.videoId && hints.evidenceSummary) {
    lines.push(`- intake evidence summary (no video available, treat as the evidence description; fraud_check cannot run): ${hints.evidenceSummary}`);
  }
  return lines.join('\n');
}

async function resolveSessionBinding(
  store: AgentContext['store'] | undefined,
  sessionStore: unknown,
  conversationId: string,
  cwd: string,
): Promise<{ sessionId?: string; resume?: string }> {
  if (!conversationId) return {};
  try {
    const binder = (store as { claudeSessionBinding?: (id: string) => Promise<unknown> } | undefined)?.claudeSessionBinding;
    if (typeof binder === 'function' && sessionStore) {
      const binding = await binder.call(store, conversationId);
      const sessionId = typeof binding === 'string' ? binding : (binding as { sessionId?: string } | null)?.sessionId;
      if (sessionId) {
        const info = await getSessionInfo(sessionId, { dir: cwd, sessionStore: sessionStore as any });
        return info ? { resume: sessionId } : { sessionId };
      }
    }
  } catch (e) {
    logger.error('[session] claudeSessionBinding failed, falling back to UUID binding:', e);
  }
  const sessionId = normalizeUuid(conversationId);
  if (!sessionId) return {};
  try {
    const opts: Record<string, unknown> = { dir: cwd };
    if (sessionStore) opts.sessionStore = sessionStore;
    const info = await getSessionInfo(sessionId, opts as any);
    if (info) return { resume: sessionId };
  } catch (e) {
    logger.error('[session] failed to inspect session store:', e);
  }
  return { sessionId };
}

function buildAgentOptions(input: {
  env: Env;
  model: string;
  fallbackModel: string;
  systemPrompt: string;
  mcpServer: unknown;
  allowedTools: string[];
  sessionStore?: unknown;
  sessionId?: string;
  resume?: string;
}): Record<string, any> {
  const subprocessEnv: Record<string, string | undefined> = { ...input.env };
  for (const key of SECRET_ENV_KEYS) delete subprocessEnv[key];
  const options: Record<string, any> = {
    model: input.model,
    fallbackModel: input.fallbackModel,
    systemPrompt: input.systemPrompt,
    cwd: process.cwd(),
    // Least privilege: no built-in Claude Code tools, no sandbox MCP — only the claimsight server.
    tools: [],
    allowedTools: input.allowedTools,
    permissionMode: 'bypassPermissions',
    settings: {
      permissions: {
        defaultMode: 'dontAsk',
        disableBypassPermissionsMode: 'disable',
      },
    },
    maxTurns: MAX_TURNS,
    mcpServers: { [MCP_SERVER_NAME]: input.mcpServer },
    env: {
      ...subprocessEnv,
      ...collectGatewayEnv(input.env),
      CLAUDE_CONFIG_DIR: input.env.CLAUDE_CONFIG_DIR ?? '/tmp/claude-agent-sdk',
      CLAUDE_CODE_TMPDIR: input.env.CLAUDE_CODE_TMPDIR ?? '/tmp',
    },
    stderr: (line: string) => logger.error('[claude-cli stderr]', line),
  };
  if (input.sessionStore) options.sessionStore = input.sessionStore;
  if (input.resume) options.resume = input.resume;
  else if (input.sessionId) options.sessionId = input.sessionId;
  return options;
}

/** Run the agent to completion (stream:false). */
async function runToCompletion(
  prompt: string,
  options: Record<string, any>,
  signal: AbortSignal | undefined,
): Promise<{ text: string; stopped: boolean; error?: string; sessionId?: string; numTurns?: number }> {
  const abortController = new AbortController();
  if (signal?.aborted) abortController.abort();
  else signal?.addEventListener('abort', () => abortController.abort(), { once: true });

  let lastAssistantText = '';
  let finalText = '';
  let error: string | undefined;
  let stopped = false;
  let sessionId: string | undefined;
  let numTurns: number | undefined;
  try {
    const q = query({ prompt, options: { ...options, abortController } });
    for await (const msg of q) {
      if (signal?.aborted) { stopped = true; break; }
      if (msg.type === 'assistant') {
        const blocks = (msg.message?.content ?? []) as Array<{ type: string; text?: string }>;
        const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
        if (text.trim()) lastAssistantText = text;
        if (msg.error) logger.error('[claims] assistant error:', msg.error);
      } else if (msg.type === 'result') {
        sessionId = msg.session_id;
        numTurns = msg.num_turns;
        if (msg.subtype === 'success') {
          finalText = msg.result || lastAssistantText;
        } else {
          const errs = (msg as { errors?: unknown }).errors;
          error = `${msg.subtype}${errs ? `: ${JSON.stringify(errs).slice(0, 500)}` : ''}`;
          finalText = lastAssistantText;
        }
        break;
      }
    }
  } catch (e) {
    const err = e as Error;
    if (err?.name === 'AbortError' || signal?.aborted) {
      stopped = true;
    } else {
      logger.error('[claims] run failed:', err?.message, (err as { cause?: unknown })?.cause ?? '');
      error = String(err?.message ?? e);
    }
    finalText = lastAssistantText;
  }
  return { text: finalText, stopped, error, sessionId, numTurns };
}

function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Pass the template SSE stream through untouched, but (a) announce the claim id up front,
 * (b) emit a `decision` event as soon as record_decision has run, and (c) append the fenced
 * decision block as a final text_delta if the model's text does not already contain one.
 */
function wrapDecisionStream(
  inner: ReadableStream<Uint8Array>,
  toolset: ClaimsToolSet,
  claimId: string,
  mode: AgentMode,
): ReadableStream<Uint8Array> {
  const { state, finalizeNeedsInfo } = toolset;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let decisionEmitted = false;

  const emitDecisionIfReady = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (decisionEmitted || !state.recorded) return;
    decisionEmitted = true;
    controller.enqueue(encoder.encode(sseFrame('decision', {
      claim_id: claimId,
      display_id: state.recorded.block.display_id,
      decision: state.recorded.block,
      status: state.recorded.claim.status,
      mode,
      mode_label: state.modeLabel,
      trace_id: state.recorded.trace_id ?? null,
      agentx_emitted: state.recorded.agentx_emitted,
    })));
  };

  const transformer: Transformer<Uint8Array, Uint8Array> = {
    start(controller) {
      controller.enqueue(encoder.encode(sseFrame('claim', {
        claim_id: claimId, display_id: state.displayId, status: 'processing', mode, mode_label: state.modeLabel,
      })));
    },
    async transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (!part.trim()) continue;
        emitDecisionIfReady(controller);
        let event = '';
        let data = '';
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (event === 'text_delta') {
          try { text += (JSON.parse(data) as { delta?: string }).delta ?? ''; } catch { /* ignore */ }
        }
        if (event === 'done') {
          // Unknown order / no evidence: park the claim (needs_info) so the desk sees it — no ledger writes.
          if (!state.recorded && state.needsInfo) {
            const fin = await finalizeNeedsInfo();
            if (fin && !text.trim()) {
              controller.enqueue(encoder.encode(sseFrame('text_delta', { delta: state.needsInfo.customer_message })));
            }
          }
          emitDecisionIfReady(controller);
          if (state.recorded && !DECISION_RE.test(text)) {
            controller.enqueue(encoder.encode(sseFrame('text_delta', { delta: formatDecisionBlock(state.recorded.block) })));
          }
        }
        controller.enqueue(encoder.encode(`${part}\n\n`));
      }
    },
    flush(controller) {
      if (buffer.trim()) controller.enqueue(encoder.encode(buffer));
    },
  };
  return inner.pipeThrough(new TransformStream(transformer));
}

export async function onRequest(context: AgentContext) {
  const startedAt = Date.now();
  const body = (context.request?.body ?? {}) as Record<string, unknown>;
  const message = str(body.message) ?? '';
  if (!message) return jsonResponse({ error: "'message' is required" }, 400);

  const streamMode = !(body.stream === false || body.stream === 'false' || body.stream === 0);
  const userMsgId = str(body.userMsgId);
  const botMsgId = str(body.botMsgId);
  const userId = str(body.userId) ?? str(body.user_id);
  const headers = (context.request?.headers ?? {}) as Record<string, string | undefined>;
  const evalHeader = headers['x-claimsight-eval'] ?? headers['X-Claimsight-Eval'];
  const skipTwin = body.skip_twin === true || body.skip_twin === 'true' || body.skip_twin === 1
    || (typeof evalHeader === 'string' && ['1', 'true', 'yes'].includes(evalHeader.trim().toLowerCase()));
  const hints = {
    orderId: str(body.order_id) ?? str(body.orderId),
    videoId: str(body.evidence_video_id) ?? str(body.video_id) ?? str(body.videoId),
    email: str(body.email),
    evidenceSummary: str(body.evidence_summary) ?? str(body.evidence_summary_stub),
    skipTwin,
  };

  const env = resolveEnv(context.env);
  const signal: AbortSignal | undefined = context.request?.signal;
  const conversationId: string = context.conversation_id ?? '';
  const store = context.store;
  const claimId = newId('clm');
  const { mode, reason: modeReason } = resolveAgentMode(env);
  const model = mode === 'deterministic' ? 'deterministic' : (env.AI_GATEWAY_MODEL?.trim() || DEFAULT_MODEL);
  const fallbackModel = env.AI_GATEWAY_FALLBACK_MODEL?.trim() || FALLBACK_MODEL;

  logger.log(`[request] cid=${conversationId || '-'} claim=${claimId} order=${hints.orderId ?? '-'} video=${hints.videoId ?? '-'} stream=${streamMode} mode=${mode} (${modeReason}) model=${model}${skipTwin ? ' twin=skipped' : ''}`);

  const claimsStore = await getClaimsStore(env);
  const policy = await getPolicy(claimsStore);
  const memories = createMemoriesClient(env);
  const toolset = createClaimsTools({
    env,
    store: claimsStore,
    memories,
    selfBaseUrl: selfBaseUrl(env, context),
    claimId,
    conversationId,
    requestStartedAt: startedAt,
    mode,
    model,
    hints,
    logger,
  });
  const { tools, state, finalizeNeedsInfo } = toolset;
  const mcpServer = createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1.0.0', tools, alwaysLoad: true });
  const allowedTools = TOOL_NAMES.map(name => `mcp__${MCP_SERVER_NAME}__${name}`);

  // Persist the customer message (frontend-generated id keeps /history aligned).
  if (store && conversationId && typeof store.appendMessage === 'function') {
    try {
      const args: Record<string, unknown> = { conversationId, role: 'user', content: message, messageId: userMsgId };
      if (userId) args.userId = userId;
      await store.appendMessage(args as any);
    } catch (e) { logger.error('[store] failed to save user message:', e); }
  }

  const persistAssistant = async (text: string) => {
    if (!(store && conversationId && text.trim() && typeof store.appendMessage === 'function')) return;
    try {
      const args: Record<string, unknown> = { conversationId, role: 'assistant', content: text, messageId: botMsgId };
      if (userId) args.userId = userId;
      await store.appendMessage(args as any);
    } catch (e) { logger.error('[store] failed to save assistant message:', e); }
  };

  if (mode === 'deterministic') {
    const events = runDeterministicClaim({ message, hints, tools, state, finalizeNeedsInfo, signal, logger });

    if (!streamMode) {
      let text = '';
      let block: DecisionBlock | null = null;
      let error: string | undefined;
      try {
        for await (const ev of events) {
          if (ev.type === 'done') { text = ev.text; block = ev.block; }
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        logger.error('[deterministic] run failed:', e);
      }
      if (!block && state.recorded) { block = state.recorded.block; text += formatDecisionBlock(block); }
      await persistAssistant(text);
      const status = error ? 'error' : signal?.aborted ? 'stopped' : 'ok';
      logger.log(`[result] claim=${claimId} display=${state.displayId} mode=deterministic status=${status} action=${block?.action ?? '-'} latency=${Date.now() - startedAt}ms`);
      return jsonResponse({
        status,
        mode,
        mode_label: state.modeLabel,
        text,
        decision: block,
        claim_id: claimId,
        display_id: state.displayId,
        claim_status: state.recorded?.claim.status ?? null,
        trace_id: state.recorded?.trace_id ?? null,
        conversation_id: conversationId,
        model,
        tool_calls: state.toolCalls.map(t => ({ name: t.name, ok: t.ok, ms: t.ended_at - t.started_at })),
        latency_ms: Date.now() - startedAt,
        error,
        stopped: !!signal?.aborted,
      }, error && !block ? 502 : 200);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: Record<string, unknown>) => controller.enqueue(encoder.encode(sseFrame(event, data)));
        let text = '';
        let stopped = false;
        send('claim', { claim_id: claimId, display_id: state.displayId, status: 'processing', mode, mode_label: state.modeLabel });
        try {
          for await (const ev of events) {
            if (signal?.aborted) { stopped = true; break; }
            switch (ev.type) {
              case 'tool_called': send('tool_called', { tool: ev.tool }); break;
              case 'text_delta': send('text_delta', { delta: ev.delta }); break;
              case 'decision': send('decision', {
                claim_id: claimId, display_id: ev.block.display_id, decision: ev.block, status: ev.status,
                mode, mode_label: state.modeLabel, trace_id: ev.trace_id ?? null, agentx_emitted: ev.agentx_emitted,
              }); break;
              case 'done': text = ev.text; break;
            }
          }
        } catch (e) {
          const err = e as Error;
          logger.error('[deterministic] stream failed:', err);
          send('error', { message: String(err?.message ?? e), name: err?.name || 'Error' });
        } finally {
          await persistAssistant(text);
          send('done', { stopped });
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  const sessionStore = typeof store?.claudeSessionStore === 'function' ? store.claudeSessionStore() : undefined;
  // Streaming (UI) turns resume the conversation's transcript; stream:false (eval) runs are always fresh.
  const binding = streamMode ? await resolveSessionBinding(store, sessionStore, conversationId, process.cwd()) : {};
  const options = buildAgentOptions({
    env, model, fallbackModel, systemPrompt: buildSystemPrompt(policy, claimId), mcpServer, allowedTools,
    sessionStore: streamMode ? sessionStore : undefined, ...binding,
  });
  const prompt = buildUserPrompt(message, claimId, hints);

  if (!streamMode) {
    const run = await runToCompletion(prompt, options, signal);
    let text = run.text;
    // Unknown order / no evidence: park the claim as needs_info (no ledger side effects) so the desk sees it.
    if (!state.recorded && state.needsInfo && !run.error) {
      const fin = await finalizeNeedsInfo();
      if (fin && !text.trim()) text = state.needsInfo.customer_message;
    }
    // The wrapper guarantees the block: synthesize it from the recorded state when the model omitted it.
    if (state.recorded && !DECISION_RE.test(text)) text += formatDecisionBlock(state.recorded.block);
    const decision = parseDecisionBlock(text) ?? state.recorded?.block ?? null;
    await persistAssistant(text);
    // The CLI reports auth/config failures as a "successful" one-line reply; surface them as errors.
    const authFailure = !decision && /not logged in|please run \/login|invalid api key|authentication_failed|api key/i.test(text);
    if (authFailure && !run.error) run.error = `model_auth: ${text.slice(0, 200)}`;
    const status = run.error ? 'error' : run.stopped ? 'stopped' : 'ok';
    logger.log(`[result] claim=${claimId} display=${state.displayId} mode=llm status=${status} action=${decision?.action ?? '-'} turns=${run.numTurns ?? '-'} latency=${Date.now() - startedAt}ms`);
    return jsonResponse({
      status,
      mode,
      mode_label: state.modeLabel,
      text,
      decision,
      claim_id: claimId,
      display_id: state.displayId,
      claim_status: state.recorded?.claim.status ?? null,
      trace_id: state.recorded?.trace_id ?? null,
      conversation_id: conversationId,
      session_id: run.sessionId,
      model,
      tool_calls: state.toolCalls.map(t => ({ name: t.name, ok: t.ok, ms: t.ended_at - t.started_at })),
      latency_ms: Date.now() - startedAt,
      error: run.error,
      stopped: run.stopped,
    }, run.error && !decision ? 502 : 200);
  }

  const stream = createChatStream({
    message: prompt,
    options,
    signal,
    logger,
    conversationId,
    store,
    botMsgId,
    userId,
  });

  return new Response(wrapDecisionStream(stream, toolset, claimId, mode), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
