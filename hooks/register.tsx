import type { EngineInterface, Register, RenderElement, Timer } from "claude-code";

import { COLORS, COLS, FRAMES, MOVES, OCTANTS, ROWS, STAND, WALK } from "./frames";

const READ = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch"]);
const WRITE = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const RUN = new Set(["Bash", "BashOutput", "KillShell", "Monitor"]);
const FLOURISHES = [
	"sway",
	"turning",
	"danceOnce",
	"breakOnce",
	"meditate",
	"wave",
	"lookAround",
	"lightbulb",
	"point",
	"music",
];
const CHEERS = ["danceOnce"];
const LOOKS = ["lookEyes", "lookEyes", "lookAround"];
const STUMBLES = ["facepalm", "dizzy"];
const SETTLE_MS = 4000;
const QUIET_MS = 4000;
const STEP_MS = 1000 / 6;

type Paint = { body: string; shade: string };
function paintOf(color: string | undefined): Paint {
	const rgb = color?.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
	if (!rgb) return { body: color ?? "rgb(170,170,180)", shade: color ?? "rgb(135,135,145)" };
	const dark = rgb.slice(1).map((v) => Math.round(Number(v) * 0.78));
	return { body: color as string, shade: `rgb(${dark.join(",")})` };
}

const CREW_MAX = 64;

const CARDS = { plugin: "agent-grid", key: "cards" } as const;
const LIVE = { plugin: "agent-grid", key: "live" } as const;
type Card = {
	id: string;
	kind?: string;
	run?: string;
	status: "running" | "done" | "failed";
	color?: string;
	lines?: { isError?: boolean }[];
	failed?: number;
};
type GridLiveLite = { now?: { kind: string; tool?: string; text?: string }; procs?: unknown[] };

type Work = "laptop" | "desktop" | "thinking";
type Stage =
	| { kind: "idle"; since: number }
	| { kind: "once"; move: string; at: number; then: Stage }
	| { kind: "work"; move: Work; at: number; resume?: boolean }
	| { kind: "walk"; at: number; from: number; to: number; then: Stage }
	| { kind: "gone" };
type Clawd = {
	id: string;
	paint?: Paint;
	stage: Stage;
	x: number;
	flourishAt: number;
	want?: Work;
	lookedAt: number;
	leaving?: boolean;
	doing?: Work;
	activeAt?: number;
	errors?: number;
	mirror?: boolean;
};

const clawd = (id: string, x: number, stage: Stage, paint?: Paint): Clawd => ({
	id,
	paint,
	stage,
	x,
	flourishAt: 0,
	lookedAt: 0,
});
let main = clawd("main", -1, { kind: "idle", since: 0 });
const crew = new Map<string, Clawd>();
let across = 0;
let pending: Timer | undefined;

const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)] as string;
const idle = (now: number): Stage => ({ kind: "idle", since: now });
const nextFlourish = (c: Clawd, now: number, idleFor: number) =>
	now +
	(c !== main
		? 4_000 + Math.random() * 6_000
		: idleFor < 120_000
			? 8_000 + Math.random() * 12_000
			: 30_000 + Math.random() * 30_000);
const home = () => 2 * Math.max(0, across - 13);
const maxX = () => 2 * Math.max(0, across - COLS);

const SPACE = 2 * 9;
const everyone = () => [main, ...crew.values()];
const crowded = () => everyone().length * SPACE > maxX() + SPACE;
function room(x: number, but?: Clawd): number {
	let near = Infinity;
	for (const o of everyone())
		if (o !== but && o.x >= 0 && o.stage.kind !== "gone")
			near = Math.min(near, Math.abs((o.stage.kind === "walk" ? o.stage.to : o.x) - x));
	return near;
}
function spots(c?: Clawd): number[] {
	const full = crowded();
	const out: number[] = [];
	for (let x = 0; x <= maxX(); x += 2) if (full || room(x, c) >= SPACE) out.push(x);
	return out;
}
function freeSpot(): number {
	const free = crowded() ? [] : spots();
	return free.length
		? free.reduce((a, b) => (room(b) > room(a) ? b : a))
		: 2 * Math.floor(Math.random() * (Math.max(0, across - COLS) + 1));
}

function walked(s: Extract<Stage, { kind: "walk" }>, now: number): number {
	const gone = Math.min(Math.abs(s.to - s.from), Math.floor(Math.max(0, now - s.at) / STEP_MS));
	return s.from + Math.sign(s.to - s.from) * gone;
}

function halt(c: Clawd, now: number) {
	if (c.stage.kind === "walk") c.x = 2 * Math.round(walked(c.stage, now) / 2);
}

