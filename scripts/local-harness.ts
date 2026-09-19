/**
 * Local runtime harness: emulates the EdgeOne Makers routing so the ClaimSight cloud functions
 * and the claims agent run over HTTP without `edgeone makers dev` (no Makers login needed).
 * Use it for local development, CI, and as the on-stage fallback runtime.
 *
 *   cloud-functions/<name>/index.ts  → /<name>   (onRequest<Method> | onRequest)
 *   agents/claims/index.ts           → POST /claims
 *
 * Run: npm run dev:local   (= STORAGE=memory MEMORIES_STUB=1 npx tsx scripts/local-harness.ts)
 */
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = process.env.CLAIMSIGHT_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8088);
const CLOUD_FUNCTIONS = [
  'seed', 'orders-lookup', 'upload-evidence', 'evidence-status', 'refund', 'replacement', 'claims',
  'claims-record', 'claims-decision', 'stats', 'agentx-emit', 'demo-evidence', 'claims-list',
  'history', 'conversations', 'clear-history', 'delete-conversation',
];

const modules = new Map<string, Promise<Record<string, unknown>>>();
function load(rel: string): Promise<Record<string, unknown>> {
  if (!modules.has(rel)) modules.set(rel, import(pathToFileURL(path.join(ROOT, rel)).href));
  return modules.get(rel)!;
}

async function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function toHeaders(req: http.IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') h.set(k, v);
    else if (Array.isArray(v)) h.set(k, v.join(', '));
  }
  return h;
}

async function writeResponse(res: http.ServerResponse, out: unknown): Promise<void> {
  if (out instanceof Response) {
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    if (out.body) {
      const reader = out.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } else if (out && typeof out === 'object') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  } else {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }
}

