/**
 * Stop handler — EdgeOne Makers
 * ========================================
 *
 * File path agents/stop/index.ts maps to **POST /stop**
 *
 * Aborts the active agent run for the given conversationId.
 * The runtime sets the AbortSignal on the target conversation,
 * which breaks the for-await loop in chat/index.ts and releases
 * the upstream LLM connection.
 *
 * IMPORTANT: The stop request must NOT carry the same
 * `makers-conversation-id` header as the chat request,
 * otherwise the runtime overwrites the chat's signal.
 * The target conversation_id is passed only via request body.
 */

import type { AgentContext } from '@edgeone/types';
import { createLogger } from '../_logger';

const logger = createLogger('stop');

export async function onRequest(context: AgentContext) {
  const { request } = context;
  const conversationId = ((request?.body ?? {}) as Record<string, any>)?.conversation_id as string | undefined;

  logger.log('conversationId:', conversationId);

  if (!conversationId) {
    logger.error('Missing conversation_id');
    return new Response(
      JSON.stringify({ status: 'error', message: 'conversation_id is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=UTF-8' } },
    );
  }

  const ret = context.utils.abortActiveRun(conversationId);

  logger.log('abortActiveRun result:', ret);

  const data = {
    status: ret?.aborted ? 'aborting' : 'idle',
    conversationId,
    ...ret,
  };

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
}