function walkTo(c: Clawd, now: number, to: number, then: Stage) {
	to = 2 * Math.round(Math.max(0, Math.min(maxX(), to)) / 2);
	c.stage = to === c.x ? then : { kind: "walk", at: now, from: c.x, to, then };
}

function work(c: Clawd, now: number, move: Work) {
	halt(c, now);
	const s = c.stage;
	c.want = undefined;
	if (s.kind === "work") c.want = s.move === move ? undefined : move;
	else if (s.kind === "once" && s.then.kind === "work") c.stage = { ...s, then: { kind: "work", move, at: now } };
	else c.stage = { kind: "work", move, at: now };
}

function finish(c: Clawd, now: number, move: string) {
	halt(c, now);
	c.want = undefined;
	const end: Stage = { kind: "once", move, at: now, then: idle(now) };
	c.stage = c.stage.kind === "work" ? { kind: "once", move: `${c.stage.move}Out`, at: now, then: end } : end;
}

function rest(c: Clawd, now: number) {
	halt(c, now);
	c.want = undefined;
	const s = c.stage;
	if (s.kind === "work") c.stage = { kind: "once", move: `${s.move}Out`, at: now, then: idle(now) };
	else if (s.kind === "once" && s.then.kind === "work") c.stage = { ...s, then: idle(now) };
	else c.stage = idle(now);
}

export function desiredOf(lv: GridLiveLite | undefined): Work | "look" | undefined {
	const n = lv?.now;
	if (n?.kind === "tool") {
		const tool = n.tool ?? "";
		if (RUN.has(tool)) return "desktop";
		if (READ.has(tool)) return "look";
		return "laptop";
	}
	if (n?.kind === "thinking") return "thinking";
	if (n?.kind === "text") return "laptop";
	if (lv?.procs?.length) return "desktop";
	return undefined;
}

function decide(c: Clawd, now: number, since: number) {
	const r = Math.random();
	const rest = idle(since);
	const ways = crowded()
		? []
		: everyone().flatMap((o) =>
				o !== c && o.stage.kind === "walk" && Math.abs(walked(o.stage, now) - c.x) < SPACE
					? [Math.sign(o.stage.to - o.stage.from)]
					: [],
			);
	const free = spots(c).filter((x) => !ways.includes(Math.sign(x - c.x)));
	const long = free.filter((x) => Math.abs(x - c.x) >= 16);
	const far = long.length ? long : free.filter((x) => Math.abs(x - c.x) >= 4);
	const back = free.reduce((a, b) => (Math.abs(b - home()) < Math.abs(a - home()) ? b : a), c.x);
	if (c === main && Math.abs(back - c.x) > 12 && r < 0.3) walkTo(c, now, back, rest);
	else if (r < (c === main ? 0.6 : 0.7) && far.length)
		walkTo(c, now, far[Math.floor(Math.random() * far.length)] as number, rest);
	else c.stage = { kind: "once", move: pick(FLOURISHES), at: now, then: rest };
}

/** His frame at `now` (null once he is gone) and how long until it (or his place) changes; moves him along. */
function frameAt(c: Clawd, now: number): { frame: number; wait: number } | null {
	for (;;) {
		const s = c.stage;
		if (s.kind === "gone") return null;
		if (s.kind === "idle") {
			if (c.leaving) return { frame: STAND, wait: 60_000 };
			if (c.flourishAt === 0) c.flourishAt = nextFlourish(c, now, now - s.since);
			if (now < c.flourishAt) return { frame: STAND, wait: c.flourishAt - now };
			decide(c, now, s.since);
			c.flourishAt = 0;
			continue;
		}
		if (s.kind === "walk") {
			c.x = walked(s, now);
			if (c.x === s.to) {
				if (c.mirror !== undefined && Math.random() < 0.3) c.mirror = !c.mirror;
				c.stage =
					s.then.kind === "idle" ? idle(s.then.since) : s.then.kind === "gone" ? s.then : { ...s.then, at: now };
				continue;
			}
			const phase = c.x & 1;
			const frame = WALK[phase]?.[((c.x % 4) + 4) % 4] as number;
			return { frame, wait: Math.max(16, STEP_MS - (Math.max(0, now - s.at) % STEP_MS)) };
		}
		if (s.kind === "work" && c.want !== undefined) {
			if (c.want === s.move) c.want = undefined;
			else if (now - s.at >= SETTLE_MS) {
				c.stage = { kind: "once", move: `${s.move}Out`, at: now, then: { kind: "work", move: c.want, at: now } };
				c.want = undefined;
				continue;
			}
		}
		const move = MOVES[s.move] as (typeof MOVES)[string];
		const period = 1000 / move.fps;
		let f = Math.max(0, Math.floor((now - s.at) / period));
		if (f >= move.frames.length) {
			if (s.kind === "once") {
				const then = s.then;
				const next = then.kind === "work" ? MOVES[then.move] : undefined;
				const skip = then.kind === "work" && then.resume && next ? (next.loop ?? 0) * (1000 / next.fps) : 0;
				c.stage = then.kind === "idle" || then.kind === "gone" ? then : { ...then, at: now - skip };
				if (c.stage.kind === "idle") c.flourishAt = nextFlourish(c, now, now - c.stage.since);
				continue;
			}
			const from = move.loop ?? 0;
			f = from + ((f - from) % (move.frames.length - from));
		}
		const id = move.frames[f] as number;
		let same = 1;
		while (f + same < move.frames.length && move.frames[f + same] === id) same++;
		let wait = same * period - ((now - s.at) % period);
		if (s.kind === "work" && c.want !== undefined) wait = Math.min(wait, s.at + SETTLE_MS - now);
		return { frame: id, wait: Math.max(16, wait) };
	}
}