// In-memory conversation store shared by the claims agent (context.store) and the template's
// history / conversations / clear-history / delete-conversation functions (context.agent.store).
type StoredMessage = { messageId: string; role: string; content: unknown; createdAt: number; userId?: string };
const conversations = new Map<string, { userId?: string; createdAt: number; updatedAt: number; messages: StoredMessage[] }>();
const fakeStore = {
  async appendMessage(input: { role: string; content: unknown; conversationId: string; messageId?: string; userId?: string }) {
    const id = input.messageId ?? randomUUID();
    const now = Date.now();
    const conv = conversations.get(input.conversationId) ?? { userId: input.userId, createdAt: now, updatedAt: now, messages: [] };
    conv.messages.push({ messageId: id, role: input.role, content: input.content, createdAt: now, userId: input.userId });
    conv.updatedAt = now;
    if (input.userId) conv.userId = input.userId;
    conversations.set(input.conversationId, conv);
    console.log(`[harness][store] appendMessage cid=${input.conversationId} role=${input.role} content=${String(input.content).slice(0, 80).replace(/\n/g, ' ')}`);
    return id;
  },
  async getMessages(input: { conversationId: string; limit?: number; order?: 'asc' | 'desc' }) {
    const conv = conversations.get(input.conversationId);
    if (!conv) return [];
    const msgs = input.order === 'desc' ? [...conv.messages].reverse() : [...conv.messages];
    return msgs.slice(0, input.limit ?? 100);
  },
  async listConversations(input: { userId?: string; limit?: number; order?: 'asc' | 'desc' } = {}) {
    let rows = [...conversations.entries()].filter(([, c]) => !input.userId || !c.userId || c.userId === input.userId);
    rows.sort((a, b) => (input.order === 'asc' ? a[1].updatedAt - b[1].updatedAt : b[1].updatedAt - a[1].updatedAt));
    rows = rows.slice(0, input.limit ?? 50);
    const items = rows.map(([id, c]) => {
      const first = c.messages.find(m => m.role === 'user');
      const title = first ? String(typeof first.content === 'string' ? first.content : JSON.stringify(first.content)).slice(0, 60) : undefined;
      return { conversationId: id, conversation_id: id, id, title, createdAt: c.createdAt, updatedAt: c.updatedAt, lastMessageAt: c.updatedAt, messageCount: c.messages.length, userId: c.userId };
    });
    return { conversations: items, items, hasMore: false };
  },
  async clearMessages(input: { conversationId: string }) {
    const conv = conversations.get(input.conversationId);
    if (conv) { conv.messages = []; conv.updatedAt = Date.now(); }
  },
  async deleteConversation(input: { conversationId: string }) {
    conversations.delete(input.conversationId);
  },
  state: { async get() { return null; }, async set() {}, async delete() {} },
};

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const name = url.pathname.replace(/^\/+|\/+$/g, '');
  const method = (req.method ?? 'GET').toUpperCase();
  try {
    const raw = await readRaw(req);
    const headers = toHeaders(req);
    const ct = headers.get('content-type') ?? '';
    const webReq = new Request(url.toString(), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : raw,
      // @ts-expect-error duplex is required by undici for streaming bodies
      duplex: 'half',
    });
    let parsedBody: unknown;
    if (raw.length) {
      if (ct.includes('application/json')) {
        try { parsedBody = JSON.parse(raw.toString('utf8')); } catch { parsedBody = raw.toString('utf8'); }
      } else if (ct.includes('multipart/form-data')) {
        parsedBody = await webReq.clone().formData();
      } else {
        parsedBody = raw.toString('utf8');
      }
    }
    const query = Object.fromEntries(url.searchParams.entries());

    let out: unknown;
    if (name === 'claims' && method === 'POST') {
      const mod = await load('agents/claims/index.ts');
      const ac = new AbortController();
      req.on('close', () => { if (!res.writableEnded) ac.abort(); });
      const ctx = {
        conversation_id: headers.get('makers-conversation-id') ?? randomUUID(),
        run_id: randomUUID(),
        eo: { geo: {}, clientIp: '127.0.0.1' },
        request: {
          method, path: url.pathname, url: url.toString(), search: url.search, query,
          headers: Object.fromEntries(headers.entries()), eo: { geo: {}, clientIp: '127.0.0.1' },
          body: parsedBody, signal: ac.signal,
        },
        env: process.env,
        store: fakeStore,
        tracer: { startSpan: () => ({ end() {} }), span: async (_n: string, fn: (s: unknown) => unknown) => fn({}), event() {}, setAttributes() {}, recordException() {} },
        agents: { invoke: async () => { throw new Error('not supported in harness'); } },
        utils: { abortActiveRun: () => ({ aborted: false }) },
        abortActiveRun: () => ({ aborted: false }),
      };
      out = await (mod.onRequest as (c: unknown) => Promise<unknown>)(ctx);
    } else if (CLOUD_FUNCTIONS.includes(name)) {
      const mod = await load(`cloud-functions/${name}/index.ts`);
      const handlerName = `onRequest${method.charAt(0)}${method.slice(1).toLowerCase()}`;
      const handler = (mod[handlerName] ?? mod.onRequest) as ((c: unknown) => Promise<unknown>) | undefined;
      if (!handler) {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed', method, route: `/${name}` }));
        return;
      }
      const edgeoneRequest = {
        url: url.toString(), method, headers, query, cookies: {}, body: parsedBody,
        json: () => webReq.clone().json(),
        formData: () => webReq.clone().formData(),
        text: () => webReq.clone().text(),
        arrayBuffer: () => webReq.clone().arrayBuffer(),
      };
      const ctx = {
        request: edgeoneRequest,
        env: process.env,
        params: {},
        uuid: randomUUID(),
        server: { region: 'local', requestId: randomUUID() },
        clientIp: '127.0.0.1',
        geo: undefined,
        agent: { conversation_id: '', store: fakeStore },
      };
      out = await handler(ctx);
    } else {
      out = undefined;
    }
    await writeResponse(res, out);
    console.log(`[harness] ${method} ${url.pathname}${url.search} → ${res.statusCode} (${Date.now() - started}ms)`);
  } catch (e) {
    console.error(`[harness] ${method} ${url.pathname} failed:`, e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'harness_error', message: e instanceof Error ? e.message : String(e) }));
  }
});

server.listen(PORT, () => {
  console.log(`[harness] ClaimSight harness listening on http://localhost:${PORT} (root=${ROOT})`);
  console.log(`[harness] STORAGE=${process.env.STORAGE ?? 'auto'} MEMORIES_STUB=${process.env.MEMORIES_STUB ?? '-'} ADMIN_TOKEN=${process.env.ADMIN_TOKEN ? 'set' : 'unset'}`);
});
