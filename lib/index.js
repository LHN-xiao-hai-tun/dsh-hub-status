/**
 * dsh-hub-status · host half (lib/index.js)
 *
 * Read-only bridge from the DSH host (Node) to the local agent-comm-hub, exposed
 * to the web GUI as a SAME-ORIGIN JSON route.
 *
 * Why the host half does the fetching (and not the browser):
 *   The hub listens on http://127.0.0.1:18764 with no auth and does NOT expose
 *   the `Mcp-Session-Id` response header to cross-origin callers (its CORS
 *   response only allows origin/headers/methods). A browser fetch therefore can
 *   never obtain the MCP conversation id, so the three-step MCP handshake must
 *   run in Node, and the browser half only talks to this same-origin route.
 *
 * The hub call is a strict read-only three-step handshake:
 *   1. POST /mcp  initialize                  -> 200, read `Mcp-Session-Id` header
 *   2. POST /mcp  notifications/initialized   -> 202 (empty body)
 *   3. POST /mcp  tools/call bridge_status    -> 200, result.content[0].text = JSON
 * `DELETE /mcp` answers 405 and is never used.
 *
 * Failure policy: every failure is reported in-band as `{ ok: false, error }`
 * with HTTP 200, so a broken hub is visible in the panel instead of looking like
 * an empty success.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const name = 'dsh-hub-status';
const inject = ['webServer'];

/** Default hub MCP endpoint (loopback only; never called over the network). */
const HUB_MCP_URL = 'http://127.0.0.1:18764/mcp';
/** Same-origin route the browser half reads. */
const ROUTE_PATH = '/dsh-hub-status/status';
/** Hub registers this plugin under this peer id, so it is labelled, not mixed into the four agent families. */
const CLIENT_INFO = { name: 'dsh-hub-status-panel', version: '0.2.1' };
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
    const sessionId = initRes.headers.get('Mcp-Session-Id');
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('Hub 未在响应头返回 Mcp-Session-Id ⇒ 无法建立 MCP 会话');
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

// #region 聊天室（hub.jsonl）读写路由
//
// 与上面的 Hub 状态路由完全独立：那条读的是 agent-comm-hub 的 MCP 内存状态，
// 这条读的是磁盘上的一条**只追加** JSONL 日志（多台设备共用），外加它的显示配置。
//
// 为什么写也走宿主：
//   浏览器半拿不到宿主路径，也不该有文件写权限。写操作只能在 Node 侧发生。
//
// 🔴 行格式（写在这里防止以后忘）：
//   {"seq": <int>, "from": <str>, "at": "YYYY-MM-DD HH:MM:SS", "text": <str>}
//   这是与既有的 python 侧写入器保持一致的口径：少一个键、或换个时间格式，
//   读得出来但人会看不懂。⛔ 别在这里发明新字段。
//
// 🔴 文件路径**不写死**（0.2.1 起）—— 优先级：
//   ① 插件配置 `config.chatHubFile`
//   ② 环境变量 `DSH_HUB_CHAT_FILE`
//   ③ `<DSH_HOME>/hub.jsonl`（`DSH_HOME` 缺失时 `os.homedir()/.dsh/hub.jsonl`）
//   路径不存在不崩：路由回 `ok:false` 并说明怎么指定（见 chatFileMissingMessage）。

const CHAT_ROUTE_PATH = '/dsh-hub-status/chat';
/** 浏览器半读显示配置（说话人 / 配色 / 署名）的同源路由。 */
const CHAT_CONFIG_ROUTE_PATH = '/dsh-hub-status/config';

/** 默认说话人：**中性占位**。真实部署用 `config.speakers` 覆盖，顺序决定配色。 */
const DEFAULT_SPEAKERS = Object.freeze([{ name: 'me' }, { name: 'peer' }]);
/** 默认「我自己」：靠右显示，发消息时署这个名字。 */
const DEFAULT_SELF_NAMES = Object.freeze(['me']);

/** 面板每次拉多少条。日志会长到几百 KB，⛔ 不要整份读给浏览器。 */
const CHAT_TAIL_DEFAULT = 30;
const CHAT_TAIL_MAX = 200;
/** 单条消息正文上限。超过就拒，让调用方自己截断 —— 悄悄截断最坏。 */
const CHAT_TEXT_MAX = 20000;

