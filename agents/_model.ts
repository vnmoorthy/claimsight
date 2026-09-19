/**
 * AI Gateway debug configuration.
 *
 * Claude Agent SDK subprocess still reads Anthropic protocol env vars,
 * so we map AI_GATEWAY_* to ANTHROPIC_* for the SDK.
 *
 * All functions accept context.env as parameter instead of reading process.env directly.
 */

const DEFAULT_MODEL = process.env.AI_GATEWAY_MODEL || '@makers/deepseek-v4-flash';

export function resolveModelName(env: Record<string, string | undefined>): string {
  return env.AI_GATEWAY_MODEL || DEFAULT_MODEL;
}

export function collectGatewayEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  const model = env.AI_GATEWAY_MODEL || DEFAULT_MODEL;
  const baseUrl = env.AI_GATEWAY_BASE_URL;
  const apiKey = env.AI_GATEWAY_API_KEY;
  const smallModel = env.AI_GATEWAY_SMALL_MODEL || model;

  if (baseUrl) result.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKey) result.ANTHROPIC_API_KEY = apiKey;
  if (smallModel) result.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
  if (env.ANTHROPIC_CUSTOM_HEADERS) {
    result.ANTHROPIC_CUSTOM_HEADERS = env.ANTHROPIC_CUSTOM_HEADERS;
  }

  return result;
}