function muster(cards: Card[], now: number) {
	for (const card of cards) {
		if (card.status !== "running" || crew.has(card.id) || crew.size >= CREW_MAX) continue;
		crew.set(card.id, {
			...clawd(card.id, freeSpot(), { kind: "once", move: "wave", at: now, then: idle(now) }),
			mirror: Math.random() < 0.5,
		});
	}
	for (const c of crew.values()) {
		const card = cards.find((k) => k.id === c.id);
		if (!card) c.stage = { kind: "gone" };
		else if (card.status === "running") {
			c.paint = paintOf(card.color);
			if (c.leaving) [c.leaving, c.stage, c.doing, c.errors] = [false, idle(now), undefined, undefined];
		} else if (!c.leaving) {
			c.leaving = true;
			c.doing = undefined;
			finish(c, now, card.status === "failed" ? "facepalm" : pick(CHEERS));
		}
	}
}

function liven(cards: Card[], live: Record<string, GridLiveLite>, now: number) {
	for (const c of crew.values()) {
		const card = cards.find((k) => k.id === c.id);
		if (!card || card.status !== "running" || c.leaving) continue;
		const errs = card.failed ?? (card.lines ?? []).filter((l) => l.isError).length;
		c.errors ??= errs;
		if (c.stage.kind === "once" && c.stage.move === "wave") continue;
		const seen = c.errors;
		c.errors = errs;
		if (errs > seen) {
			const t = c.stage;
			const back =
				t.kind === "work"
					? { ...t, resume: true }
					: t.kind === "once" && t.then.kind === "work" && !STUMBLES.includes(t.move)
						? t.then
						: undefined;
			if (back) {
				c.stage = { kind: "once", move: pick(STUMBLES), at: now, then: back };
				c.activeAt = now;
				continue;
			}
		}
		const want = desiredOf(live[c.id]);
		if (want === "look") {
			if (now - c.lookedAt > 15_000) {
				const s = c.stage;
				const g = pick(LOOKS);
				if (s.kind === "idle") c.stage = { kind: "once", move: g, at: now, then: s };
				else if (s.kind === "work" && now - s.at >= SETTLE_MS)
					c.stage = { kind: "once", move: g, at: now, then: { ...s, resume: true } };
				if (c.stage.kind === "once" && c.stage.move === g) c.lookedAt = now;
			}
			c.activeAt = now;
		} else if (want) {
			if (c.doing !== want) {
				work(c, now, want);
				c.doing = want;
			}
			c.activeAt = now;
		} else if (c.doing && now - (c.activeAt ?? 0) > QUIET_MS) {
			rest(c, now);
			c.doing = undefined;
		}
	}
}

function schedule($: EngineInterface, wait: number) {
	pending?.cancel();
	pending = $.clock.after(Math.ceil(wait), () => {
		pending = undefined;
		$.ui.invalidate("ui.render");
	});
}

const EYE = "rgb(0,0,0)";

function paint(key: string, p: Paint | undefined): string | undefined {
	if (key === "." || key === "K") return undefined;
	if (key === "o") return p?.body ?? "clawd_body";
	if (key === "O") return p?.shade ?? "rgb(190,104,77)";
	if (key === "k") return EYE;
	return COLORS[key];
}

type Cell = { glyph: string; fg?: string; bg?: string; eye?: boolean };

const GLYPHS = [...OCTANTS];
const MASK = new Map(GLYPHS.map((glyph, mask) => [glyph, mask]));

