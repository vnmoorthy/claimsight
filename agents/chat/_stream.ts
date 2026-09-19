import { query } from '@anthropic-ai/claude-agent-sdk';
import { redactBase64Deep } from '../_redact';

interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface CreateChatStreamOptions {
  message: string;
  options: Record<string, any>;
  signal?: AbortSignal;
  logger: Logger;
  conversationId: string;
  store: any;
  botMsgId?: string;
  userId?: string;
}

/** Skill catalog — describes skills available in this project. */
const PROJECT_SKILLS = [
  {
    name: 'sandbox-algorithms',
    label: 'Sandbox algorithm execution',
    description: 'Run deterministic algorithm scripts through the EdgeOne sandbox code_interpreter and return verified execution results.',
  },
];

function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Extract short name from MCP tool full name (e.g. mcp__edgeone__commands → commands) */
function extractToolName(rawName: string): string {
  if (rawName.includes('__')) {
    return rawName.split('__').pop() || rawName;
  }
  return rawName;
}

/**
 * Redact base64Image from a value for safe logging/debug display.
 * Uses a cheap string check to skip expensive recursion on the hot path.
 */
function redactForPreview(value: unknown): unknown {
  // Fast path: skip recursion if raw JSON clearly has no base64Image
  const quick = typeof value === 'string' ? value : JSON.stringify(value);
  if (!quick?.includes('base64Image')) return value;
  return redactBase64Deep(value, '[REDACTED image data]');
}

function safeJsonPreview(value: unknown, maxLength = 800): string {
  try {
    const redacted = redactForPreview(value);
    const text = JSON.stringify(redacted);
    if (!text) return String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text;
  } catch {
    return String(value);
  }
}

/**
 * Remove image data URIs from assistant prose before streaming or storing it.
 *
 * Tool images are delivered through dedicated `image` SSE events and rendered
 * as attachments. If the model also writes a Markdown data URI, the frontend
 * receives a huge base64 blob as normal text. Keep this sanitizer on the
 * streaming path because history redaction only runs after a page refresh.
 */
function sanitizeAssistantText(text: string): string {
  return text
    .replace(/!\[[^\]]*]\(\s*data:image\/[^;)\s]+;base64,[A-Za-z0-9+/=]+\s*\)/gi, '')
    .replace(/!\[[^\]]*]\(\s*data:image\/[^;)\s]+;base64,[\s\S]*$/gi, '')
    .replace(/data:image\/[^;)\s]+;base64,[A-Za-z0-9+/=]+/gi, '')
    .replace(/data:image\/[^;)\s]+;base64,[A-Za-z0-9+/=]*$/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();
}

function enqueueSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: string,
  data: Record<string, unknown>,
): void {
  controller.enqueue(encoder.encode(sseFrame(event, data)));
}

function emitToolResultImages(
  msg: any,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  logger: Logger,
): void {
  try {
    const toolResults = msg.tool_use_result ?? msg.message?.content ?? [];
    const resultArr = Array.isArray(toolResults) ? toolResults : [toolResults];
    for (const item of resultArr) {
      // Shape 1 — Anthropic standard image content block:
      //   { type: "image", source: { type: "base64", media_type: "image/png", data: "<b64>" } }
      // EdgeOne's browser screenshot tool, code_interpreter renders, and any
      // other tool that returns images via the SDK arrive in this shape.
      // Catching this is what stops the model from inlining a giant
      // ![](data:image/png;base64,...) blob into the chat text.
      if (item?.type === 'image' && item?.source?.type === 'base64' && item.source.data) {
        const base64 = item.source.data as string;
        const imageId = crypto.randomUUID();
        const mimeType = (item.source.media_type as string) || 'image/png';
        const size = base64.length;
        logger.log('[image] extracted standard image content block, imageId:', imageId, 'size:', size);
        enqueueSse(controller, encoder, 'image', { imageId, base64, mimeType, size });
        continue;
      }

      // Shape 2 — legacy/wrapped JSON inside a text block:
      //   [{ type: "text", text: '{"base64Image":"<b64>"}' }]
      // Used by some EdgeOne first-party image tools that return JSON
      // payloads instead of native image blocks.
      const text = typeof item === 'string' ? item : (item?.text ?? item?.content ?? '');
      if (typeof text === 'string' && text.includes('base64Image')) {
        try {
          const parsed = JSON.parse(text);
          if (parsed?.base64Image) {
            const base64 = parsed.base64Image;
            const imageId = crypto.randomUUID();
            const mimeType = 'image/png';
            const size = base64.length;

            logger.log('[image] extracted base64Image from tool_result, imageId:', imageId, 'size:', size);

            // Emit enriched image event with metadata
            enqueueSse(controller, encoder, 'image', {
              imageId,
              base64,
              mimeType,
              size,
            });
          }
        } catch {
          // Not valid JSON, skip.
        }
      }
    }
  } catch (e) {
    logger.error('[image] failed to extract base64Image:', e);
  }
}

