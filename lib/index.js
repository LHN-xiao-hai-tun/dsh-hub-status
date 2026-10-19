/**
 * dsh-hub-status · host half (lib/index.js)
 *
 * Read-only bridge from the DSH host (Node) to the local agent-comm-hub, exposed
 * to the web GUI as a SAME-ORIGIN JSON route.
 *
 * Why the host half does the fetching (and not the browser):
 *   The hub listens on http://127.0.0.1:18764 with no auth and does NOT expose
 *   the `mcp-session-id` response header to cross-origin callers (its CORS
 *   response only allows origin/headers/methods). A browser fetch therefore can
 *   never obtain the MCP session id, so the three-step MCP handshake must run in
 *   Node, and the browser half only talks to this same-origin route.
 *
 * The hub call is a strict read-only three-step handshake:
 *   1. POST /mcp  initialize                  -> 200, read `mcp-session-id` header
 *   2. POST /mcp  notifications/initialized   -> 202 (empty body)
 *   3. POST /mcp  tools/call bridge_status    -> 200, result.content[0].text = JSON
 * `DELETE /mcp` answers 405 and is never used.
 *
 * Failure policy: every failure is reported in-band as `{ ok: false, error }`
 * with HTTP 200, so a broken hub is visible in the panel instead of looking like
 * an empty success.
 */

const name = 'dsh-hub-status';
const inject = ['webServer'];

/** Default hub MCP endpoint (loopback only; never called over the network). */
const HUB_MCP_URL = 'http://127.0.0.1:18764/mcp';
/** Same-origin route the browser half reads. */
const ROUTE_PATH = '/dsh-hub-status/status';
/** Hub registers this plugin under this peer id, so it is labelled, not mixed into the four agent families. */
const CLIENT_INFO = { name: 'dsh-hub-status-panel', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-06-18';
/** Per-request timeout for the whole three-step handshake. */
const REQUEST_TIMEOUT_MS = 5000;
/** Result cache lifetime, so the 45 s panel refresh never multiplies hub sessions. */
const CACHE_TTL_MS = 5000;
/**
 * The agent families the panel reports on, in display order.
 *
 * Each family carries its aliases because a GUI-only family registers under a
 * peer id that changes when the app is reinstalled or re-registers: Qoder shows
 * up as `qoder-desktop-mcp-host` on older builds and as `qoderclicn` now. The
 * first alias present in the roster wins, and the panel keeps showing the
 * canonical display id so the row does not move around.
 */
const FAMILIES = [
  { id: 'codex-mcp-client', aliases: ['codex-mcp-client'] },
  { id: 'claude-code', aliases: ['claude-code'] },
  { id: 'qoderclicn', aliases: ['qoderclicn', 'qoder-desktop-mcp-host'] },
  { id: 'antigravity-client', aliases: ['antigravity-client'] },
  { id: 'dsh-mcp-client', aliases: ['dsh-mcp-client'] },
];
/** Canonical family ids, in display order (kept as a flat list for callers/tests). */
const FAMILY_PEERS = FAMILIES.map((family) => family.id);
/** Hub's own admin peer; shown next to the agent families. */
const ADMIN_PEER = 'hub-admin';

/** Parse a JSON body, tolerating an SSE-framed `data:` payload. */
function parseJsonBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the SSE form.
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      return JSON.parse(payload);
    } catch {
      // Keep scanning.
    }
  }
  return undefined;
}

async function postMcp(url, body, sessionId, timeoutMs) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (typeof sessionId === 'string' && sessionId !== '') headers['Mcp-Session-Id'] = sessionId;
  return await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Shape the raw bridge_status payload into the panel contract.
 * Pure function: no I/O, safe to unit-test.
 *
 * Naming note: the hub's read-only `waiting` counter is exposed to the browser
 * half as `pending`. That keeps the write-side tool-name fragments out of the
 * client file entirely, so its read-only claim stays checkable by a naive
 * substring scan as well as by a word-boundary search.
 */
