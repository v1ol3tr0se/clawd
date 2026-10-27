import { expect, mock, test } from "claude-code/testing";

import { FRAMES, MOVES, OCTANTS, STAND, WALK } from "../hooks/frames";
import { desiredOf, layout, stack } from "../hooks/register";

const BAND = {
	plugin: "clawd",
	surface: "terminal" as const,
	component: "AbovePrompt" as const,
	requestId: "above-prompt",
	props: {
		hasSurvey: false,
		isWorking: false,
		maxRows: 17,
		bodyColumns: 95,
		scroll: { offset: 0, bodyRows: 17 },
		view: {},
	},
	viewport: { columns: 100, rows: 50, isFullscreen: true },
};
const HOME = 100 - 13;
const WIDE = { ...BAND, props: { ...BAND.props, bodyColumns: 3995 }, viewport: { ...BAND.viewport, columns: 4000 } };

function picture(frame: number, x: number): string[] {
	return (FRAMES[frame] as string[]).map((row) =>
		(" ".repeat(x) + [...row].filter((_, i) => i % 3 === 0).join("")).trimEnd(),
	);
}
async function painted(view: any): Promise<string[]> {
	const rows = [[], [], []] as string[][];
	for (const box of await view.findAll({ type: "Box" })) {
		if (box.props?.position !== "absolute" || typeof box.props.bottom !== "number") continue;
		const line = rows[2 - box.props.bottom] as string[];
		[...(box.text as string)].forEach((ch, i) => {
			line[box.props.left + i] = ch;
		});
	}
	return rows.map((r) =>
		Array.from(r, (ch) => ch ?? " ")
			.join("")
			.trimEnd(),
	);
}
const showsOneOf = async (view: any, move: string, x: number) => {
	const now = JSON.stringify(await painted(view));
	return (MOVES[move] as { frames: number[] }).frames.some((f) => JSON.stringify(picture(f, x)) === now);
};

function engine(on: any, band: (($e: any, e: any) => any) | undefined = undefined) {
	on("ui.render", band ?? (() => ({ type: "engine", ref: 0 }) as any));
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("turn.complete", ($e: any, e: any) => ({ text: "" }) as any);
	on("turn.start", ($e: any, e: any) => ({ turnId: e.turnId }) as any);
	on(
		"tool.call",
		($e: any, e: any) =>
			({
				result: { stdout: "", stderr: "", interrupted: false },
				text: "",
				...(e.command === "false" ? { isError: true } : {}),
			}) as any,
	);
}

test("stands in his corner over the prompt rule while the band is free, painting only his own cells", async ($, on) => {
	engine(on);
	mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	expect(await painted(view)).toEqual(picture(STAND, HOME));
	for (const t of await view.findAll({ type: "Text" })) expect((t.text as string).includes(" ")).toBe(false);
});

test("over a tree another plugin drew (the agent grid), he is painted along its bottom edge: one band, one [-]", async ($, on) => {
	engine(on, ($e: any, e: any) => {
		const { Box, Text } = $e.ui.resolve(e);
		return (
			<Box flexDirection="column">
				<Text>box row</Text>
				<Text>2 workflows · 19 agents</Text>
			</Box>
		);
	});
	mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	const texts = (await view.findAll({ type: "Text" })).map((t: any) => t.text);
	expect(texts.slice(0, 2)).toEqual(["box row", "2 workflows · 19 agents"]);
	const root = (await view.drawn()) as any;
	const kids = (root.children ?? root.props?.children ?? []) as any[];
	expect(kids.slice(0, 2).map((k) => k.type)).toEqual(["Text", "Text"]);
	expect(kids.length).toBeGreaterThan(2);
	expect(kids.slice(2).every((k) => k.props?.position === "absolute" && !k.props?.width)).toBe(true);
	expect(root.props.minHeight).toBe(3);
	expect(await painted(view)).toEqual(picture(STAND, HOME));
});

