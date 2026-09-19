/**
 * Seed handler — EdgeOne Makers Node Function
 * ===========================================
 *
 * File path cloud-functions/seed/index.ts maps to **POST /seed**.
 *
 * Loads data/orders.json + data/policy.json into the claims store and resets counters.
 * Idempotent. Protected by header `x-admin-token: $ADMIN_TOKEN` (check skipped when the env
 * var is unset). Also wipes claims / ledger / video_index so a demo starts from a clean desk;
 * pass body `{ "keep_claims": true }` to re-seed orders and policy without touching them.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  getClaimsStore, resolveEnv, seedStore, readJsonBody, jsonResponse, errorResponse,
  isAdminAuthorized, isMemoriesStubbed,
} from '../_kv';

const logger = createLogger('seed');

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  if (!isAdminAuthorized(context, env)) {
    return errorResponse(401, 'unauthorized', 'x-admin-token header does not match ADMIN_TOKEN');
  }

  const body = await readJsonBody(context);
  // Seeding means "reset the demo": claims, ledger and video index are wiped unless keep_claims is set.
  const keepClaims = body.keep_claims === true || body.keep_claims === 'true';
  const clearClaims = !keepClaims;

  try {
    const store = await getClaimsStore(env);
    let cleared = 0;
    if (clearClaims) {
      for (const prefix of ['claims:', 'ledger:', 'video_index:']) {
        for (const key of await store.list(prefix)) {
          await store.delete(key);
          cleared++;
        }
      }
    }
    const result = await seedStore(store, env, { reset: true });
    logger.log(`[seed] backend=${store.backend} orders=${result.orders} cleared=${cleared}`);
    return jsonResponse({
      ok: true,
      backend: store.backend,
      memories_stubbed: isMemoriesStubbed(env),
      cleared_records: cleared,
      ...result,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('[seed] failed:', e);
    return errorResponse(500, 'seed_failed', message);
  }
}
