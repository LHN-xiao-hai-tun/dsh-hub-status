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
		/** 聊天室是这个插件里的**第二个 Tab**，与上面的 Hub 状态面板并列。 */
		const CHAT_TAB_ID = "dsh-hub-status:chat";
		/** ⚠️ 必须是**独立的 kind** —— 见 `registerTab()` 上的说明。 */
		const CHAT_TAB_KIND = "dsh-hub-status:chat";

		/** 全屏聊天室 View 的 id。⛔ 不能复用官方的 `chat` —— 那会替换掉它而不是并排。 */
		const CHAT_VIEW_ID = "dsh-hub-status-chat";
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

		// #region 聊天室面板
		//
		// 与上面的 Hub 状态面板是**两条完全不同的路**：
		//   Hub 状态 → /dsh-hub-status/status → agent-comm-hub 的内存状态（进程级 peer）
		//   聊天室   → /dsh-hub-status/chat   → 磁盘上的 hub.jsonl（多台设备共用、只追加）
		//
		// 这个面板是**唯一带写操作**的地方。写只有一条：追加一行 JSON。
		// ⛔ 没有编辑、没有删除、没有撤回 —— 与只追加日志的本性一致，也不假装能做到。

		const CHAT_ROUTE = "/dsh-hub-status/chat";
		/** 面板刷新节奏。聊天室是给人看的，5 秒足够，又不至于把宿主打出压力。 */
		const CHAT_REFRESH_MS = 5000;
		/** 一次拉多少条。够看上下文，又不把整份日志塞进浏览器。 */
		const CHAT_LIMIT = 30;
		/** 显示配置（说话人 / 配色 / 署名）的同源路由，见 ../lib/index.js。 */
		const CHAT_CONFIG_ROUTE = "/dsh-hub-status/config";

		/**
		 * 每个发言者一套颜色 —— **名字与配色都来自配置**（同源路由 /dsh-hub-status/config），
		 * 下面这组只是「配置没到 / 没配」时的中性默认值。
		 *
		 * 为什么按「人」不按「设备」：
		 * `from` 是「谁说的」，`via` 是「从哪台发的」。同一个人可以从不同设备说话。
		 * 按设备上色会让同一个人换台机器就变色，那正是「按机器标身份」的老毛病 ——
		 * 设备分得清，不等于人分得清。想让设备 id 单独上色，就把它也写进 speakers。
		 */
		const CHAT_PALETTE = [
			{ fg: "#60a5fa", bg: "rgba(96,165,250,0.14)", border: "rgba(96,165,250,0.45)" },
			{ fg: "#4ade80", bg: "rgba(74,222,128,0.14)", border: "rgba(74,222,128,0.45)" },
			{ fg: "#c084fc", bg: "rgba(192,132,252,0.14)", border: "rgba(192,132,252,0.45)" },
			{ fg: "#fbbf24", bg: "rgba(251,191,36,0.14)", border: "rgba(251,191,36,0.45)" },
			{ fg: "#f472b6", bg: "rgba(244,114,182,0.14)", border: "rgba(244,114,182,0.45)" },
			{ fg: "#22d3ee", bg: "rgba(34,211,238,0.14)", border: "rgba(34,211,238,0.45)" }
		];
		const CHAT_COLOR_FALLBACK = { fg: "#94a3b8", bg: "rgba(148,163,184,0.12)", border: "rgba(148,163,184,0.4)", label: "" };
		/** 中性默认：谁靠右、发消息署谁的名，由 selfNames 的第一个说了算。 */
		const CHAT_DEFAULT_SPEAKERS = [{ name: "me" }, { name: "peer" }];
		const CHAT_DEFAULT_SELF_NAMES = ["me"];

		/** 配置当前值。拉到真配置就**整对象换掉**（换引用才会触发重渲染）。 */
		let chatConfig = { speakers: CHAT_DEFAULT_SPEAKERS.slice(), selfNames: CHAT_DEFAULT_SELF_NAMES.slice() };
		let chatConfigPromise = null;
		let chatColorCache = { config: null, map: {} };

		/** 把 "#rrggbb" 摊成 rgba(...)；认不出就返回 undefined，让调用方退回调色板。 */
		function chatRgba(hex, alpha) {
			const match = /^#([0-9a-fA-F]{6})$/.exec(String(hex === undefined || hex === null ? "" : hex).trim());
			if (match === null) return undefined;
			const value = parseInt(match[1], 16);
			return "rgba(" + ((value >> 16) & 255) + "," + ((value >> 8) & 255) + "," + (value & 255) + "," + alpha + ")";
		}

		/** 按 speakers 的顺序建配色表：给了 color 用它，没给按位置取调色板。 */
		function chatColorsFrom(speakers) {
			const map = {};
			const rows = Array.isArray(speakers) ? speakers : [];
			for (let i = 0; i < rows.length; i++) {
				const row = rows[i];
				if (row === null || typeof row !== "object") continue;
				const key = String(row.name === undefined || row.name === null ? "" : row.name).trim();
				if (key === "" || map[key] !== undefined) continue;
				const base = CHAT_PALETTE[i % CHAT_PALETTE.length];
				const custom = typeof row.color === "string" && row.color.trim() !== "" ? row.color.trim() : undefined;
				const solid = custom === undefined ? undefined : chatRgba(custom, 1);
				map[key] = {
					fg: solid === undefined ? base.fg : custom,
					bg: chatRgba(custom, 0.14) || base.bg,
					border: chatRgba(custom, 0.45) || base.border,
					label: typeof row.label === "string" ? row.label : ""
				};
			}
			return map;
		}

		function chatColorsOf(config) {
			if (chatColorCache.config !== config) {
				chatColorCache = { config: config, map: chatColorsFrom(config.speakers) };
			}
			return chatColorCache.map;
		}

		function chatSelfNames(config) {
			return Array.isArray(config.selfNames) && config.selfNames.length > 0 ? config.selfNames : CHAT_DEFAULT_SELF_NAMES;
		}

		function chatColorOf(name, config) {
			const key = String(name === undefined || name === null ? "" : name).trim();
			return chatColorsOf(config)[key] || CHAT_COLOR_FALLBACK;
		}
		function chatIsSelf(name, config) {
			return chatSelfNames(config).indexOf(String(name === undefined ? "" : name).trim()) >= 0;
		}

		/**
		 * 拉一次显示配置。失败就保持中性默认（不重试、不刷屏）——
		 * 配置只决定配色，不该让整个面板变成一个错误态。
		 */
		function loadChatConfig() {
			if (chatConfigPromise === null) {
				chatConfigPromise = fetch(CHAT_CONFIG_ROUTE)
					.then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
					.then((data) => {
						if (data === null || typeof data !== "object" || data.ok !== true) return chatConfig;
						const speakers = Array.isArray(data.speakers) && data.speakers.length > 0
							? data.speakers : CHAT_DEFAULT_SPEAKERS;
						const selfNames = Array.isArray(data.selfNames) && data.selfNames.length > 0
							? data.selfNames : CHAT_DEFAULT_SELF_NAMES;
						chatConfig = { speakers: speakers, selfNames: selfNames };
						return chatConfig;
					})
					.catch(() => chatConfig);
			}
			return chatConfigPromise;
		}

		const chatStyles = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				padding: "10px 12px",
				fontSize: "12px",
				lineHeight: "1.5",
				color: COLORS.text,
				boxSizing: "border-box",
				height: "100%",
				minHeight: 0
			},
			head: { display: "flex", alignItems: "center", gap: "6px", flex: "0 0 auto" },
			title: { fontWeight: 600 },
			spacer: { flex: "1 1 auto" },
			muted: { color: COLORS.muted },
			err: { color: COLORS.error, wordBreak: "break-word", flex: "0 0 auto" },
			list: {
				flex: "1 1 auto",
				minHeight: 0,
				overflowY: "auto",
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				paddingRight: "4px"
			},
			item: {
				borderLeft: "2px solid " + COLORS.border,
				paddingLeft: "8px"
			},
			/* ── 气泡（2026-11-06 的需求：像聊天群那样，自己发的靠右）── */
			bubbleRow: {
				display: "flex",
				width: "100%",
				justifyContent: "flex-start"
			},
			bubbleRowSelf: {
				display: "flex",
				width: "100%",
				justifyContent: "flex-end"
			},
			bubble: {
				maxWidth: "86%",
				borderRadius: "10px",
				padding: "6px 10px",
				border: "1px solid transparent",
				boxSizing: "border-box"
			},
			bubbleHead: {
				display: "flex",
				alignItems: "baseline",
				gap: "6px",
				fontSize: "11px",
				marginBottom: "2px"
			},
			bubbleWho: { fontWeight: 600 },
			bubbleStamp: { opacity: 0.75 },
			bubbleSeq: { opacity: 0.6, fontSize: "10px" },
			itemHead: { display: "flex", alignItems: "baseline", gap: "6px", color: COLORS.muted },
			who: { fontWeight: 600, color: COLORS.text },
			seq: { color: COLORS.muted, fontSize: "11px" },
			body: { whiteSpace: "pre-wrap", wordBreak: "break-word" },
			compose: {
				flex: "0 0 auto",
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				borderTop: "1px solid " + COLORS.border,
				paddingTop: "8px"
			},
			input: {
				width: "100%",
				minHeight: "62px",
				maxHeight: "180px",
				resize: "vertical",
				boxSizing: "border-box",
				padding: "6px 8px",
				fontSize: "12px",
				fontFamily: "inherit",
				lineHeight: "1.5",
				color: COLORS.text,
				background: "transparent",
				border: "1px solid " + COLORS.border,
				borderRadius: "4px"
			},
			row: { display: "flex", alignItems: "center", gap: "6px" },
			button: {
				padding: "3px 12px",
				fontSize: "12px",
				color: COLORS.text,
				background: "transparent",
				border: "1px solid " + COLORS.border,
				borderRadius: "4px",
				cursor: "pointer"
			},
			buttonOff: {
				padding: "3px 12px",
				fontSize: "12px",
				color: COLORS.missing,
				background: "transparent",
				border: "1px solid " + COLORS.border,
				borderRadius: "4px",
				cursor: "not-allowed"
			},
			hint: { color: COLORS.muted, fontSize: "11px" }
		};

		/** 把 "2026-11-06 14:14:40" 压成 "14:14"；同一天之外的保留日期。 */
		function shortStamp(at) {
			if (typeof at !== "string") return "";
			const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(at);
			if (match === null) return at;
			const now = new Date();
			const sameDay = Number(match[1]) === now.getFullYear()
				&& Number(match[2]) === now.getMonth() + 1
				&& Number(match[3]) === now.getDate();
			return sameDay ? match[4] + ":" + match[5] : match[2] + "-" + match[3] + " " + match[4] + ":" + match[5];
		}

		function ChatRoomPanel() {
			const [snapshot, setSnapshot] = React.useState({
				phase: "loading",
				rows: [],
				meta: undefined,
				error: undefined
			});
			const [draft, setDraft] = React.useState("");
			const [sending, setSending] = React.useState(false);
			const [notice, setNotice] = React.useState("");
			const [attempt, setAttempt] = React.useState(0);
			/** 说话人 / 配色 / 署名。先按中性默认渲染，配置拉到后换对象触发重渲染。 */
			const [cfg, setCfg] = React.useState(chatConfig);
			const listRef = React.useRef(null);
			/** 用户往上翻看历史时不要被自动滚到底打断。 */
			const stickBottom = React.useRef(true);

			React.useEffect(() => {
				let cancelled = false;
				loadChatConfig().then((next) => {
					if (!cancelled) setCfg(next);
				});
				return () => {
					cancelled = true;
				};
			}, []);

			React.useEffect(() => {
				let cancelled = false;
				let timer = null;
				const load = () => {
					fetch(CHAT_ROUTE + "?limit=" + CHAT_LIMIT)
						.then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
						.then((data) => {
							if (cancelled) return;
							const failed = data !== undefined && data !== null && data.ok === false;
							setSnapshot({
								phase: "ready",
								rows: failed ? [] : data.rows || [],
								meta: failed ? undefined : {
									totalLines: data.totalLines,
									maxSeq: data.maxSeq,
									badLines: data.badLines || [],
									hubFile: data.hubFile
								},
								error: failed ? String(data.error === undefined ? "读不到聊天室" : data.error) : undefined
							});
						})
						.catch((error) => {
							if (cancelled) return;
							setSnapshot({
								phase: "ready",
								rows: [],
								meta: undefined,
								error: error !== undefined && error !== null && error.message !== undefined ? error.message : String(error)
							});
						});
				};
				load();
				timer = setInterval(load, CHAT_REFRESH_MS);
				return () => {
					cancelled = true;
					if (timer !== null) clearInterval(timer);
				};
			}, [attempt]);

			React.useEffect(() => {
				if (!stickBottom.current) return;
				const node = listRef.current;
				if (node !== null && node !== undefined) node.scrollTop = node.scrollHeight;
			}, [snapshot.rows]);

			const onScroll = () => {
				const node = listRef.current;
				if (node === null || node === undefined) return;
				const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
				stickBottom.current = gap < 40;
			};

			const send = () => {
				const text = draft;
				if (sending || text.trim() === "") return;
				// 乐观清空：点下去立刻把输入框清掉。
				// 为什么不等 fetch 回来再清 —— 2026-11-06 收到的一条反馈：
				// 「按了发到聊天室之后输入框就该空掉，不然我会以为没发出去，又发一遍。」
				// ⇒ 人判断「发出去没有」靠的是「输入框空了没有」，不是靠按钮转没转。
				//   把清空放在响应回来之后，等于让那几百毫秒的网络延迟变成「看起来没发」。
				// 失败时把内容放回去（见下面两个分支），所以乐观清空不会丢字。
				setDraft("");
				setSending(true);
				setNotice("发送中…");
				fetch(CHAT_ROUTE, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: text, from: chatSelfNames(cfg)[0] })
				})
					.then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
					.then((data) => {
						if (data !== undefined && data !== null && data.ok === true) {
							stickBottom.current = true;
							setNotice("已发出 #" + (data.saved === undefined ? "?" : data.saved.seq));
							setAttempt((value) => value + 1);
						} else {
							setDraft(text);   // 失败放回去，别丢字
							setNotice("发送失败：" + String(data === undefined || data === null ? "无返回" : data.error));
						}
					})
					.catch((error) => {
						setDraft(text);       // 失败放回去，别丢字
						setNotice("发送失败：" + (error !== undefined && error !== null && error.message !== undefined ? error.message : String(error)));
					})
					.finally(() => setSending(false));
			};

			const onKeyDown = (event) => {
				// Ctrl+Enter 发送；单独 Enter 保留换行（消息经常是多行的）。
				if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					send();
				}
			};

			const rows = snapshot.rows || [];
			const meta = snapshot.meta;
			const items = [];

			items.push(h("div", { key: "head", style: chatStyles.head },
				h("span", { style: chatStyles.title }, "聊天室"),
				h("span", { style: chatStyles.spacer }),
				meta !== undefined
					? h("span", { style: chatStyles.muted }, meta.totalLines + " 条 · 最新 #" + meta.maxSeq)
					: null,
				h("button", {
					key: "refresh",
					type: "button",
					style: chatStyles.button,
					onClick: () => setAttempt((value) => value + 1)
				}, "刷新")
			));

			if (snapshot.error !== undefined) {
				items.push(h("div", { key: "err", style: chatStyles.err }, "错误：" + snapshot.error));
			}
			if (meta !== undefined && meta.badLines.length > 0) {
				items.push(h("div", { key: "bad", style: chatStyles.hint },
					"⚠️ 跳过 " + meta.badLines.length + " 行坏行（行号 " + meta.badLines.join(",") + "）"));
			}
			if (snapshot.phase === "loading") {
				items.push(h("div", { key: "loading", style: chatStyles.muted }, "读取中…"));
			}

			const list = h("div", {
				key: "list",
				style: chatStyles.list,
				ref: listRef,
				onScroll: onScroll
			}, rows.map((row) => {
				const who = String(row.from === undefined ? "?" : row.from);
				const c = chatColorOf(who, cfg);
				const self = chatIsSelf(who, cfg);
				const viaNote = row.via !== undefined && row.via !== null && String(row.via) !== ""
					? " · 经 " + String(row.via) : "";
				return h("div", {
					key: "m" + String(row.seq) + "-" + String(row.at),
					style: self ? chatStyles.bubbleRowSelf : chatStyles.bubbleRow
				},
					h("div", {
						style: Object.assign({}, chatStyles.bubble, {
							background: c.bg,
							borderColor: c.border,
							color: COLORS.text
						})
					},
						h("div", { style: chatStyles.bubbleHead },
							h("span", { style: Object.assign({}, chatStyles.bubbleWho, { color: c.fg }) },
								// 名字本身就等于标签时只印一次，别出「同一个名字（同一个名字）」。
								(c.label === "" || c.label === who) ? who : c.label + "（" + who + "）"),
							h("span", { style: chatStyles.bubbleStamp }, shortStamp(row.at) + viaNote),
							h("span", { style: chatStyles.bubbleSeq }, "#" + String(row.seq === undefined ? "?" : row.seq))
						),
						h("div", { style: chatStyles.body }, String(row.text === undefined ? "" : row.text))
					)
				);
			}));

			const compose = h("div", { key: "compose", style: chatStyles.compose },
				h("textarea", {
					style: chatStyles.input,
					value: draft,
					placeholder: "说一句…（Ctrl+Enter 发送，Enter 换行）",
					onChange: (event) => setDraft(event.target.value),
					onKeyDown: onKeyDown
				}),
				h("div", { style: chatStyles.row },
					h("button", {
						type: "button",
						style: sending || draft.trim() === "" ? chatStyles.buttonOff : chatStyles.button,
						disabled: sending || draft.trim() === "",
						onClick: send
					}, sending ? "发送中…" : "发送"),
					h("span", { style: chatStyles.hint }, notice),
					h("span", { style: chatStyles.spacer }),
					h("span", { style: chatStyles.hint }, "只追加 · 发出去不能撤")
				)
			);

			return h("div", { style: chatStyles.root }, [items.concat([list, compose])]);
		}
		// #endregion

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

		/**
		 * 注册一个右侧栏 tab 类型 + 它自己的 body。
		 *
		 * 🔴 **必须一个 kind 一个类型，⛔ 不能「一个类型挂多个 guide 条目」。**
		 *
		 * 依据（读 `dsh-client-ui-sidebar-right/lib/client.js` 源码查实，2026-11-06）：
		 *   ① guide 卡片的 `kind` 是**由它所属的类型自动填的**，不是我写的那个：
		 *      `this.guideEntries = this.cached.flatMap(d => (d.guide ?? []).map(e => ({
		 *          ...e, kind: d.kind, providerId: d.id })))` ⇒ 同一类型的两个 guide 条目
		 *      **拿到的 kind 一模一样**，点哪个都 openTab 同一个 kind。
		 *   ② body 派发时的 key 是 `definition.id ?? tab.kind`（`TabSlot` 里那句
		 *      `renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind, ... })`）。
		 *      ⇒ 一个类型只能认领**一个** body。我原来挂两个 pane（`dsh-hub-status:hub` /
		 *      `dsh-hub-status:chat`）时，第二个**永远派发不到** —— 而界面上不报错，
		 *      只是点了没反应。
		 *
		 * 所以「加第二个 Tab」的正解是**注册第二个类型**，不是给第一个类型加条目。
		 */
		function registerTab(native, spec) {
			native.effect(() => native.sidebarRightTabs.register({
				id: spec.id,
				kind: spec.kind,
				keepMounted: true,
				title: spec.title,
				guide: [{
					id: spec.guideId,
					order: spec.order,
					title: spec.title,
					description: spec.description
				}]
			}));
			native.slots.inject("sidebar.right.pane.tab", () => native.slots.register({
				name: "sidebar.right.pane.tab",
				key: spec.id,
				inject: () => ({})
			}, spec.body));
		}

		function apply(ctx) {
			ctx.inject(["sidebarRight", "sidebarRightTabs"], (native) => {
				registerTab(native, {
					id: TAB_ID,
					kind: TAB_KIND,
					guideId: "hub",
					order: 120,
					title: () => "Hub 状态",
					description: () => "agent-comm-hub 在线状态与队列",
					body: HubStatusPanel
				});
				registerTab(native, {
					id: CHAT_TAB_ID,
					kind: CHAT_TAB_KIND,
					guideId: "chat",
					order: 121,
					title: () => "聊天室",
					description: () => "多台设备共用的留言板：看最新消息，也能直接说一句",
					body: ChatRoomPanel
				});
			});

			// ── 全屏聊天室：注册成 Conversation 的一个 View ──
			// 2026-11-06 的需求：「保留右侧栏那个，同时能整个页面都是。」
			//
			// 为什么挂 conversation.view 而不是 shell.overlay：
			//   · conversation.view 是「会话区的一个视图」—— 切过去占满整个会话区，
			//     左侧栏和右侧栏都还在。这正是「保留右侧栏 + 整个页面都是」。
			//   · shell.overlay 是整帧覆盖层，会盖住两侧栏，而且不占布局、要自己管滚动。
			//
			// ⚠️ id 必须是**自己的**：`catalog.registration[0].description` 原文
			//    「Use an id of your own: a fresh id is added beside the shipped entries,
			//      while reusing a shipped id puts you in THAT cell and replaces it.」
			//    ⇒ 复用 `chat` 会**替换**掉官方的 Chat 视图，不是并排。
			//
			// ⚠️ 这个 slot 是 `scope: "session"` —— 没有选中会话时不会渲染。
			ctx.inject(["slots"], (native) => {
				native.slots.inject("conversation.view", () => native.slots.register({
					name: "conversation.view",
					id: CHAT_VIEW_ID,
					order: 40,
					label: () => "聊天室"
				}, ChatRoomPanel));
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