function emitDebugMessage(
  msg: any,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): void {
  if (msg.type === 'system' && msg.subtype === 'thinking_tokens') {
    return;
  }

  if (msg.type !== 'assistant' && msg.type !== 'result') {
    // Use redacted preview for debug messages to avoid base64 pollution
    enqueueSse(controller, encoder, 'debug_msg', {
      msgType: msg.type,
      preview: safeJsonPreview(msg, 4000),
    });
  }
}

function emitAssistantBlocks(
  msg: any,
  state: { sentTextLenByBlock: Map<number, number>; fullAssistantText: string },
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  logger: Logger,
  conversationId: string,
): void {
  const blocks = msg.message?.content ?? [];
  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];

    if (block.type === 'text') {
      const fullText = sanitizeAssistantText(block.text || '');
      const alreadySent = state.sentTextLenByBlock.get(idx) ?? 0;
      if (fullText.length > alreadySent) {
        const delta = fullText.slice(alreadySent);
        state.sentTextLenByBlock.set(idx, fullText.length);
        state.fullAssistantText = fullText;
        enqueueSse(controller, encoder, 'text_delta', { delta });
      }
    } else if (block.type === 'tool_use') {
      const rawToolName = block.name || '';
      const toolName = extractToolName(rawToolName);
      const toolId = 'id' in block ? block.id : undefined;
      const toolInput = 'input' in block ? block.input : undefined;

      logger.log(
        '[tools] call requested',
        {
          cid: conversationId,
          blockIndex: idx,
          tool: toolName,
          rawTool: rawToolName,
          toolId,
          inputKeys: toolInput && typeof toolInput === 'object' ? Object.keys(toolInput) : [],
          inputPreview: safeJsonPreview(toolInput),
        },
      );

      enqueueSse(controller, encoder, 'tool_called', { tool: toolName });

      // Detect skill loading. The Claude Agent SDK's built-in tool is named
      // `Skill` (capital S, current SDK) but `load_skill` exists as a legacy
      // alias / short name in some runtime versions. Match both, case-
      // insensitive on the suffix, so an SDK upgrade or rename doesn't
      // silently disable the skill UI.
      const isSkillTool =
        toolName === 'Skill' ||
        toolName === 'load_skill' ||
        rawToolName.includes('load_skill') ||
        rawToolName.endsWith('Skill');
      if (isSkillTool) {
        const skillName = toolInput && typeof toolInput === 'object'
          ? (toolInput as Record<string, unknown>).skill ?? (toolInput as Record<string, unknown>).name ?? (toolInput as Record<string, unknown>).skillName
          : undefined;
        if (typeof skillName === 'string') {
          enqueueSse(controller, encoder, 'skill_loaded', { name: skillName, status: 'loaded' });
        }
      }
    } else {
      // Other block types (e.g. image): push as debug_block event with redacted content.
      enqueueSse(controller, encoder, 'debug_block', {
        blockIndex: idx,
        blockType: block.type,
        block: safeJsonPreview(block, 4000),
      });
    }
  }
}