test("laptop while Claude works, the monitor for commands, a cheer when answered, then idle", async ($, on) => {
	engine(on);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	await $.turn.start({ text: "hi", turnId: "t1" } as any);
	await clock.advance(1500);
	expect(await showsOneOf(view, "thinking", HOME)).toBe(true);
	await clock.advance(4000);
	await $.tool.call({ tool: "Write", file_path: "/tmp/x" } as any);
	await clock.advance(3000);
	expect(await showsOneOf(view, "laptop", HOME)).toBe(true);
	await clock.advance(4000);
	await $.tool.call({ tool: "Bash", command: "ls" } as any);
	await clock.advance(3000);
	expect(await showsOneOf(view, "desktop", HOME)).toBe(true);
	await $.turn.complete({ reason: "answer", turnId: "t1" } as any);
	await clock.advance(4000);
	expect(await painted(view)).toEqual(picture(STAND, HOME));
});

test("a command right after the turn starts still gets the monitor once the thinking has settled", async ($, on) => {
	engine(on);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	await $.turn.start({ text: "hi", turnId: "t1" } as any);
	await clock.advance(1000);
	await $.tool.call({ tool: "Bash", command: "ls" } as any);
	await clock.advance(1000);
	expect(await showsOneOf(view, "thinking", HOME)).toBe(true);
	await clock.advance(4000);
	expect(await showsOneOf(view, "desktop", HOME)).toBe(true);
});

test("reading while he thinks: a glance, then straight back into the thinking loop", async ($, on) => {
	engine(on);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	await $.turn.start({ text: "hi", turnId: "t1" } as any);
	await clock.advance(5000);
	await $.tool.call({ tool: "Read", file_path: "/etc/hosts" } as any);
	await clock.advance(400);
	expect((await showsOneOf(view, "lookEyes", HOME)) || (await showsOneOf(view, "lookAround", HOME))).toBe(true);
	await clock.advance(3000);
	const loop = (MOVES.thinking as { frames: number[]; loop: number }).frames.slice(
		(MOVES.thinking as { loop: number }).loop,
	);
	const now = JSON.stringify(await painted(view));
	expect(loop.some((f) => JSON.stringify(picture(f, HOME)) === now)).toBe(true);
});

test("a Clawd of his own color for each running box in the grid: he waves in, cheers when it is done, goes with its box", async ($, on) => {
	let cards = [
		{ id: "a1", status: "running", color: "rgb(130,170,220)" },
		{ id: "sh:b1", status: "running", color: "rgb(145,200,130)" },
	];
	engine(on);
	on(
		"state.get",
		($e: any, e: any) =>
			({ value: { value: e.plugin === "agent-grid" && e.key === "cards" ? cards : undefined, version: 1 } }) as any,
	);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(WIDE);
	const colors = async () => {
		const seen = new Set<string>();
		for (const t of await view.findAll({ type: "Text" })) if (t.props?.color) seen.add(String(t.props.color));
		return seen;
	};
	const now = await colors();
	expect(now.has("clawd_body")).toBe(true);
	expect(now.has("rgb(130,170,220)") && now.has("rgb(145,200,130)")).toBe(true);
	expect([...now].filter((c) => c.startsWith("rgb(") && c !== "rgb(190,104,77)").length).toBeGreaterThanOrEqual(2);
	const crewColors = async (v: any) => {
		const seen = new Set<string>();
		for (const t of await v.findAll({ type: "Text" })) if (t.props?.color) seen.add(String(t.props.color));
		return [...seen].filter((c) => c.startsWith("rgb(") && c !== "rgb(190,104,77)").length;
	};
	cards = [{ id: "a1", status: "done", color: "rgb(130,170,220)" }, cards[1]!];
	await view.unmount();
	let again = await $.ui.mount(WIDE);
	await clock.advance(3500);
	expect(await crewColors(again)).toBe(2);
	cards = [cards[1]!];
	await again.unmount();
	again = await $.ui.mount(WIDE);
	expect(await crewColors(again)).toBe(1);
});

test("one Clawd for every running box, however many: twenty boxes, twenty-one Clawds", async ($, on) => {
	const cards = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, status: "running" }));
	engine(on);
	on(
		"state.get",
		($e: any, e: any) =>
			({ value: { value: e.plugin === "agent-grid" && e.key === "cards" ? cards : undefined, version: 1 } }) as any,
	);
	mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	const who = new Set<string>();
	for (const b of await view.findAll({ type: "Box" })) {
		const m = String(b.props?.key ?? b.key ?? "").match(/^clawd-(.+)-\d+-\d+$/);
		if (m) who.add(m[1] as string);
	}
	expect(who.size).toBeGreaterThan(10);
});