function normalizeHubStatus(raw, meta = {}) {
  const ts = numberOr(meta.ts, Date.now());
  const rawPeers = Array.isArray(raw && raw.peers) ? raw.peers : [];
  const peers = rawPeers.map((peer) => {
    const lastSeenMs = Number.isFinite(peer && peer.lastSeenMs) ? peer.lastSeenMs : undefined;
    const id = typeof (peer && peer.id) === 'string' ? peer.id : '(unknown)';
    return {
      id,
      connected: peer && peer.connected === true,
      queued: numberOr(peer && peer.queued, 0),
      pending: numberOr(peer && peer.waiting, 0),
      lastSeenMs,
      ageMs: lastSeenMs === undefined ? undefined : Math.max(0, ts - lastSeenMs),
      isSelf: id === CLIENT_INFO.name,
    };
  });
  const byId = new Map(peers.map((peer) => [peer.id, peer]));
  const missingEntry = (id) => ({
    id,
    connected: false,
    queued: 0,
    pending: 0,
    lastSeenMs: undefined,
    ageMs: undefined,
    isSelf: id === CLIENT_INFO.name,
    missing: true,
  });
  const entry = (id) => byId.get(id) ?? missingEntry(id);
  /**
   * Resolve a family to whichever of its aliases is actually in the roster.
   * The returned row always reports the canonical id so the panel keeps a
   * stable row order; `peerId` carries the id the hub really uses, which is
   * what the operator needs when they go looking for that peer by hand.
   */
  const familyEntry = (family) => {
    for (const alias of family.aliases) {
      const found = byId.get(alias);
      if (found !== undefined) {
        return { ...found, id: family.id, peerId: alias, alias: alias === family.id ? undefined : alias };
      }
    }
    return { ...missingEntry(family.id), peerId: undefined };
  };
  const families = FAMILIES.map(familyEntry);
  const admin = entry(ADMIN_PEER);
  const self = entry(CLIENT_INFO.name);
  /**
   * Only the id each family actually matched is "accounted for". A family whose
   * old alias is *also* still in the roster would otherwise vanish from the
   * panel entirely; it belongs in `others`, where the operator can see a stale
   * registration instead of quietly losing it.
   */
  const accounted = new Set([
    ...families.map((family) => family.peerId).filter((id) => id !== undefined),
    ...FAMILY_PEERS,
    ADMIN_PEER,
    CLIENT_INFO.name,
  ]);
  const others = peers.filter((peer) => !accounted.has(peer.id));
  const totals = {
    online: peers.filter((peer) => peer.connected).length,
    total: peers.length,
    queued: families.reduce((sum, peer) => sum + numberOr(peer.queued, 0), 0),
    familyOnline: families.filter((peer) => peer.missing !== true && peer.connected === true).length,
    maxQueue: Number.isFinite(raw && raw.maxQueue) ? raw.maxQueue : undefined,
    historyLimit: Number.isFinite(raw && raw.historyLimit) ? raw.historyLimit : undefined,
  };
  return {
    ok: true,
    ts,
    hub: {
      url: typeof meta.url === 'string' ? meta.url : HUB_MCP_URL,
      server: typeof (raw && raw.server) === 'string' ? raw.server : (typeof meta.server === 'string' ? meta.server : undefined),
      version: typeof meta.version === 'string' ? meta.version : undefined,
      reachable: true,
    },
    peers,
    families: [...families, admin],
    self,
    others,
    totals,
  };
}

/**
 * Perform the read-only handshake and return the panel payload.
 * Never throws: on failure it resolves `{ ok: false, error }`.
 * Exported so the test can exercise the real hub.
 */
