#!/usr/bin/env node
/**
 * dsh-hub-status · 配置解析与聊天室路由测试（0.2.1 新增）
 *
 * 这组测试**不连网络、不碰真聊天室**：临时目录建一个假日志，跑完删掉。
 * 断言的是 0.2.1 的两条对外承诺：
 *   ① 聊天室路径按 `config.chatHubFile` → `DSH_HUB_CHAT_FILE` → `<DSH_HOME>/hub.jsonl`
 *      的优先级解析，且三个来源都没给时退化到用户主目录（不写死任何一个人的路径）；
 *   ② 说话人 / 署名没配时是**中性默认值**（me / peer），不会把维护者的名字当地址簿。
 *
 * 用法：node test/config.test.mjs（或 npm run test:config）
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	CHAT_ROUTE_PATH,
	CHAT_CONFIG_ROUTE_PATH,
	appendChatMessage,
	chatFileMissingMessage,
	createChatHandler,
	createConfigHandler,
	normalizeSelfNames,
	normalizeSpeakers,
	readChatTail,
	resolveChatHubFile,
	resolvePluginConfig,
} from '../lib/index.js';

const problems = [];

function check(name, condition, detail) {
	if (condition) return;
	problems.push(`${name}${detail === undefined ? '' : `  (${detail})`}`)
}

/** 最小 req/res 替身：够跑 createChatHandler / createConfigHandler。 */
function fakeReq(method, url) {
	return { method, url };
}

function fakeRes() {
	const res = {
		statusCode: 0,
		headers: {},
		body: undefined,
		setHeader(key, value) { res.headers[String(key).toLowerCase()] = value; },
		end(chunk) { res.body = chunk === undefined ? undefined : String(chunk); },
	};
	return res;
}

async function callRoute(handler, method, url) {
	const res = fakeRes();
	await handler(fakeReq(method, url), res);
	const parsed = res.body === undefined ? undefined : JSON.parse(res.body);
	return { status: res.statusCode, json: parsed };
}

// ── ① 路径解析优先级 ────────────────────────────────────────────────────────
{
	const config = { chatHubFile: 'C:/from-config/hub.jsonl' };
	const env = { DSH_HUB_CHAT_FILE: 'C:/from-env/hub.jsonl', DSH_HOME: 'C:/from-home' };
	check('config 优先于环境变量', resolveChatHubFile(config, env) === 'C:/from-config/hub.jsonl', resolveChatHubFile(config, env));
	check('环境变量优先于 DSH_HOME',
		resolveChatHubFile({}, env) === 'C:/from-env/hub.jsonl', resolveChatHubFile({}, env));
	check('DSH_HOME 拼 hub.jsonl',
		resolveChatHubFile({}, { DSH_HOME: 'C:/dsh-home' }).replace(/\\/g, '/') === 'C:/dsh-home/hub.jsonl',
		resolveChatHubFile({}, { DSH_HOME: 'C:/dsh-home' }));
	const bare = resolveChatHubFile({}, {}).replace(/\\/g, '/');
	check('都没给时退化到主目录 /.dsh/hub.jsonl', bare.endsWith('/.dsh/hub.jsonl'), bare);
	check('空字符串不算配置', resolveChatHubFile({ chatHubFile: '   ' }, { DSH_HUB_CHAT_FILE: 'C:/env.jsonl' }) === 'C:/env.jsonl');
	check('config 不是对象也不炸', resolveChatHubFile(null, null).endsWith('hub.jsonl'));
}

// ── ② 说话人与署名 ──────────────────────────────────────────────────────────
{
	const speakers = normalizeSpeakers({});
	check('默认说话人是 me / peer',
		speakers.length === 2 && speakers[0].name === 'me' && speakers[1].name === 'peer',
		JSON.stringify(speakers));
	const custom = normalizeSpeakers({
		speakers: [
			{ name: 'alice', color: '#ff0000' },
			{ name: 'bob' },
			{ name: 'alice' },
			{ name: '   ' },
			null,
			{ color: '#00ff00' },
		],
	});
	check('重名去重 / 非法项跳过', custom.length === 2 && custom[0].name === 'alice' && custom[1].name === 'bob',
		JSON.stringify(custom));
	check('color 保留', custom[0].color === '#ff0000', JSON.stringify(custom[0]));

	const selfDefault = normalizeSelfNames({}, speakers);
	check('selfNames 缺省取第一个说话人', selfDefault.length === 1 && selfDefault[0] === 'me', JSON.stringify(selfDefault));
	const selfExplicit = normalizeSelfNames({ selfNames: ['bob', 'bob', '  '] }, speakers);
	check('selfNames 去重', selfExplicit.length === 1 && selfExplicit[0] === 'bob', JSON.stringify(selfExplicit));
	const derived = normalizeSelfNames({}, normalizeSpeakers({ speakers: [{ name: 'alice' }] }));
	check('只配一个说话人时自己就是他', derived[0] === 'alice', JSON.stringify(derived));

	const resolved = resolvePluginConfig({ speakers: [{ name: 'alice' }], chatHubFile: 'C:/x/hub.jsonl' }, {});
	check('resolvePluginConfig 一次给全', resolved.chatHubFile === 'C:/x/hub.jsonl'
		&& resolved.speakers[0].name === 'alice' && resolved.selfNames[0] === 'alice', JSON.stringify(resolved));
}