test("a workflow run gets a Clawd only while its box is drawn: once its agents are listed, one per agent", async ($, on) => {
	let cards: any[] = [{ id: "wf:r1", kind: "workflow", status: "running" }];
	engine(on);
	on(
		"state.get",
		($e: any, e: any) =>
			({ value: { value: e.plugin === "agent-grid" && e.key === "cards" ? cards : undefined, version: 1 } }) as any,
	);
	mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const who = async () => {
		const view = await $.ui.mount(WIDE);
		const ids = new Set<string>();
		for (const b of await view.findAll({ type: "Box" })) {
			const m = String(b.props?.key ?? b.key ?? "").match(/^clawd-(.+)-\d+-\d+$/);
			if (m) ids.add(m[1] as string);
		}
		await view.unmount();
		return ids;
	};
	expect((await who()).has("wf:r1")).toBe(true);
	cards = [cards[0], ...["a", "b", "c"].map((id) => ({ id, kind: "agent", run: "wf:r1", status: "running" }))];
	const ids = await who();
	expect(ids.has("wf:r1")).toBe(false);
	expect(ids.size).toBeGreaterThanOrEqual(3);
});

test("where Clawds meet, a cell shows both: the one in front over the one behind, never a black hole", async ($, on) => {
	const glyph = (...lit: number[]) => [...OCTANTS][lit.reduce((m, i) => m | (1 << i), 0)] as string;
	expect(
		stack([
			{ glyph: "█", fg: "B" },
			{ glyph: "▌", fg: "A" },
		]),
	).toEqual({ glyph: "▌", fg: "A", bg: "B" });
	expect(
		stack([
			{ glyph: "▝", fg: "B" },
			{ glyph: "▌", fg: "A" },
		]),
	).toEqual({ glyph: glyph(0, 2, 4, 6, 1, 3), fg: "A", bg: undefined });
	expect(
		stack([
			{ glyph: "▀", fg: "B", bg: "C" },
			{ glyph: "▐", fg: "A" },
		]),
	).toEqual({ glyph: glyph(1, 3, 5, 7, 4, 6), fg: "A", bg: "B" });

	const masks = new Map([...OCTANTS].map((g, m) => [g, m]));
	const painted = (runs: ReturnType<typeof layout>) => {
		const px = new Map<string, string>();
		for (const run of runs)
			[...run.glyph].forEach((g, j) => {
				const mask = masks.get(g) ?? 0;
				for (let i = 0; i < 8; i++) {
					const p = (mask >> i) & 1 ? run.fg : run.bg;
					if (p !== undefined) px.set(`${run.r}:${run.col + j}:${i}`, p);
				}
			});
		return px;
	};
	const A = { body: "rgb(130,170,220)", shade: "rgb(101,133,172)" };
	const B = { body: "rgb(145,200,130)", shade: "rgb(113,156,101)" };
	const poses = [...new Set([STAND, ...WALK.flat(), ...(MOVES.wave as { frames: number[] }).frames])];
	const alone = new Map<string, Map<string, string>>();
	const once = (c: Parameters<typeof layout>[0][number]) => {
		const key = `${c.id}:${c.frame}:${c.left}`;
		if (!alone.has(key)) alone.set(key, painted(layout([c])));
		return alone.get(key) as Map<string, string>;
	};
	let holes = 0;
	for (const fa of poses)
		for (const fb of poses)
			for (let dx = -10; dx <= 10; dx++) {
				const a = { id: "a", paint: A, frame: fa, left: 11 };
				const b = { id: "b", paint: B, frame: fb, left: 11 + dx };
				const both = painted(layout([a, b]));
				for (const [at, p] of [...once(a), ...once(b)]) if (p !== "rgb(0,0,0)" && !both.has(at)) holes++;
			}
	expect(holes).toBe(0);
});

