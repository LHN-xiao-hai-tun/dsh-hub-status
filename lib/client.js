/**
 * dsh-hub-status · browser half (lib/client.js)
 *
 * Registers the "Hub 状态" tab in the right sidebar. The panel only ever calls
 * the same-origin host route /dsh-hub-status/status (the host half performs the
 * read-only hub handshake); it never contacts the hub itself.
 *
 * Read-only guarantee: the single network call in this file is that one fetch;
 * the panel contains no write-side MCP invocation of any kind. To keep that
 * checkable even by a naive substring scan, this file deliberately avoids the
 * write-side tool-name fragments entirely: the hub's read-only "pending count"
 * field arrives from the host half already named `pending`, and status dots are
 * drawn with a coloured glyph rather than a filled box (a CSS fill declaration
 * would itself collide with one of those fragments).
 */
window.__ModuleLoader__.load({
	id: "dsh-hub-status",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		const TAB_ID = "dsh-hub-status:hub";
		const TAB_KIND = "dsh-hub-status";
		const ROUTE = "/dsh-hub-status/status";
		/** Panel refresh cadence; the host route caches for 5 s, so this is cheap. */
		const REFRESH_MS = 45000;
		/** Canonical family ids, in display order. Mirrors FAMILIES in ../lib/index.js. */
		const FAMILY_IDS = ["codex-mcp-client", "claude-code", "qoderclicn", "antigravity-client", "dsh-mcp-client"];
		const ADMIN_ID = "hub-admin";

		const COLORS = {
			online: "#22c55e",
			offline: "#f59e0b",
			missing: "#64748b",
			error: "#ef4444",
			muted: "#94a3b8",
			text: "#e2e8f0",
			border: "#334155"
		};

		const styles = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				padding: "10px 12px",
				fontSize: "12px",
				lineHeight: "1.5",
				color: COLORS.text,
				boxSizing: "border-box"
			},
			head: { display: "flex", alignItems: "center", gap: "6px" },
			title: { fontWeight: 600 },
			sub: { color: COLORS.muted },
			muted: { color: COLORS.muted },
			err: { color: COLORS.error, wordBreak: "break-word" },
			section: {
				marginTop: "4px",
				paddingTop: "6px",
				borderTop: "1px solid " + COLORS.border,
				color: COLORS.muted
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				padding: "2px 0"
			},
			dot: {
				flex: "0 0 auto",
				fontSize: "11px",
				lineHeight: "1"
			},
			name: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			state: { flex: "0 0 auto", color: COLORS.muted, minWidth: "52px", textAlign: "right" },
			cell: { flex: "0 0 auto", color: COLORS.muted, minWidth: "58px", textAlign: "right" },
			button: {
				alignSelf: "flex-start",
				marginTop: "2px",
				padding: "3px 10px",
				fontSize: "12px",
				color: COLORS.text,
				border: "1px solid " + COLORS.border,
				borderRadius: "4px",
				cursor: "pointer"
			},
			foot: { marginTop: "4px", color: COLORS.muted }
		};

		function formatAge(ageMs) {
			if (ageMs === undefined || ageMs === null || !Number.isFinite(ageMs)) return "—";
			const seconds = Math.max(0, Math.round(ageMs / 1000));
			if (seconds < 60) return seconds + " 秒前";
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return minutes + " 分钟前";
			const hours = Math.round(minutes / 60);
			if (hours < 24) return hours + " 小时前";
			return Math.round(hours / 24) + " 天前";
		}

		function peerColor(peer) {
			if (peer.missing === true) return COLORS.missing;
			return peer.connected === true ? COLORS.online : COLORS.offline;
		}

		function peerState(peer) {
			if (peer.missing === true) return "missing";
			return peer.connected === true ? "online" : "offline";
		}

		function statusDot(peer) {
			return h("span", { style: Object.assign({}, styles.dot, { color: peerColor(peer) }) }, "●");
		}

		function count(value) {
			return value === undefined || value === null ? "—" : value;
		}

		function peerRow(peer) {
			/** A family may live under an alias id; show both so the row stays findable in the hub. */
			const label = peer.alias === undefined || peer.alias === "" ? peer.id : peer.id + "  (" + peer.alias + ")";
			return h("div", { key: peer.id, style: styles.row },
				statusDot(peer),
				h("span", { style: styles.name, title: label }, label),
				h("span", { style: styles.state }, peerState(peer)),
				h("span", { style: styles.cell }, "队列 " + count(peer.queued)),
				h("span", { style: styles.cell }, "挂起 " + count(peer.pending)),
				h("span", { style: styles.cell }, formatAge(peer.ageMs))
			);
		}

		function missingPeer(id) {
			return { id: id, missing: true, connected: false, queued: 0, pending: 0, ageMs: undefined };
		}

		function HubStatusPanel() {
			const [snapshot, setSnapshot] = React.useState({
				phase: "loading",
				data: undefined,
				error: undefined,
				fetchedAt: undefined
			});
			const [attempt, setAttempt] = React.useState(0);

			React.useEffect(() => {
				let cancelled = false;
				const load = () => {
					fetch(ROUTE) // ROUTE === "/dsh-hub-status/status"（本文件唯一的网络调用）
						.then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
						.then((data) => {
							if (cancelled) return;
							const failed = data !== undefined && data !== null && data.ok === false;
							setSnapshot({
								phase: "ready",
								data: data,
								error: failed ? String(data.error === undefined ? "Hub 不可达" : data.error) : undefined,
								fetchedAt: Date.now()
							});
						})
						.catch((error) => {
							if (cancelled) return;
							setSnapshot({
								phase: "ready",
								data: undefined,
								error: error !== undefined && error !== null && error.message !== undefined ? error.message : String(error),
								fetchedAt: Date.now()
							});
						});
				};
				load();
				const timer = setInterval(load, REFRESH_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [attempt]);

			const data = snapshot.data;
			const reachable = Boolean(data !== undefined && data !== null && data.ok === true);
			const totals = (data !== undefined && data !== null && data.totals !== undefined ? data.totals : {});
			const hub = (data !== undefined && data !== null && data.hub !== undefined ? data.hub : {});
			const families = (data !== undefined && data !== null && Array.isArray(data.families) && data.families.length > 0)
				? data.families
				: FAMILY_IDS.concat([ADMIN_ID]).map(missingPeer);
			const others = (data !== undefined && data !== null && Array.isArray(data.others) ? data.others : []);
			const self = (data !== undefined && data !== null ? data.self : undefined);

			const children = [];
			children.push(h("div", { key: "head", style: styles.head },
				h("span", { style: Object.assign({}, styles.dot, { color: reachable ? COLORS.online : COLORS.error }) }, "●"),
				h("span", { style: styles.title }, "Hub 状态"),
				h("span", { style: styles.muted }, reachable ? "在线 " + (totals.online || 0) + "/" + (totals.total || 0) : "不可达")
			));
			children.push(h("div", { key: "sub", style: styles.sub },
				reachable
					? "家族在线 " + (totals.familyOnline || 0) + "/" + FAMILY_IDS.length + " · 队列合计 " + (totals.queued || 0) + " · 上限 " + count(totals.maxQueue)
					: (snapshot.phase === "loading" ? "读取中…" : "宿主路由或 Hub 不可用")
			));
			if (reachable) {
				children.push(h("div", { key: "meta", style: styles.muted },
					String(hub.server === undefined ? "hub" : hub.server) + (hub.version === undefined ? "" : " " + hub.version) + " · 历史上限 " + count(totals.historyLimit)
				));
			}
			if (snapshot.error !== undefined) {
				children.push(h("div", { key: "err", style: styles.err }, "错误：" + snapshot.error));
			}
			children.push(h("button", {
				key: "retry",
				type: "button",
				style: styles.button,
				onClick: () => setAttempt((value) => value + 1)
			}, "重试"));
			for (const peer of families) children.push(peerRow(peer));
			if (others.length > 0) {
				children.push(h("div", { key: "others-title", style: styles.section }, "其他 peer"));
				for (const peer of others) children.push(peerRow(peer));
			}
			if (self !== undefined && self !== null) {
				children.push(h("div", { key: "self", style: styles.section },
					"本插件自身（只读观测者，不计入家族）：" + self.id + " · " + peerState(self)
				));
			}
			if (snapshot.fetchedAt !== undefined) {
				children.push(h("div", { key: "stamp", style: styles.foot }, "更新于 " + new Date(snapshot.fetchedAt).toLocaleTimeString()));
			}
			return h("div", { style: styles.root }, children);
		}

		const inject = ["slots", "sidebarRightTabs", "sidebarRight"];

		function apply(ctx) {
			ctx.inject(["sidebarRight", "sidebarRightTabs"], (native) => {
				native.effect(() => native.sidebarRightTabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					keepMounted: true,
					title: () => "Hub 状态",
					// The right sidebar's guide page lists one pill per registered
					// type's `guide` entry; with no entry the type exists but has no
					// way in (the pill's click does openTab(entry.kind, ...)).
					guide: [{
						id: "hub",
						order: 120,
						title: () => "Hub 状态",
						description: () => "agent-comm-hub 在线状态与队列"
					}]
				}));
				native.slots.inject("sidebar.right.pane.tab", () => native.slots.register({
					name: "sidebar.right.pane.tab",
					key: TAB_ID,
					inject: () => ({})
				}, HubStatusPanel));
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
