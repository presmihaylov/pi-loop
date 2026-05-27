import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-loops";
const MIN_INTERVAL_MS = 1_000;

type LoopStatus = "active" | "due" | "running";

type Loop = {
	id: string;
	prompt: string;
	intervalMs: number;
	createdAt: number;
	nextRunAt: number;
	lastRunAt?: number;
	runCount: number;
	status: LoopStatus;
	dueAt?: number;
	timer?: ReturnType<typeof setTimeout>;
};

export default function (pi: ExtensionAPI) {
	const loops = new Map<string, Loop>();
	let latestCtx: ExtensionContext | undefined;
	let runningLoopId: string | undefined;

	function activeLoops(): Loop[] {
		return [...loops.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	function createId(): string {
		for (let attempt = 0; attempt < 20; attempt++) {
			const id = randomUUID().replaceAll("-", "").slice(0, 6);
			if (!loops.has(id)) return id;
		}
		return randomUUID().replaceAll("-", "").slice(0, 10);
	}

	function parseInterval(token: string): number | undefined {
		const match = token.trim().match(/^(\d+)(s|m|h)$/i);
		if (!match) return undefined;

		const amount = Number(match[1]);
		const unit = match[2]?.toLowerCase();
		if (!Number.isFinite(amount) || amount <= 0) return undefined;
		if (unit === "s") return amount * 1_000;
		if (unit === "m") return amount * 60_000;
		if (unit === "h") return amount * 60 * 60_000;
		return undefined;
	}

	function formatInterval(ms: number): string {
		if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
		if (ms % 60_000 === 0) return `${ms / 60_000}m`;
		if (ms % 1_000 === 0) return `${ms / 1_000}s`;
		return `${Math.round(ms / 1_000)}s`;
	}

	function formatIn(ms: number): string {
		if (ms <= 0) return "now";
		const seconds = Math.ceil(ms / 1_000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.ceil(seconds / 60);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		if (rest === 0) return `${hours}h`;
		return `${hours}h${rest}m`;
	}

	function preview(text: string, max = 72): string {
		const singleLine = text.replace(/\s+/g, " ").trim();
		if (singleLine.length <= max) return singleLine;
		return `${singleLine.slice(0, max - 1)}…`;
	}

	function loopLine(loop: Loop): string {
		if (loop.status === "running") return `${loop.id}  every ${formatInterval(loop.intervalMs)}  running  ${preview(loop.prompt)}`;
		if (loop.status === "due") return `${loop.id}  every ${formatInterval(loop.intervalMs)}  due  ${preview(loop.prompt)}`;
		return `${loop.id}  every ${formatInterval(loop.intervalMs)}  next in ${formatIn(loop.nextRunAt - Date.now())}  ${preview(loop.prompt)}`;
	}

	function usage(): string {
		return [
			"Usage:",
			"  /loop <interval> <prompt>",
			"  /loop stop",
			"  /loops",
			"",
			"Examples:",
			"  /loop 5m check CI",
			"  /loop 1h review PR comments",
		].join("\n");
	}

	function updateStatus(ctx?: ExtensionContext): void {
		const currentCtx = ctx ?? latestCtx;
		if (!currentCtx?.hasUI) return;

		const count = loops.size;
		if (count === 0) {
			currentCtx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const dueCount = activeLoops().filter((loop) => loop.status === "due").length;
		const suffix = dueCount > 0 ? ` · ${dueCount} due` : "";
		currentCtx.ui.setStatus(STATUS_KEY, currentCtx.ui.theme.fg("accent", `⟳ ${count} loop${count === 1 ? "" : "s"}${suffix}`));
	}

	function clearTimer(loop: Loop): void {
		if (!loop.timer) return;
		clearTimeout(loop.timer);
		loop.timer = undefined;
	}

	function processDueLoops(ctx?: ExtensionContext): void {
		const currentCtx = ctx ?? latestCtx;
		if (!currentCtx) return;
		latestCtx = currentCtx;

		updateStatus(currentCtx);
		if (runningLoopId) return;
		if (!currentCtx.isIdle()) return;

		const nextLoop = activeLoops()
			.filter((loop) => loop.status === "due")
			.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))[0];
		if (!nextLoop) return;

		nextLoop.status = "running";
		nextLoop.dueAt = undefined;
		nextLoop.lastRunAt = Date.now();
		nextLoop.runCount += 1;
		runningLoopId = nextLoop.id;
		updateStatus(currentCtx);

		const header = `[loop ${nextLoop.id}, run ${nextLoop.runCount}, every ${formatInterval(nextLoop.intervalMs)}]`;
		pi.sendUserMessage(`${header}\n\n${nextLoop.prompt}`);
	}

	function markDue(loop: Loop): void {
		if (!loops.has(loop.id)) return;
		if (loop.status === "running") return;

		loop.status = "due";
		loop.dueAt = Date.now();
		loop.nextRunAt = Date.now();
		loop.timer = undefined;
		processDueLoops();
	}

	function scheduleLoop(loop: Loop, from = Date.now()): void {
		clearTimer(loop);
		if (!loops.has(loop.id)) return;

		loop.status = "active";
		loop.dueAt = undefined;
		loop.nextRunAt = from + loop.intervalMs;
		loop.timer = setTimeout(() => markDue(loop), loop.intervalMs);
		updateStatus();
	}

	function stopLoop(loop: Loop): void {
		clearTimer(loop);
		loops.delete(loop.id);
		if (runningLoopId === loop.id) {
			runningLoopId = undefined;
		}
		updateStatus();
	}

	function startLoop(args: string, ctx: ExtensionCommandContext): void {
		const trimmed = args.trim();
		const spaceIndex = trimmed.indexOf(" ");
		if (spaceIndex === -1) {
			ctx.ui.notify(usage(), "warning");
			return;
		}

		const intervalToken = trimmed.slice(0, spaceIndex);
		const prompt = trimmed.slice(spaceIndex + 1).trim();
		const intervalMs = parseInterval(intervalToken);
		if (!intervalMs || intervalMs < MIN_INTERVAL_MS || !prompt) {
			ctx.ui.notify(usage(), "warning");
			return;
		}

		const loop: Loop = {
			id: createId(),
			prompt,
			intervalMs,
			createdAt: Date.now(),
			nextRunAt: Date.now() + intervalMs,
			runCount: 0,
			status: "active",
		};

		loops.set(loop.id, loop);
		scheduleLoop(loop, Date.now());
		ctx.ui.notify(`Started loop ${loop.id}\nEvery ${formatInterval(intervalMs)} · next in ${formatIn(intervalMs)}`, "info");
		updateStatus(ctx);
	}

	function listLoops(ctx: ExtensionCommandContext): void {
		const currentLoops = activeLoops();
		if (currentLoops.length === 0) {
			ctx.ui.notify("No active loops\nStart one with: /loop 5m check CI", "info");
			return;
		}

		ctx.ui.notify(["Active loops", ...currentLoops.map(loopLine)].join("\n"), "info");
	}

	async function stopCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const currentLoops = activeLoops();
		if (currentLoops.length === 0) {
			ctx.ui.notify("No active loops", "info");
			return;
		}

		const target = args.trim();
		if (target === "all") {
			const count = currentLoops.length;
			for (const loop of currentLoops) stopLoop(loop);
			ctx.ui.notify(`Stopped ${count} loop${count === 1 ? "" : "s"}`, "info");
			return;
		}

		if (target) {
			const matches = currentLoops.filter((loop) => loop.id.startsWith(target));
			if (matches.length === 1) {
				stopLoop(matches[0]);
				ctx.ui.notify(`Stopped loop ${matches[0].id}`, "info");
				return;
			}

			if (matches.length > 1) {
				ctx.ui.notify(`Ambiguous loop id "${target}": ${matches.map((loop) => loop.id).join(", ")}`, "warning");
				return;
			}

			ctx.ui.notify(`No loop matches "${target}"`, "warning");
			return;
		}

		if (currentLoops.length === 1) {
			stopLoop(currentLoops[0]);
			ctx.ui.notify(`Stopped loop ${currentLoops[0].id}`, "info");
			return;
		}

		if (!ctx.hasUI) {
			const first = currentLoops[0];
			stopLoop(first);
			ctx.ui.notify(`Stopped loop ${first.id}`, "info");
			return;
		}

		const options = currentLoops.map(loopLine);
		const selected = await ctx.ui.select("Stop which loop?", options);
		if (!selected) return;

		const id = selected.slice(0, selected.indexOf(" "));
		const loop = loops.get(id);
		if (!loop) {
			ctx.ui.notify(`Loop ${id} is no longer active`, "warning");
			return;
		}

		stopLoop(loop);
		ctx.ui.notify(`Stopped loop ${loop.id}`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		for (const loop of activeLoops()) clearTimer(loop);
		loops.clear();
		runningLoopId = undefined;
		latestCtx = undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		if (runningLoopId) {
			const loop = loops.get(runningLoopId);
			runningLoopId = undefined;
			if (loop) scheduleLoop(loop, Date.now());
		}

		processDueLoops(ctx);
	});

	pi.registerCommand("loop", {
		description: "Run a prompt repeatedly in this pi session: /loop 5m check CI; /loop stop",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const trimmed = args.trim();
			if (trimmed === "stop") {
				await stopCommand("", ctx);
				return;
			}

			if (trimmed.startsWith("stop ")) {
				await stopCommand(trimmed.slice("stop ".length), ctx);
				return;
			}

			if (!trimmed || trimmed === "list" || trimmed === "ls") {
				listLoops(ctx);
				return;
			}

			startLoop(trimmed, ctx);
		},
	});

	pi.registerCommand("loops", {
		description: "List active /loop prompts",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			listLoops(ctx);
		},
	});
}