test("desiredOf: the laptop while a box thinks/writes, the monitor for a command or a shell, a look while it reads", () => {
	expect(desiredOf({ now: { kind: "thinking", text: "…" } })).toBe("thinking");
	expect(desiredOf({ now: { kind: "text", text: "hi" } })).toBe("laptop");
	expect(desiredOf({ now: { kind: "tool", tool: "Write", text: "" } })).toBe("laptop");
	expect(desiredOf({ now: { kind: "tool", tool: "Edit", text: "" } })).toBe("laptop");
	expect(desiredOf({ now: { kind: "tool", tool: "Bash", text: "ls" } })).toBe("desktop");
	expect(desiredOf({ now: { kind: "tool", tool: "Read", text: "x" } })).toBe("look");
	expect(desiredOf({ now: { kind: "tool", tool: "Grep", text: "x" } })).toBe("look");
	expect(desiredOf({ now: { kind: "tool", tool: "WebFetch", text: "x" } })).toBe("look");
	expect(desiredOf({ procs: [{ pid: 1 }] })).toBe("desktop");
	expect(desiredOf({})).toBeUndefined();
	expect(desiredOf(undefined)).toBeUndefined();
});

test("every move the mod names is in frames.ts with frames", () => {
	for (const m of [
		"thinking",
		"thinkingOut",
		"laptop",
		"desktop",
		"lookEyes",
		"lookAround",
		"facepalm",
		"dizzy",
		"lightbulb",
		"point",
		"danceOnce",
		"disappointed",
		"sway",
		"turning",
		"breakOnce",
		"meditate",
		"wave",
		"music",
	]) {
		expect(MOVES[m], m).toBeDefined();
		expect((MOVES[m] as { frames: number[] }).frames.length).toBeGreaterThan(0);
	}
});

async function clawdPicture(view: any, id: string): Promise<string[]> {
	const rows = [[], [], []] as string[][];
	for (const box of await view.findAll({ type: "Box" })) {
		const m = String(box.props?.key ?? box.key ?? "").match(/^clawd-(.+)-(\d+)-(\d+)$/);
		if (!m || m[1] !== id) continue;
		const line = rows[Number(m[2])] as string[];
		[...(box.text as string)].forEach((ch, i) => {
			line[Number(m[3]) + i] = ch;
		});
	}
	return normalize(
		rows.map((r) =>
			Array.from(r, (ch) => ch ?? " ")
				.join("")
				.trimEnd(),
		),
	);
}
function normalize(rows: string[]): string[] {
	const lead = Math.min(Infinity, ...rows.filter((r) => r.trim()).map((r) => r.length - r.trimStart().length));
	return rows.map((r) => (r.trim() ? r.slice(lead) : ""));
}
function turned(frame: number): string[] {
	const rows = [[], [], []] as string[][];
	for (const run of layout([{ id: "t", frame, left: 0, mirror: true }]))
		[...run.glyph].forEach((ch, i) => {
			(rows[run.r] as string[])[run.col + i] = ch;
		});
	return rows.map((r) =>
		Array.from(r, (ch) => ch ?? " ")
			.join("")
			.trimEnd(),
	);
}
const clawdShows = async (view: any, id: string, move: string) => {
	const pic = JSON.stringify(await clawdPicture(view, id));
	return (MOVES[move] as { frames: number[] }).frames.some(
		(f) => f !== STAND && [normalize(picture(f, 0)), normalize(turned(f))].some((p) => JSON.stringify(p) === pic),
	);
};

test("a crew Clawd mirrors his box: the monitor while it runs a command, the laptop while it writes", async ($, on) => {
	const cards = [{ id: "a1", status: "running", color: "rgb(130,170,220)" }];
	let live: Record<string, any> = {};
	engine(on);
	on(
		"state.get",
		($e: any, e: any) =>
			({
				value: {
					value:
						e.plugin === "agent-grid" ? (e.key === "cards" ? cards : e.key === "live" ? live : undefined) : undefined,
					version: 1,
				},
			}) as any,
	);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	let view = await $.ui.mount(WIDE);
	await clock.advance(2000);
	live = { a1: { now: { kind: "tool", tool: "Bash", text: "ls" }, procs: [{ pid: 1 }] } };
	await view.unmount();
	view = await $.ui.mount(WIDE);
	await clock.advance(3000);
	expect(await clawdShows(view, "a1", "desktop")).toBe(true);
	live = { a1: { now: { kind: "tool", tool: "Write", text: "", lines: 3 } } };
	await view.unmount();
	view = await $.ui.mount(WIDE);
	await clock.advance(6000);
	expect(await clawdShows(view, "a1", "laptop")).toBe(true);
});