export function createChatStream({
  message,
  options,
  signal,
  logger,
  conversationId,
  store,
  botMsgId,
  userId,
}: CreateChatStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let stopped = false;
  const state = {
    fullAssistantText: '',
    sentTextLenByBlock: new Map<number, number>(),
  };

  return new ReadableStream({
    async start(controller) {
      try {
        // Emit skills config event before query starts.
        enqueueSse(controller, encoder, 'skills_loaded', {
          skills: options.skills,
          settingSources: options.settingSources,
        });

        // Emit available skills catalog for frontend UI.
        enqueueSse(controller, encoder, 'skills_available', {
          skills: PROJECT_SKILLS,
        });

        const abortController = new AbortController();
        if (signal?.aborted) {
          abortController.abort();
        } else {
          signal?.addEventListener('abort', () => abortController.abort(), { once: true });
        }

        const q = query({
          prompt: message,
          options: { ...options, abortController },
        });
        let lastMsgType = '';

        for await (const msg of q) {
          if (signal?.aborted) { stopped = true; break; }

          // New assistant message round detected: if previous was user (tool_result), reset counters.
          if (msg.type === 'assistant' && lastMsgType === 'user') {
            state.sentTextLenByBlock.clear();
          }
          lastMsgType = msg.type;

          // Intercept base64Image from tool_result and push as image event to frontend.
          if (msg.type === 'user') {
            emitToolResultImages(msg, controller, encoder, logger);
          }

          // Debug: push all message types for frontend observability (base64 redacted).
          emitDebugMessage(msg, controller, encoder);

          if (msg.type === 'assistant') {
            emitAssistantBlocks(msg, state, controller, encoder, logger, conversationId);
          } else if (msg.type === 'result') {
            const sessionId = msg.session_id;
            if (typeof sessionId === 'string') {
              logger.log('[session] Claude SDK result session_id:', sessionId);
            }
            break;
          }
        }
      } catch (e: unknown) {
        const error = e as Error;
        if (error.name === 'AbortError' || signal?.aborted) {
          stopped = true;
          logger.log('[stream] aborted by user');
        } else {
          // DEBUG: dump the entire error so the dev-server console shows the
          // SDK's underlying cause (CLI exit code, gateway 4xx body, etc.) —
          // not just the surface "process exited with code 1" message.
          logger.error('[stream] error.name:', error.name);
          logger.error('[stream] error.message:', error.message);
          logger.error('[stream] error.stack:', error.stack);
          const cause = (error as { cause?: unknown }).cause;
          if (cause !== undefined) {
            logger.error('[stream] error.cause:', cause);
            try {
              logger.error('[stream] error.cause (JSON):', JSON.stringify(cause, null, 2));
            } catch {
              // cause not serializable — already dumped raw above.
            }
          }
          enqueueSse(controller, encoder, 'error', {
            message: String(error.message ?? e),
            name: error.name || 'Error',
            stack: error.stack,
            cause,
          });
        }
      } finally {
        // Save assistant response to store (with frontend-generated ID for history alignment).
        // Always save when botMsgId is provided, even if text is empty (image-only turns),
        // so that /history returns this message and frontend can merge images back by ID.
        if (store && conversationId && botMsgId) {
          const content = sanitizeAssistantText(state.fullAssistantText).trim() || '[image]';
          try {
            const args: Record<string, unknown> = {
              conversationId, role: 'assistant', content, messageId: botMsgId,
            };
            if (userId) args.userId = userId;
            await store.appendMessage(args);
          }
          catch (e) { logger.error('[store] failed to save assistant response:', e); }
        } else if (store && conversationId && sanitizeAssistantText(state.fullAssistantText).trim()) {
          // Legacy fallback: no botMsgId but has text content
          try {
            const content = sanitizeAssistantText(state.fullAssistantText).trim();
            const args: Record<string, unknown> = {
              conversationId, role: 'assistant', content,
            };
            if (userId) args.userId = userId;
            await store.appendMessage(args);
          }
          catch (e) { logger.error('[store] failed to save assistant response:', e); }
        }

        enqueueSse(controller, encoder, 'done', { stopped });
        controller.close();
      }
    },
    cancel() {
      logger.log('[stream] client disconnected');
    },
  });
}
