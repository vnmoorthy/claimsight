/**
 * History handler — EdgeOne Makers Node Function
 * ==============================================
 *
 * File path cloud-functions/history/index.ts maps to **POST /history**.
 *
 * Reads conversation history from `context.agent!.store.getMessages()` and
 * returns it to the frontend for restoring the chat window after a page
 * refresh.
 *
 * Note: base64 image content is redacted from history responses to avoid
 * sending large payloads to the frontend. Images are restored from
 * client-side IndexedDB instead.
 *
 * Following the official EdgeOne Makers Node Functions docs:
 *   - export `onRequestPost` for POST handlers
 *   - read JSON body via `await context.request!.json()`
 *   - return a `Response` object
 *   https://pages.edgeone.ai/document/node-functions
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import { redactBase64InText } from '../_redact';

const logger = createLogger('history');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

type FrontendMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readJsonBody(context: CloudFunctionContext): Promise<Record<string, unknown>> {
  try {
    const data = await context.request!.json();
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getConversationId(body: Record<string, unknown>): string {
  const value = body.conversation_id ?? body.conversationId;
  return typeof value === 'string' ? value : '';
}

function getUserId(body: Record<string, unknown>): string {
  const value = body.user_id ?? body.userId;
  return typeof value === 'string' ? value.trim() : '';
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return redactBase64InText(content);

  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    if ('content' in obj) return contentToText(obj.content);
    if ('output' in obj) return contentToText(obj.output);
    if ('text' in obj) return redactBase64InText(String(obj.text ?? ''));
    return '';
  }

  if (Array.isArray(content)) {
    return content
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object',
      )
      .map(item => {
        const text = String(item.text ?? item.output_text ?? '');
        return redactBase64InText(text);
      })
      .filter(Boolean)
      .join('\n');
  }

  return String(content);
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[history] start: ${new Date(startTime).toISOString()}`);

  const body = await readJsonBody(context);
  const conversationId = getConversationId(body);
  const userId = getUserId(body);
  const { store } = context.agent!;

  logger.log('conversationId:', conversationId, 'userId:', userId || '-');

  if (!conversationId) {
    logger.log(`[history] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ conversation_id: conversationId, messages: [] });
  }

  try {
    const getArgs: Record<string, unknown> = {
      conversationId,
      limit: 100,
      order: 'asc',
    };
    if (userId) getArgs.userId = userId;
    const history = await store.getMessages(getArgs as any);

    const messages: FrontendMessage[] = [];
    for (const item of history) {
      const role = item.role;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = contentToText(item.content);
      if (!content) continue;

      messages.push({
        id: item.messageId ?? `${role}-${item.createdAt ?? 0}`,
        role,
        content,
        timestamp: item.createdAt ?? 0,
      });
    }

    logger.log(`[history] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ conversation_id: conversationId, messages });
  } catch (e) {
    logger.error('failed to get messages:', e);
    logger.log(`[history] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ conversation_id: conversationId, messages: [] });
  }
}