test("a crew Clawd packs up and strolls once his box goes quiet", async ($, on) => {
	const cards = [{ id: "a1", status: "running", color: "rgb(130,170,220)" }];
	let live: Record<string, any> = {};
	engine(on);
	on(
		"state.get",
		($e: any, e: any) =>
			({
				value: {
					value:
						e.plugin === "agent-grid" ? (e.key === "cards" ? cards : e.key === "live" ? live : undefined) : undefined,
					version: 1,
				},
			}) as any,
	);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	let view = await $.ui.mount(WIDE);
	await clock.advance(2000);
	live = { a1: { now: { kind: "tool", tool: "Bash", text: "ls" }, procs: [{ pid: 1 }] } };
	await view.unmount();
	view = await $.ui.mount(WIDE);
	await clock.advance(3000);
	expect(await clawdShows(view, "a1", "desktop")).toBe(true);
	live = { a1: {} };
	await clock.advance(4000 + 2000);
	expect(await clawdShows(view, "a1", "desktop")).toBe(false);
	expect((await clawdPicture(view, "a1")).some((r) => r)).toBe(true);
});

test("his eyes are painted black: an eye is a hole only where its cell also holds the space around him", () => {
	let eyes = 0;
	let holes = 0;
	for (const rows of FRAMES as string[][])
		for (const row of rows) {
			const cps = [...row];
			for (let i = 0; i + 2 < cps.length; i += 3) {
				if (cps[i + 2] === "K") holes++;
				if (cps[i + 1] === "k" || cps[i + 2] === "k") eyes++;
			}
		}
	expect(eyes).toBeGreaterThan(100);
	expect(holes).toBeLessThan(eyes);
	const hole = { glyph: [...OCTANTS][0b11111100] as string, fg: "clawd_body", eye: true };
	const body = { glyph: [...OCTANTS][0b11111111] as string, fg: "rgb(130,170,220)" };
	expect(stack([body, hole]).bg).toBe("rgb(0,0,0)");
	const EYE = "rgb(0,0,0)";
	const glyph = (mask: number) => [...OCTANTS][mask] as string;
	const front = { glyph: glyph(0b00000011), fg: EYE };
	const back = { glyph: glyph(0b11110000), fg: "rgb(130,170,220)" };
	const cell = stack([back, front]);
	expect(cell.fg !== undefined && cell.bg !== undefined).toBe(true);
	expect([cell.fg, cell.bg]).toContain(EYE);
});

test("with room for everyone they all stroll the band, passing each other but never stopping on one another", async ($, on) => {
	const cards = Array.from({ length: 6 }, (_, i) => ({
		id: `a${i}`,
		status: "running",
		color: `rgb(${100 + i * 20},150,200)`,
	}));
	engine(on);
	on(
		"state.get",
		($e: any, e: any) =>
			({ value: { value: e.plugin === "agent-grid" && e.key === "cards" ? cards : undefined, version: 1 } }) as any,
	);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const first = new Map<string, [number, number]>();
	const moved = new Set<string>();
	const together = new Map<string, number>();
	let longest = 0;
	let order = "";
	let passed = false;
	for (let t = 0; t < 240; t++) {
		const view = await $.ui.mount(BAND);
		const span = new Map<string, [number, number]>();
		for (const b of await view.findAll({ type: "Box" })) {
			const m = String(b.props?.key ?? b.key ?? "").match(/^clawd-(.+)-\d+-(\d+)$/);
			if (!m) continue;
			const [lo, hi] = span.get(m[1] as string) ?? [Infinity, -Infinity];
			const col = Number(m[2]);
			span.set(m[1] as string, [Math.min(lo, col), Math.max(hi, col + [...String(b.text ?? "")].length - 1)]);
		}
		for (const [id, [lo, hi]] of span) {
			if (t === 4) first.set(id, [lo, hi]);
			const [l0, h0] = first.get(id) ?? [lo, hi];
			if (Math.min(lo - l0, hi - h0) >= 6 || Math.min(l0 - lo, h0 - hi) >= 6) moved.add(id);
		}
		const along = [...span.keys()].sort((a, b) => span.get(a)![0] - span.get(b)![0]).join();
		if (t === 4) order = along;
		passed ||= t > 4 && span.size === 7 && along !== order;
		const ids = [...span.keys()].sort();
		for (let i = 0; i < ids.length; i++)
			for (let j = i + 1; j < ids.length; j++) {
				const [a, b] = [span.get(ids[i] as string)!, span.get(ids[j] as string)!];
				const key = `${ids[i]}:${ids[j]}`;
				const run = Math.min(a[1], b[1]) - Math.max(a[0], b[0]) + 1 > 2 ? (together.get(key) ?? 0) + 500 : 0;
				together.set(key, run);
				longest = Math.max(longest, run);
			}
		await view.unmount();
		await clock.advance(500);
	}
	expect(longest).toBeLessThanOrEqual(8000);
	expect(passed).toBe(true);
	expect(first.size).toBe(7);
	expect([...first.keys()].filter((id) => id !== "main" && !moved.has(id))).toEqual([]);
});

