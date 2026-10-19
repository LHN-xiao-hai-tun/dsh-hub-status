#!/usr/bin/env node
/**
 * dsh-hub-status · 活体测试（host half）
 *
 * 真连本机 agent-comm-hub，走与面板完全相同的取数链路（fetchHubStatus），
 * 断言：HUB_OK=true · PEERS >= 5 · 每个家族在 Hub 名册里都能找到（含别名）。
 *
 * 「可见」的判据是 normalizeHubStatus 的 families[].missing !== true ——
 * 它才是面板上那一行的真实状态。家族换了 peer id（Qoder 从
 * qoder-desktop-mcp-host 变成 qoderclicn）时 missing 会变 true，测试就会失败，
 * 这正是本测试存在的意义：id 漂移必须显形，不能在面板上悄悄变成一行灰字。
 *
 * Hub 未启动时本测试会失败并打印原因 —— 这是预期行为，不是本插件的缺陷。
 * 本测试只读：它只调用 bridge_status。
 */
import { ADMIN_PEER, FAMILIES, FAMILY_PEERS, fetchHubStatus } from '../lib/index.js';

const MIN_PEERS = 5;

const status = await fetchHubStatus();

console.log(`HUB_URL=${status.hub && status.hub.url ? status.hub.url : '(unknown)'}`);
console.log(`HUB_OK=${status.ok}`);

if (status.ok) {
	console.log(`HUB_SERVER=${status.hub.server ?? '(unknown)'}  HUB_VERSION=${status.hub.version ?? '(unknown)'}`);
	console.log(
		`PEERS=${status.totals.total}  ONLINE=${status.totals.online}  QUEUED=${status.totals.queued}`
		+ `  MAXQUEUE=${status.totals.maxQueue ?? '(unknown)'}  HISTORY_LIMIT=${status.totals.historyLimit ?? '(unknown)'}`
	);
	console.log(`FAMILY_ONLINE=${status.totals.familyOnline}/${FAMILY_PEERS.length}`);
	console.log('--- peers ---');
	for (const peer of status.peers) {
		console.log(
			`PEER ${peer.id}  connected=${peer.connected}  queued=${peer.queued}`
			+ `  pending=${peer.pending}  ageMs=${peer.ageMs === undefined ? '-' : peer.ageMs}`
		);
	}
	console.log('--- families ---');
	for (const peer of status.families) {
		console.log(
			`FAMILY ${peer.id}  visible=${peer.missing !== true}  alias=${peer.alias ?? '-'}`
			+ `  connected=${peer.connected === true}  queued=${peer.queued}  pending=${peer.pending}`
		);
	}
	const admin = status.families.find((peer) => peer.id === ADMIN_PEER);
	console.log(`ADMIN ${ADMIN_PEER}  visible=${Boolean(admin) && admin.missing !== true}`);
	console.log(`SELF ${status.self && status.self.id ? status.self.id : '(none)'}`);
} else {
	console.log(`HUB_ERROR=${status.error}`);
}

const problems = [];
if (status.ok !== true) {
	problems.push(`Hub 不可达：${status.error}`);
} else {
	if (status.totals.total < MIN_PEERS) problems.push(`PEERS=${status.totals.total} < ${MIN_PEERS}`);
	for (const family of FAMILIES) {
		const peer = status.families.find((entry) => entry.id === family.id);
		if (!peer || peer.missing === true) {
			problems.push(`家族不可见：${family.id}（别名 ${family.aliases.join(' / ')} 全不在 Hub 名册）`);
		}
	}
}

if (problems.length > 0) {
	console.error(`FAIL  ${problems.length} 项未达成：`);
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}
console.log(`PASS  HUB_OK=true · PEERS=${status.totals.total} >= ${MIN_PEERS} · ${FAMILY_PEERS.length} 个家族全部可见`);
