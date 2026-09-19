/**
 * LLM runner for the claims agent — private module (agents/claims/_llm.ts, not routed).
 *
 * Drives ONE Claude Agent SDK `query()` and yields the events the UI already understands
 * (tool_called / text_delta / debug_msg), then exactly one `result` event that says whether the
 * model finished, was stopped by the customer (/stop), or FAILED — with a classified reason so the
 * caller (agents/claims/index.ts) can let the policy engine take over on the same stream.
 *
 * Resilience rules:
 *   - Watchdog: when the SDK yields no message for LLM_TIMEOUT_MS the run is aborted and reported
 *     as a `timeout` failure (the customer never waits on a hung gateway).
 *   - Failures are classified from the SDK's own signals (assistant `error`, result subtype,
 *     thrown errors + the CLI's stderr tail) into auth / network / gateway / timeout / sdk / max_turns.
 *   - Text is HELD until the run settles. Narration that precedes a tool call is released at that
 *     tool call (it is safe and keeps the stream lively); the final reply is released only when the
 *     run succeeded, so "API Error: 401 …" or a half-written answer never reaches the customer.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { redactBase64Deep } from '../_redact';
import type { Logger } from './_tools';

export type LlmFailureKind = 'auth' | 'network' | 'gateway' | 'timeout' | 'sdk' | 'max_turns';

export interface LlmFailure {
  kind: LlmFailureKind;
  /** Technical, bounded (≤ 400 chars); goes to logs, `fallback.reason` and the notice event. */
  reason: string;
}

export interface LlmResult {
  type: 'result';
  /** Final assistant text (the model's last message, or what it managed to say before failing). */
  text: string;
  /** Text deltas that were never released to the stream (empty after a healthy run). */
  heldText: string;
  stopped: boolean;
  failure?: LlmFailure;
  sessionId?: string;
  numTurns?: number;
  toolCallsSeen: number;
}

export type LlmEvent =
  | { type: 'tool_called'; tool: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'debug_msg'; msgType: string; preview: string }
  | LlmResult;

export interface LlmRunInput {
  prompt: string;
  options: Record<string, any>;
  signal?: AbortSignal;
  /** Idle watchdog in ms: abort when the SDK yields nothing for this long. */
  timeoutMs: number;
  logger: Logger;
}

/** The CLI reports auth/config problems as a "successful" one-line reply; recognise them. */
export const AUTH_TEXT_RE = /not logged in|please run \/login|invalid api key|invalid x-api-key|authentication[_ ]?(failed|error)|unauthori[sz]ed|\bapi key\b/i;
const NETWORK_RE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|fetch failed|network error|socket hang up|getaddrinfo|certificate|connection (refused|reset|closed)/i;
const GATEWAY_RE = /\b(5\d\d|429|4\d\d)\b|gateway|overloaded|rate.?limit|model.?not.?found|billing|invalid_request/i;

export function classifyFailureText(text: string): LlmFailureKind {
  if (AUTH_TEXT_RE.test(text)) return 'auth';
  if (NETWORK_RE.test(text)) return 'network';
  if (GATEWAY_RE.test(text)) return 'gateway';
  return 'sdk';
}

function classifyAssistantError(code: string, text: string): LlmFailure {
  const kind: LlmFailureKind =
    code === 'authentication_failed' || code === 'oauth_org_not_allowed' ? 'auth'
      : code === 'server_error' || code === 'rate_limit' || code === 'billing_error' || code === 'model_not_found' || code === 'invalid_request' ? 'gateway'
        : classifyFailureText(text);
  return { kind, reason: `${code}: ${firstLine(text) || 'the model request failed'}` };
}