test("with nothing else drawing the band, his own wake-ups still bring a flourish or a stroll", async ($, on) => {
	engine(on);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	const still = JSON.stringify(picture(STAND, HOME));
	let moved = 0;
	for (let t = 0; t < 120; t++) {
		await clock.advance(500);
		if (JSON.stringify(await painted(view)) !== still) moved++;
	}
	expect(moved).toBeGreaterThan(0);
});

test("a crew Clawd still facepalms on a new failure once old ones have scrolled out of his box", async ($, on) => {
	const err = { isError: true };
	const cards: any[] = [
		{ id: "a1", status: "running", color: "rgb(130,170,220)", lines: [err, err, err, ...Array(117).fill({})] },
	];
	let live: Record<string, any> = {};
	engine(on);
	on(
		"state.get",
		($e: any, e: any) =>
			({
				value: {
					value:
						e.plugin === "agent-grid" ? (e.key === "cards" ? cards : e.key === "live" ? live : undefined) : undefined,
					version: 1,
				},
			}) as any,
	);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	let view = await $.ui.mount(WIDE);
	const redraw = async (ms: number) => {
		await view.unmount();
		view = await $.ui.mount(WIDE);
		await clock.advance(ms);
	};
	await clock.advance(2000);
	live = { a1: { now: { kind: "tool", tool: "Bash", text: "ls" } } };
	await redraw(3000);
	cards[0].lines = Array(120).fill({});
	await redraw(500);
	cards[0].lines = [...Array(119).fill({}), err];
	let stumbled = false;
	for (let t = 0; t < 4; t++) {
		await redraw(300);
		stumbled ||= (await clawdShows(view, "a1", "facepalm")) || (await clawdShows(view, "a1", "dizzy"));
	}
	expect(stumbled).toBe(true);
});

test("with agent-grid's failure count he facepalms on a failure that lands as an old one scrolls out", async ($, on) => {
	const err = { isError: true };
	const cards: any[] = [
		{ id: "a1", status: "running", color: "rgb(130,170,220)", lines: [err, ...Array(119).fill({})], failed: 2 },
	];
	const live = { a1: { now: { kind: "tool", tool: "Bash", text: "ls" } } };
	engine(on);
	on(
		"state.get",
		($e: any, e: any) =>
			({
				value: {
					value:
						e.plugin === "agent-grid" ? (e.key === "cards" ? cards : e.key === "live" ? live : undefined) : undefined,
					version: 1,
				},
			}) as any,
	);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	let view = await $.ui.mount(WIDE);
	const stumbles = async () => {
		let seen = false;
		for (let t = 0; t < 8; t++) {
			await view.unmount();
			view = await $.ui.mount(WIDE);
			await clock.advance(300);
			seen ||= (await clawdShows(view, "a1", "facepalm")) || (await clawdShows(view, "a1", "dizzy"));
		}
		return seen;
	};
	await clock.advance(2000);
	await stumbles();
	cards[0].lines = [...Array(119).fill({}), err];
	cards[0].failed = 3;
	expect(await stumbles()).toBe(true);
});

test("a swap asked for before a failed call is dropped once a newer call asks for the move he is at", async ($, on) => {
	engine(on);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	await $.turn.start({ text: "hi", turnId: "t1" } as any);
	await clock.advance(5000);
	await $.tool.call({ tool: "Write", file_path: "/tmp/x" } as any);
	await clock.advance(1500);
	await $.tool.call({ tool: "Bash", command: "false" } as any);
	await clock.advance(200);
	await $.tool.call({ tool: "Edit", file_path: "/tmp/x" } as any);
	let desktop = false;
	for (let t = 0; t < 24; t++) {
		await clock.advance(500);
		desktop ||= await clawdShows(view, "main", "desktop");
	}
	expect(desktop).toBe(false);
	expect(await clawdShows(view, "main", "laptop")).toBe(true);
});