async function fetchHubStatus(options = {}) {
  const url = typeof options.url === 'string' && options.url !== '' ? options.url : HUB_MCP_URL;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const ts = Date.now();
  const unreachable = (message) => ({
    ok: false,
    ts,
    hub: { url, server: undefined, version: undefined, reachable: false },
    peers: [],
    families: [],
    self: undefined,
    others: [],
    totals: { online: 0, total: 0, queued: 0, familyOnline: 0, maxQueue: undefined, historyLimit: undefined },
    error: message,
  });
  try {
    const initRes = await postMcp(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    }, undefined, timeoutMs);
    if (!initRes.ok) throw new Error(`initialize 返回 HTTP ${initRes.status}`);
    const initBody = parseJsonBody(await initRes.text());
    const sessionId = initRes.headers.get('mcp-session-id');
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('Hub 未在响应头返回 mcp-session-id ⇒ 无法建立 MCP 会话');
    }
    const serverInfo = initBody && initBody.result ? initBody.result.serverInfo : undefined;
    const notified = await postMcp(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId, timeoutMs);
    if (!notified.ok && notified.status !== 202) throw new Error(`notifications/initialized 返回 HTTP ${notified.status}`);
    const callRes = await postMcp(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bridge_status', arguments: {} },
    }, sessionId, timeoutMs);
    if (!callRes.ok) throw new Error(`tools/call bridge_status 返回 HTTP ${callRes.status}`);
    const callBody = parseJsonBody(await callRes.text());
    if (callBody && callBody.error !== undefined) throw new Error(`bridge_status 返回错误：${JSON.stringify(callBody.error)}`);
    const text = callBody && callBody.result && Array.isArray(callBody.result.content)
      ? callBody.result.content[0] && callBody.result.content[0].text
      : undefined;
    if (typeof text !== 'string') throw new Error('bridge_status 返回结构异常（缺少 result.content[0].text）');
    return normalizeHubStatus(JSON.parse(text), {
      url,
      ts,
      server: serverInfo ? serverInfo.name : undefined,
      version: serverInfo ? serverInfo.version : undefined,
    });
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : String(error));
  }
}

let cache = { at: 0, value: undefined };

/** Cached read; `force: true` bypasses the TTL. */
async function getHubStatus(options = {}) {
  const now = Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : CACHE_TTL_MS;
  if (options.force !== true && cache.value !== undefined && now - cache.at < ttlMs) {
    return { ...cache.value, cached: true, cacheAgeMs: now - cache.at };
  }
  const value = await fetchHubStatus(options);
  cache = { at: Date.now(), value };
  return { ...value, cached: false, cacheAgeMs: 0 };
}

function resetHubStatusCache() {
  cache = { at: 0, value: undefined };
}

function sendJson(res, status, body, headOnly) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  if (headOnly) {
    res.end();
    return;
  }
  res.end(JSON.stringify(body));
}

/** Build the route handler. Failures still answer HTTP 200 with `ok: false`. */
function createHandler(options = {}) {
  return async function hubStatusHandler(req, res) {
    const headOnly = req.method === 'HEAD';
    if (req.method !== 'GET' && !headOnly) {
      sendJson(res, 405, { ok: false, error: '只支持 GET / HEAD（本路由只读）' }, false);
      return;
    }
    let force = false;
    try {
      const query = new URL(req.url ?? ROUTE_PATH, 'http://127.0.0.1').searchParams;
      force = query.get('refresh') === '1';
    } catch {
      force = false;
    }
    try {
      const body = await getHubStatus({ ...options, force });
      sendJson(res, 200, body, headOnly);
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        ts: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }, headOnly);
    }
  };
}

function apply(ctx) {
  const webServer = (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined) ?? ctx.webServer;
  if (webServer === undefined || typeof webServer.register !== 'function') {
    console.warn('[dsh-hub-status] webServer 服务不可用 ⇒ 宿主取数路由未注册（面板会显示错误态）');
    return;
  }
  ctx.effect(
    () => webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: createHandler() }),
    'dsh-hub-status: /dsh-hub-status/status route',
  );
  console.log(`[dsh-hub-status] 宿主取数路由就绪：${ROUTE_PATH}（只读 tools/call bridge_status @ ${HUB_MCP_URL}）`);
}

export {
  apply,
  inject,
  name,
  ADMIN_PEER,
  CLIENT_INFO,
  FAMILIES,
  FAMILY_PEERS,
  HUB_MCP_URL,
  ROUTE_PATH,
  createHandler,
  fetchHubStatus,
  getHubStatus,
  normalizeHubStatus,
  resetHubStatusCache,
};