export function firstLine(text: string, max = 300): string {
  const line = (text ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function safeJsonPreview(value: unknown, maxLength = 4000): string {
  try {
    const text = JSON.stringify(redactBase64Deep(value, '[REDACTED image data]'));
    if (!text) return String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text;
  } catch {
    return String(value);
  }
}

/** mcp__claimsight__lookup_order → lookup_order */
function extractToolName(raw: string): string {
  return raw.includes('__') ? raw.split('__').pop() || raw : raw;
}

type Step<T> = { timedOut: true } | { timedOut: false; done: boolean; value?: T };

/** `it.next()` raced against the idle watchdog. A late rejection after the timeout is harmless (already settled). */
function nextWithin<T>(it: AsyncIterator<T>, ms: number): Promise<Step<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    it.next().then(
      r => { clearTimeout(timer); resolve({ timedOut: false, done: !!r.done, value: r.value }); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

function withDeadline<T>(p: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!p) return Promise.resolve(undefined);
  return Promise.race([p.catch(() => undefined), new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);
}

export async function* runLlmClaim(input: LlmRunInput): AsyncGenerator<LlmEvent, void, unknown> {
  const { signal, logger, timeoutMs } = input;
  const abortController = new AbortController();
  if (signal?.aborted) abortController.abort();
  else signal?.addEventListener('abort', () => abortController.abort(), { once: true });

  // Keep the CLI's last stderr lines: when the SDK throws "process exited with code 1" the real cause lives here.
  const stderrTail: string[] = [];
  const userStderr = input.options.stderr as ((line: string) => void) | undefined;
  const options: Record<string, any> = {
    ...input.options,
    abortController,
    stderr: (line: string) => {
      if (line && line.trim()) {
        stderrTail.push(line.trim());
        if (stderrTail.length > 20) stderrTail.shift();
      }
      userStderr?.(line);
    },
  };

  let fullAssistantText = '';
  const sentTextLenByBlock = new Map<number, number>();
  let lastMsgType = '';
  let held: string[] = [];
  let toolCallsSeen = 0;
  let stopped = false;
  let failure: LlmFailure | undefined;
  let apiError: LlmFailure | undefined;
  let sessionId: string | undefined;
  let numTurns: number | undefined;
  let finalText = '';
  let watchdogFired = false;

  const flush = function* (): Generator<LlmEvent> {
    for (const delta of held) yield { type: 'text_delta', delta };
    held = [];
  };

  let it: AsyncIterator<unknown> | undefined;
  let finished = false;
  try {
    const q = query({ prompt: input.prompt, options });
    it = q[Symbol.asyncIterator]();
    for (;;) {
      const step = await nextWithin(it, timeoutMs);
      if (step.timedOut) {
        watchdogFired = true;
        failure = { kind: 'timeout', reason: `No response from the AI model for ${Math.round(timeoutMs / 1000)} s (LLM_TIMEOUT_MS watchdog)` };
        logger.error(`[llm] watchdog fired after ${timeoutMs} ms of silence — aborting the model run`);
        abortController.abort();
        await withDeadline(q.interrupt(), 2000);
        break;
      }
      if (step.done) { finished = true; break; }
      const msg = step.value as any;
      if (signal?.aborted) { stopped = true; break; }

      // New assistant round after a tool result: text block indexes start over.
      if (msg.type === 'assistant' && lastMsgType === 'user') sentTextLenByBlock.clear();
      lastMsgType = msg.type;

      if (msg.type !== 'assistant' && msg.type !== 'result' && !(msg.type === 'system' && msg.subtype === 'thinking_tokens')) {
        yield { type: 'debug_msg', msgType: String(msg.type), preview: safeJsonPreview(msg) };
      }

      if (msg.type === 'assistant') {
        const blocks = (msg.message?.content ?? []) as Array<{ type: string; text?: string; name?: string }>;
        const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
        if (msg.error) {
          // e.g. authentication_failed / server_error: the text is "API Error: 401 …" — never show it to the customer.
          apiError = classifyAssistantError(String(msg.error), text);
          logger.error(`[llm] assistant error ${msg.error}: ${firstLine(text)}`);
          continue;
        }
        for (let idx = 0; idx < blocks.length; idx++) {
          const block = blocks[idx];
          if (block.type === 'text') {
            const full = String(block.text ?? '');
            const already = sentTextLenByBlock.get(idx) ?? 0;
            if (full.length > already) {
              held.push(full.slice(already));
              sentTextLenByBlock.set(idx, full.length);
              fullAssistantText = full;
            }
          } else if (block.type === 'tool_use') {
            toolCallsSeen++;
            yield* flush(); // narration before a tool call is safe to show
            yield { type: 'tool_called', tool: extractToolName(block.name || '') };
          }
        }
      } else if (msg.type === 'result') {
        finished = true;
        sessionId = msg.session_id;
        numTurns = msg.num_turns;
        if (msg.subtype === 'success') {
          finalText = String(msg.result || fullAssistantText || '');
          if (apiError) failure = apiError;
          else if (msg.is_error) failure = { kind: classifyFailureText(finalText), reason: `model_error: ${firstLine(finalText) || 'the model reported an error'}` };
        } else {
          const errs = Array.isArray(msg.errors) ? msg.errors.map((x: unknown) => String(x)) : [];
          const detail = (errs.length ? errs.join('; ') : firstLine(fullAssistantText)).slice(0, 300);
          failure = apiError ?? {
            kind: msg.subtype === 'error_max_turns' ? 'max_turns' : classifyFailureText(detail),
            reason: `${msg.subtype}${detail ? `: ${detail}` : ''}`,
          };
          finalText = fullAssistantText;
        }
        break;
      }
    }
  } catch (e) {
    const err = e as Error & { cause?: unknown };
    if (err?.name === 'AbortError' || signal?.aborted) {
      stopped = true;
    } else if (!watchdogFired) {
      const tail = stderrTail.slice(-3).join(' | ');
      let causeText = '';
      if (err?.cause !== undefined) {
        try { causeText = typeof err.cause === 'string' ? err.cause : JSON.stringify(err.cause).slice(0, 200); } catch { causeText = String(err.cause); }
      }
      const detail = [err?.message ?? String(e), tail, causeText].filter(Boolean).join(' — ');
      failure = apiError ?? { kind: classifyFailureText(detail), reason: detail.slice(0, 400) };
      logger.error('[llm] run failed:', err?.message, tail ? `stderr: ${tail}` : '');
    }
    finalText = fullAssistantText;
  } finally {
    if (it && !finished) await withDeadline(it.return?.(), 2000);
  }

  // Healthy run: release the final reply. Failed or stopped: keep it held — the caller decides.
  if (!failure && !stopped) yield* flush();
  yield { type: 'result', text: finalText, heldText: held.join(''), stopped, failure, sessionId, numTurns, toolCallsSeen };
}