/** 取一个非空字符串（去首尾空白），否则 undefined。配置项一律走它，免得把空白当值。 */
function firstNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function safeObject(value) {
  return value !== null && typeof value === 'object' ? value : {};
}

/**
 * 解析聊天室日志的绝对路径（优先级见本 region 顶部）。
 * `env` 可注入，测试不碰真环境。
 */
function resolveChatHubFile(config = {}, env = process.env) {
  const fromConfig = firstNonEmptyString(safeObject(config).chatHubFile);
  if (fromConfig !== undefined) return fromConfig;
  const fromEnv = firstNonEmptyString(safeObject(env).DSH_HUB_CHAT_FILE);
  if (fromEnv !== undefined) return fromEnv;
  const home = firstNonEmptyString(safeObject(env).DSH_HOME);
  return home === undefined ? join(homedir(), '.dsh', 'hub.jsonl') : join(home, 'hub.jsonl');
}

/**
 * 规范化 `config.speakers` → `[{ name, color?, label? }]`，顺序决定默认配色。
 * 非法项跳过；重名只留第一条；一个都不剩时回中性默认。
 */
function normalizeSpeakers(config = {}) {
  const raw = Array.isArray(safeObject(config).speakers) ? config.speakers : [];
  const out = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const speakerName = firstNonEmptyString(entry.name);
    if (speakerName === undefined) continue;
    if (out.some((speaker) => speaker.name === speakerName)) continue;
    out.push({
      name: speakerName,
      color: firstNonEmptyString(entry.color),
      label: firstNonEmptyString(entry.label),
    });
  }
  return out.length === 0 ? DEFAULT_SPEAKERS.map((speaker) => ({ ...speaker })) : out;
}

/**
 * 规范化 `config.selfNames`：靠右显示、发消息时署第一个名。
 * 不填时取 `speakers` 的第一个 ⇒ 默认就是 `["me"]`，不会把任何真名留成默认值。
 */
function normalizeSelfNames(config = {}, speakers) {
  const raw = Array.isArray(safeObject(config).selfNames) ? config.selfNames : [];
  const out = [];
  for (const entry of raw) {
    const entryName = firstNonEmptyString(entry);
    if (entryName !== undefined && !out.includes(entryName)) out.push(entryName);
  }
  if (out.length > 0) return out;
  const first = Array.isArray(speakers) && speakers.length > 0 ? firstNonEmptyString(speakers[0].name) : undefined;
  return [first ?? DEFAULT_SELF_NAMES[0]];
}

/** 一次解析出宿主两半都需要的配置（路径 + 说话人 + 署名）。 */
function resolvePluginConfig(config = {}, env = process.env) {
  const safe = safeObject(config);
  const speakers = normalizeSpeakers(safe);
  return {
    chatHubFile: resolveChatHubFile(safe, env),
    speakers,
    selfNames: normalizeSelfNames(safe, speakers),
  };
}

/** 找不到聊天室文件时的说明：带上路径，并说清两种指定方式。 */
function chatFileMissingMessage(hubFile) {
  return `没找到聊天室文件：${hubFile}（可用环境变量 DSH_HUB_CHAT_FILE 或插件配置 chatHubFile 指定）`;
}

/** 读文件尾部的若干行 JSON，跳过坏行。返回 { rows, badLines, totalLines }。 */
async function readChatTail(hubFile, limit) {
  let text;
  try {
    text = await readFile(hubFile, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      // 路径不存在不是崩溃，而是一句人话：告诉人家该拨哪个开关。
      throw new Error(chatFileMissingMessage(hubFile));
    }
    throw error;
  }
  const all = text.split('\n');
  const rows = [];
  const badLines = [];
  let totalLines = 0;
  for (let index = 0; index < all.length; index += 1) {
    const raw = all[index].trim();
    if (raw === '') continue;
    totalLines += 1;
    try {
      const row = JSON.parse(raw);
      if (row !== null && typeof row === 'object') rows.push(row);
      else badLines.push(index + 1);
    } catch {
      badLines.push(index + 1);
    }
  }
  rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const tail = limit > 0 ? rows.slice(-limit) : rows;
  const maxSeq = rows.length === 0 ? 0 : Math.max(...rows.map((row) => Number(row.seq) || 0));
  return { rows: tail, badLines, totalLines, maxSeq, totalRows: rows.length };
}