const turned = (glyph: string) => {
	const mask = MASK.get(glyph);
	if (mask === undefined) return glyph;
	let out = 0;
	for (let i = 0; i < 8; i++) if ((mask >> i) & 1) out |= 1 << (i ^ 1);
	return GLYPHS[out] as string;
};
const MIRRORED = FRAMES.map((rows) =>
	rows.map((row) => {
		const cps = [...row];
		const cells: string[] = [];
		for (let i = 0; i + 2 < cps.length; i += 3) cells.unshift(turned(cps[i] as string) + cps[i + 1] + cps[i + 2]);
		return cells.join("");
	}),
);

/**
 * The cells of Clawds standing on one spot, back to front, as one cell: each of its 2x4 pixels the front-most painted
 * color. A cell shows two colors, so more give way as the encoder decides: an eye paints its cell's
 * holes black; with a hole left the background stays the terminal's and every painted pixel takes the commonest color,
 * else the two commonest stay and the rest take the first; a tie goes to the one in front.
 */
export function stack(cells: Cell[]): Cell {
	const px: (string | undefined)[] = new Array(8).fill(undefined);
	const depth = new Map<string, number>();
	cells.forEach((c, d) => {
		const mask = MASK.get(c.glyph) ?? 255;
		for (let i = 0; i < 8; i++) {
			const p = (mask >> i) & 1 ? c.fg : c.bg;
			if (p === undefined && c.eye && px[i] !== undefined) {
				px[i] = EYE;
				depth.set(EYE, d);
			}
			if (p === undefined) continue;
			px[i] = p;
			depth.set(p, d);
		}
	});
	if (px.includes(EYE))
		px.forEach((p, i) => {
			if (p === undefined) px[i] = EYE;
		});
	const count = new Map<string | undefined, number>();
	for (const p of px) count.set(p, (count.get(p) ?? 0) + 1);
	const solid = [...depth.keys()]
		.filter((p) => count.has(p))
		.sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0) || (depth.get(b) ?? 0) - (depth.get(a) ?? 0));
	const hole = count.has(undefined);
	const fg = solid[0];
	const bg = hole ? undefined : solid[1];
	let mask = 0;
	px.forEach((p, i) => {
		if (p === fg || (p !== undefined && p !== bg)) mask |= 1 << i;
	});
	return { glyph: GLYPHS[mask] as string, fg, bg };
}

type Placed = { id: string; paint?: Paint; frame: number; left: number; mirror?: boolean };
type Run = Cell & { id: string; r: number; col: number };

/**
 * What the band paints for Clawds standing at `placed` (back to front, each facing his way): runs of cells of one
 * Clawd and one color pair. A cell is one glyph, so where Clawds meet the front one draws it with all of theirs stacked
 * (each drawing his own, the front one's transparent pixels blacked out the one behind).
 */
export function layout(placed: Placed[]): Run[] {
	const cells = new Map<string, { id: string; r: number; col: number; under: Cell[] }>();
	for (const { id, paint: p, frame, left, mirror } of placed)
		((mirror ? MIRRORED : FRAMES)[frame] as string[]).forEach((row, r) => {
			const cps = [...row];
			for (let i = 0; i + 2 < cps.length; i += 3) {
				if (cps[i] === " ") continue;
				const col = left + i / 3;
				const cell = {
					glyph: cps[i] as string,
					fg: paint(cps[i + 1] as string, p),
					bg: paint(cps[i + 2] as string, p),
					eye: cps[i + 2] === "K",
				};
				const at = cells.get(`${r}:${col}`);
				if (!at) cells.set(`${r}:${col}`, { id, r, col, under: [cell] });
				else {
					at.id = id;
					at.under.push(cell);
				}
			}
		});
	const out: (Run & { end: number })[] = [];
	for (const { id, r, col, under } of [...cells.values()].sort((a, b) => a.r - b.r || a.col - b.col)) {
		const { glyph, fg, bg } = under.length > 1 ? stack(under) : (under[0] as Cell);
		const run = out.at(-1);
		if (run?.id === id && run.r === r && run.end === col && run.fg === fg && run.bg === bg) {
			run.glyph += glyph;
			run.end++;
		} else out.push({ id, r, col, end: col + 1, glyph, fg, bg });
	}
	return out;
}

/** `tree` (a Box) with `layer` added to its children and room for his height; null for anything else. */
function onto(tree: unknown, layer: RenderElement[]): any {
	const t = tree as { type?: string; props?: Record<string, unknown>; children?: unknown[] };
	if (t?.type !== "Box") return null;
	const kids = (t.children ?? (t.props?.children as unknown[] | undefined) ?? []) as unknown[];
	const minHeight = Math.max(Number(t.props?.minHeight) || 0, ROWS);
	return { ...t, props: { ...t.props, minHeight }, children: [...kids, ...layer] };
}

