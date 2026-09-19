/**
 * Clear-history handler — EdgeOne Makers Node Function
 * ===================================================
 *
 * File path cloud-functions/clear-history/index.ts maps to **POST /clear-history**.
 *
 * Clears all backend messages for the current conversation via
 * `context.agent!.store.clearMessages({ conversationId })`.
 *
 * Following the official EdgeOne Makers Node Functions docs:
 *   - export `onRequestPost` for POST handlers
 *   - read JSON body via `await context.request!.json()`
 *   - return a `Response` object
 *   https://pages.edgeone.ai/document/node-functions
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import { redactBase64Deep } from '../_redact';

const logger = createLogger('clear-history');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

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

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[clear-history] start: ${new Date(startTime).toISOString()}`);

  const body = await readJsonBody(context);
  const conversationId = getConversationId(body);
  const userId = getUserId(body);
  const { store } = context.agent!;

  logger.log('conversationId:', conversationId, 'userId:', userId || '-');

  if (!conversationId) {
    logger.error('Missing conversationId');
    logger.log(`[clear-history] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'error', message: 'conversation_id is required' }, 400);
  }

  try {
    const clearArgs: Record<string, unknown> = { conversationId };
    if (userId) clearArgs.userId = userId;
    await store.clearMessages(clearArgs as any);

    const getArgs: Record<string, unknown> = {
      conversationId,
      limit: 100,
      order: 'asc',
    };
    if (userId) getArgs.userId = userId;
    const historyAfterClear = await store.getMessages(getArgs as any);
    logger.log('[clear-history] history after clear:', {
      conversationId,
      count: Array.isArray(historyAfterClear) ? historyAfterClear.length : 0,
      messages: redactBase64Deep(historyAfterClear),
    });

    logger.log(`[clear-history] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'ok', conversation_id: conversationId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('failed to clear messages:', e);
    logger.log(`[clear-history] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'error', conversation_id: conversationId, message }, 500);
  }
}