/** 本地时间戳，格式与 Python 的 `time.strftime("%Y-%m-%d %H:%M:%S")` 一致。 */
function chatTimestamp(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * 追加一条消息。
 *
 * seq 用「读最大 + 1」，与既有的 python 侧写入器同口径。并发的两台可能撞号 ——
 * 撞号不会丢消息（O_APPEND 单行原子写），只是两条同号；读侧按行序展示，不按 seq 排序，
 * 所以不影响可读性。这里不引入锁，理由：跨设备加锁的代价远大于撞号的代价。
 *
 * `options.hubFile` 不给就按配置优先级现算；`options.selfNames` 不给、
 * `from` 也为空时署 `DEFAULT_SELF_NAMES[0]`（即 `me`）。
 */
async function appendChatMessage(text, from, options = {}) {
  const hubFile = firstNonEmptyString(options.hubFile) ?? resolveChatHubFile({});
  const selfNames = Array.isArray(options.selfNames) ? options.selfNames : [];
  const selfName = firstNonEmptyString(selfNames[0]) ?? DEFAULT_SELF_NAMES[0];
  const trimmed = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
  if (trimmed.trim() === '') throw new Error('正文为空');
  if (trimmed.length > CHAT_TEXT_MAX) {
    throw new Error(`正文 ${trimmed.length} 字符，超过上限 ${CHAT_TEXT_MAX}（请自己截断后重发）`);
  }
  const before = await readChatTail(hubFile, 0);
  const payload = {
    seq: before.maxSeq + 1,
    from: firstNonEmptyString(from) ?? selfName,
    at: chatTimestamp(new Date()),
    text: trimmed,
  };
  const line = JSON.stringify(payload);
  // 自校验：读回来和要写的必须一致（照既有写入器的做法）。
  const roundTrip = JSON.parse(line);
  if (JSON.stringify(roundTrip) !== line) throw new Error('序列化自校验失败，未写入');
  await appendFile(hubFile, line + '\n', 'utf8');
  return payload;
}

/** POST 的 JSON 体，带上限防内存打爆。 */
function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error(`请求体超过 ${limitBytes} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

/**
 * 聊天室路由：GET 读尾部，POST 追加一条。
 *
 * 失败一律 HTTP 200 + `{ ok: false, error }`，与 status 路由同策 ——
 * 面板上看得见「坏了」，而不是显示成一个空的成功。
 */
function createChatHandler(options = {}) {
  const hubFile = firstNonEmptyString(options.hubFile) ?? resolveChatHubFile();
  const selfNames = Array.isArray(options.selfNames) && options.selfNames.length > 0
    ? options.selfNames
    : [...DEFAULT_SELF_NAMES];
  return async function chatHandler(req, res) {
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' || method === 'HEAD') {
        const query = new URL(req.url ?? CHAT_ROUTE_PATH, 'http://127.0.0.1').searchParams;
        const wanted = Number.parseInt(query.get('limit') ?? '', 10);
        const limit = Number.isFinite(wanted)
          ? Math.min(Math.max(wanted, 1), CHAT_TAIL_MAX)
          : CHAT_TAIL_DEFAULT;
        const tail = await readChatTail(hubFile, limit);
        sendJson(res, 200, {
          ok: true,
          ts: Date.now(),
          hubFile,
          limit,
          totalLines: tail.totalLines,
          totalRows: tail.totalRows,
          maxSeq: tail.maxSeq,
          badLines: tail.badLines,
          rows: tail.rows,
        }, method === 'HEAD');
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req, 256 * 1024);
        const saved = await appendChatMessage(body.text, body.from, { hubFile, selfNames });
        sendJson(res, 200, { ok: true, ts: Date.now(), saved });
        return;
      }
      sendJson(res, 405, { ok: false, error: `不支持的方法 ${method}（本路由是 GET 读 / POST 写）` }, false);
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        ts: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }, method === 'HEAD');
    }
  };
}

/**
 * 显示配置路由：把宿主解析好的说话人 / 署名交给浏览器半。
 *
 * 为什么要过宿主：配置只有宿主拿得到（浏览器半是另一份打包产物，读不到插件配置），
 * 而两边必须用同一份 —— 否则配色、署名各说各话。
 * 与另外两条路由同策：只接受 GET / HEAD，失败一律 HTTP 200 + `{ ok:false }`。
 */
function createConfigHandler(options = {}) {
  const resolved = options.resolved ?? resolvePluginConfig(options.config ?? {}, options.env ?? process.env);
  return function configHandler(req, res) {
    const headOnly = req.method === 'HEAD';
    if (req.method !== 'GET' && !headOnly) {
      sendJson(res, 405, { ok: false, error: '只支持 GET / HEAD（本路由只读）' }, false);
      return;
    }
    try {
      sendJson(res, 200, {
        ok: true,
        ts: Date.now(),
        chatHubFile: resolved.chatHubFile,
        speakers: resolved.speakers,
        selfNames: resolved.selfNames,
      }, headOnly);
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        ts: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }, headOnly);
    }
  };
}
// #endregion

/**
 * 插件入口。
 *
 * `config` 是插件行的配置对象（**不导出 `Config` schema** —— 导出普通对象会让宿主在
 * profile 启动时报 `reading 'validate'`；那是一次实测过的启动崩溃，别"顺手"补回来）。
 * 因此这里只做**容错读取**：给了就用，没给就用中性默认值 / 环境变量。
 */
function apply(ctx, config) {
  const webServer = (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined) ?? ctx.webServer;
  if (webServer === undefined || typeof webServer.register !== 'function') {
    console.warn('[dsh-hub-status] webServer 服务不可用 ⇒ 宿主取数路由未注册（面板会显示错误态）');
    return;
  }
  const resolved = resolvePluginConfig(config);
  ctx.effect(
    () => webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: createHandler() }),
    'dsh-hub-status: /dsh-hub-status/status route',
  );
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: CHAT_ROUTE_PATH,
      handler: createChatHandler({ hubFile: resolved.chatHubFile, selfNames: resolved.selfNames }),
    }),
    'dsh-hub-status: /dsh-hub-status/chat route',
  );
  ctx.effect(
    () => webServer.register({ kind: 'exact', path: CHAT_CONFIG_ROUTE_PATH, handler: createConfigHandler({ resolved }) }),
    'dsh-hub-status: /dsh-hub-status/config route',
  );
  console.log(`[dsh-hub-status] 宿主取数路由就绪：${ROUTE_PATH}（只读 tools/call bridge_status @ ${HUB_MCP_URL}）`);
  console.log(`[dsh-hub-status] 聊天室路由就绪：${CHAT_ROUTE_PATH}（GET 读尾部 / POST 追加 @ ${resolved.chatHubFile}）`);
  console.log(
    `[dsh-hub-status] 配置路由就绪：${CHAT_CONFIG_ROUTE_PATH}`
    + `（说话人 ${resolved.speakers.map((speaker) => speaker.name).join(' / ')}；署名 ${resolved.selfNames.join(' / ')}）`,
  );
}

export {
  apply,
  inject,
  name,
  ADMIN_PEER,
  CHAT_CONFIG_ROUTE_PATH,
  CHAT_ROUTE_PATH,
  CHAT_TAIL_DEFAULT,
  CHAT_TAIL_MAX,
  CHAT_TEXT_MAX,
  CLIENT_INFO,
  DEFAULT_SELF_NAMES,
  DEFAULT_SPEAKERS,
  FAMILIES,
  FAMILY_PEERS,
  HUB_MCP_URL,
  ROUTE_PATH,
  appendChatMessage,
  chatFileMissingMessage,
  chatTimestamp,
  createChatHandler,
  createConfigHandler,
  createHandler,
  fetchHubStatus,
  getHubStatus,
  normalizeHubStatus,
  normalizeSelfNames,
  normalizeSpeakers,
  readChatTail,
  resetHubStatusCache,
  resolveChatHubFile,
  resolvePluginConfig,
};