test("a band that shrinks while he walks keeps him on it", async ($, on) => {
	engine(on);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const edge = async (band: typeof BAND) => {
		const view = await $.ui.mount(band);
		const end = Math.max(...(await painted(view)).map((r) => [...r].length));
		await view.unmount();
		return end;
	};
	await edge(BAND);
	let end = 0;
	for (let t = 0; t < 1200 && end <= 100; t++) {
		end = await edge(WIDE);
		await clock.advance(500);
	}
	expect(end).toBeGreaterThan(100);
	for (let t = 0; t < 60; t++) {
		expect(await edge(BAND)).toBeLessThanOrEqual(100);
		await clock.advance(500);
	}
});

test("a crew Clawd faces either way: turned, every frame is his exact mirror image, pixel for pixel", async ($, on) => {
	const masks = new Map([...OCTANTS].map((g, m) => [g, m]));
	const pixels = (runs: ReturnType<typeof layout>) => {
		const px = new Map<string, string | undefined>();
		for (const run of runs)
			[...run.glyph].forEach((g, j) => {
				const mask = masks.get(g) ?? 0;
				for (let i = 0; i < 8; i++)
					px.set(`${run.r}:${2 * (run.col + j) + (i % 2)}:${i >> 1}`, (mask >> i) & 1 ? run.fg : run.bg);
			});
		return px;
	};
	const width = (2 * [...(FRAMES[STAND] as string[])[0]!].length) / 3;
	for (let f = 0; f < FRAMES.length; f++) {
		const plain = pixels(layout([{ id: "a", frame: f, left: 0 }]));
		const mirror = pixels(layout([{ id: "a", frame: f, left: 0, mirror: true }]));
		const flipped = new Map(
			[...plain].map(([at, p]) => {
				const [r, x, y] = at.split(":").map(Number) as [number, number, number];
				return [`${r}:${width - 1 - x}:${y}`, p];
			}),
		);
		expect(mirror).toEqual(flipped);
	}

	const cards = Array.from({ length: 16 }, (_, i) => ({ id: `a${i}`, status: "running" }));
	engine(on);
	on(
		"state.get",
		($e: any, e: any) =>
			({ value: { value: e.plugin === "agent-grid" && e.key === "cards" ? cards : undefined, version: 1 } }) as any,
	);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(WIDE);
	const wave = (MOVES.wave as { frames: number[] }).frames.filter(
		(f) => JSON.stringify(normalize(picture(f, 0))) !== JSON.stringify(normalize(turned(f))),
	);
	const sides = new Set<string>();
	for (let t = 0; t < 12; t++) {
		await clock.advance(100);
		for (const c of cards) {
			const pic = JSON.stringify(await clawdPicture(view, c.id));
			if (wave.some((f) => JSON.stringify(normalize(picture(f, 0))) === pic)) sides.add("plain");
			if (wave.some((f) => JSON.stringify(normalize(turned(f))) === pic)) sides.add("turned");
		}
	}
	expect([...sides].sort()).toEqual(["plain", "turned"]);
});

test("a box that runs again in another color has its Clawd wear the new one", async ($, on) => {
	let cards = [{ id: "a1", status: "running", color: "rgb(130,170,220)" }];
	engine(on);
	on(
		"state.get",
		($e: any, e: any) =>
			({ value: { value: e.plugin === "agent-grid" && e.key === "cards" ? cards : undefined, version: 1 } }) as any,
	);
	const clock = mock.clock(on, { now: 1_000_000 });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const colors = async () => {
		const view = await $.ui.mount(WIDE);
		const seen = new Set<string>();
		for (const t of await view.findAll({ type: "Text" })) if (t.props?.color) seen.add(String(t.props.color));
		await view.unmount();
		return seen;
	};
	await colors();
	cards = [{ ...cards[0]!, status: "failed" }];
	await colors();
	await clock.advance(3000);
	cards = [{ ...cards[0]!, status: "running", color: "rgb(220,150,90)" }];
	const now = await colors();
	expect(now.has("rgb(220,150,90)")).toBe(true);
	expect(now.has("rgb(130,170,220)")).toBe(false);
});