export const register: Register = (on) => {
	on("session.start", async ($, e, next) => {
		main = clawd("main", main.x, idle(await $.clock.now()));
		crew.clear();
		return next(e);
	});

	on("turn.start", async ($, e, next) => {
		work(main, await $.clock.now(), "thinking");
		$.ui.invalidate("ui.render");
		return next(e);
	});

	on("tool.call", async ($, e, next) => {
		if (e.agentId !== undefined) return next(e);
		const tool = String(e.tool);
		const now = await $.clock.now();
		const s = main.stage;
		if (WRITE.has(tool)) work(main, now, "laptop");
		else if (RUN.has(tool)) work(main, now, "desktop");
		else if (READ.has(tool) && now - main.lookedAt > 15_000) {
			const g = pick(LOOKS);
			if (s.kind === "idle") main.stage = { kind: "once", move: g, at: now, then: s };
			else if (s.kind === "work" && now - s.at >= SETTLE_MS)
				main.stage = { kind: "once", move: g, at: now, then: { ...s, resume: true } };
			if (main.stage.kind === "once" && main.stage.move === g) main.lookedAt = now;
		}
		$.ui.invalidate("ui.render");
		const result = await next(e);
		if ((result as { isError?: boolean }).isError) {
			const then = await $.clock.now();
			const t = main.stage;
			const back =
				t.kind === "work"
					? { ...t, resume: true }
					: t.kind === "once" && t.then.kind === "work" && !STUMBLES.includes(t.move)
						? t.then
						: undefined;
			if (back) main.stage = { kind: "once", move: pick(STUMBLES), at: then, then: back };
			$.ui.invalidate("ui.render");
		}
		return result;
	});

	on("turn.complete", async ($, e, next) => {
		if (e.agentId === undefined) {
			const now = await $.clock.now();
			finish(
				main,
				now,
				e.reason === "answer" ? pick(CHEERS) : e.reason === "aborted" ? "disappointed" : pick(STUMBLES),
			);
			$.ui.invalidate("ui.render");
		}
		return next(e);
	});

	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		if (e.surface !== "terminal" || e.props.hasSurvey) return next(e);
		const below = await next(e);
		const width = Math.min(e.viewport?.columns ?? Infinity, e.props.bodyColumns + 5);
		if (e.props.maxRows < ROWS || width < 30) return below;
		const now = await $.clock.now();
		if (width !== across) {
			across = width;
			for (const c of everyone()) {
				halt(c, now);
				if (c.stage.kind === "walk") c.stage = c.stage.then;
				c.x = c === main && c.x < 0 ? home() : Math.min(c.x, maxX());
			}
		}
		const cards = ((await $.state.get(CARDS as any).catch(() => undefined))?.value ?? []) as Card[];
		const shown = cards.filter((c) => c.kind !== "workflow" || !cards.some((a) => a.run === c.id));
		muster(shown, now);
		const live = ((await $.state.get(LIVE as any).catch(() => undefined))?.value ?? {}) as Record<string, GridLiveLite>;
		liven(shown, live, now);
		for (const c of everyone())
			if (c.stage.kind === "idle" && c.flourishAt > 0 && now - c.flourishAt > 2000)
				c.flourishAt = nextFlourish(c, now, now - c.stage.since);

		const { Box, Text } = $.ui.resolve(e);
		let wait = Infinity;
		const placed: Placed[] = [];
		for (const c of [...crew.values(), main]) {
			const shown = frameAt(c, now);
			if (!shown) {
				crew.delete(c.id);
				continue;
			}
			wait = Math.min(wait, shown.wait);
			placed.push({
				id: c.id,
				paint: c.paint,
				frame: shown.frame,
				left: c.mirror ? Math.ceil(c.x / 2) : Math.floor(c.x / 2),
				mirror: c.mirror,
			});
		}
		const layer: RenderElement[] = layout(placed).map((run) => (
			<Box key={`clawd-${run.id}-${run.r}-${run.col}`} position="absolute" bottom={ROWS - 1 - run.r} left={run.col}>
				<Text color={run.fg} backgroundColor={run.bg}>
					{run.glyph}
				</Text>
			</Box>
		));
		if (wait < Infinity) schedule($, wait);
		if ((below as { type?: string }).type !== "engine") return onto(below, layer) ?? below;
		return (
			<Box width={across} height={ROWS}>
				{layer}
			</Box>
		);
	});
};