// ── ③ 聊天室读写（临时目录） ────────────────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'dsh-hub-status-test-'));
try {
	const hubFile = join(dir, 'hub.jsonl');
	const lines = [];
	for (let seq = 1; seq <= 5; seq += 1) {
		lines.push(JSON.stringify({ seq, from: 'alice', at: '2026-01-01 00:00:0' + seq, text: 'line ' + seq }));
	}
	lines.push('{ this is not json');
	lines.push(JSON.stringify({ seq: 6, from: 'bob', at: '2026-01-01 00:00:06', text: 'last' }));
	await writeFile(hubFile, lines.join('\n') + '\n', 'utf8');

	const tail = await readChatTail(hubFile, 2);
	check('只取尾部 limit 条', tail.rows.length === 2 && tail.rows[1].seq === 6, JSON.stringify(tail.rows));
	check('坏行进 badLines', tail.badLines.length === 1 && tail.badLines[0] === 6, JSON.stringify(tail.badLines));
	check('totalRows 与 maxSeq', tail.totalRows === 6 && tail.maxSeq === 6, JSON.stringify({ r: tail.totalRows, m: tail.maxSeq }));

	const chatHandler = createChatHandler({ hubFile, selfNames: ['alice'] });
	const got = await callRoute(chatHandler, 'GET', CHAT_ROUTE_PATH + '?limit=3');
	check('GET 返回 ok:true', got.status === 200 && got.json.ok === true, JSON.stringify(got.json));
	check('GET 带回 hubFile', got.json.hubFile === hubFile, String(got.json.hubFile));
	check('GET 尊重 limit', got.json.rows.length === 3, String(got.json.rows.length));

	const saved = await appendChatMessage('hello there', '', { hubFile, selfNames: ['alice'] });
	check('append 的 seq = 最大 + 1', saved.seq === 7, String(saved.seq));
	check('append 的 from 缺省用 selfNames[0]', saved.from === 'alice', String(saved.from));
	const after = (await readFile(hubFile, 'utf8')).trim().split('\n');
	check('append 落盘一行', after.length === lines.length + 1, String(after.length));
	check('append 的 at 是 YYYY-MM-DD HH:MM:SS',
		/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(saved.at), saved.at);

	const empty = await callRoute(chatHandler, 'POST', CHAT_ROUTE_PATH);
	check('POST 非法方法（无 body）不抛到进程外', empty.status === 200 && empty.json.ok === false, JSON.stringify(empty.json));

	// 路径不存在：必须 ok:false + 一句人话，而不是崩
	const missingFile = join(dir, 'no-such', 'hub.jsonl');
	const missingHandler = createChatHandler({ hubFile: missingFile, selfNames: ['alice'] });
	const missing = await callRoute(missingHandler, 'GET', CHAT_ROUTE_PATH);
	check('文件不存在时 ok:false', missing.status === 200 && missing.json.ok === false, JSON.stringify(missing.json));
	check('文件不存在时说明里带路径', String(missing.json.error).includes(missingFile), String(missing.json.error));
	check('文件不存在时说明里给两个旋钮',
		String(missing.json.error).includes('DSH_HUB_CHAT_FILE') && String(missing.json.error).includes('chatHubFile'),
		String(missing.json.error));
	check('chatFileMissingMessage 与路由文案一致',
		chatFileMissingMessage(missingFile) === missing.json.error, chatFileMissingMessage(missingFile));
} finally {
	await rm(dir, { recursive: true, force: true });
}

// ── ④ 配置路由 ──────────────────────────────────────────────────────────────
{
	const handler = createConfigHandler({
		resolved: resolvePluginConfig({ speakers: [{ name: 'alice', color: '#123456' }], chatHubFile: 'C:/x/hub.jsonl' }, {}),
	});
	const got = await callRoute(handler, 'GET', CHAT_CONFIG_ROUTE_PATH);
	check('config 路由 ok:true', got.status === 200 && got.json.ok === true, JSON.stringify(got.json));
	check('config 路由带 speakers', got.json.speakers[0].name === 'alice' && got.json.speakers[0].color === '#123456',
		JSON.stringify(got.json.speakers));
	check('config 路由带 selfNames（缺省取第一个说话人）', got.json.selfNames[0] === 'alice', JSON.stringify(got.json.selfNames));
	const denied = await callRoute(handler, 'POST', CHAT_CONFIG_ROUTE_PATH);
	check('config 路由只读', denied.status === 405 && denied.json.ok === false, JSON.stringify(denied.json));
}

if (problems.length > 0) {
	console.error(`FAIL  ${problems.length} 项未达成：`);
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}
console.log('PASS  配置优先级 · 说话人/署名默认值 · 聊天室尾部读取与坏行 · 缺文件人话 · 配置路由');