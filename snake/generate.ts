/**
 * Growing contribution snake for K0DDO/k0ddo
 * Route order: Platane/snk eat order
 * Movement: growing snake with self-collision avoidance
 * Growth: start 4, +1 every 7 eats, max 24
 * Look: head→tail gradient + full-length taper + growth swell
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGithubUserContribution } from "@snk/github-user-contribution";
import { getBestRoute } from "@snk/solver/getBestRoute";
import { getPathToPose } from "@snk/solver/getPathToPose";
import {
  copyGrid,
  getColor,
  isEmpty,
  isInside,
  setColorEmpty,
} from "@snk/types/grid";
import { snake4 } from "@snk/types/__fixtures__/snake";
import { getHeadX, getHeadY, snakeToCells, type Snake } from "@snk/types/snake";
import { cellsToGrid } from "./cellsToGrid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "dist");

const START_LEN = 4;
const MAX_LEN = 24;
const EATS_PER_GROW = 7;
const HEAD = [0xf5, 0x98, 0x3c] as const;
const TAIL = [0xe5, 0x5a, 0xe7] as const;
const STEP_MS = 100;
const SIZE_CELL = 16;
const SIZE_DOT = 12;
const DOT_RADIUS = 2;
/** Head size (was SIZE_CELL * 0.9 ≈ 14.4) */
const SIZE_HEAD = SIZE_CELL * 0.9;
/** Tail tip ≈ old 4th segment (SIZE_DOT * 0.8 = 9.6), slightly smaller */
const SIZE_TAIL = SIZE_DOT * 0.72;

const PALETTES = {
  light: {
    colorDotBorder: "#1b1f230a",
    colorEmpty: "#ebedf0",
    colorDots: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
  },
  dark: {
    colorDotBorder: "#1b1f230a",
    colorEmpty: "#161b22",
    colorDots: ["#161b22", "#01311f", "#034525", "#0f6d31", "#00c647"],
  },
};

type Point = { x: number; y: number };
type Frame = {
  snake: Point[];
  length: number;
  grew: boolean;
  ate: string | null;
  level: number;
  eats: number;
};

const DIRS: Point[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const key = (x: number, y: number) => `${x},${y}`;
const parseKey = (k: string) => {
  const [x, y] = k.split(",").map(Number);
  return { x, y };
};
const lerp = (a: readonly number[], b: readonly number[], t: number) =>
  a.map((v, i) => Math.round(v + (b[i] - v) * t));
const toHex = (rgb: number[]) =>
  `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

function snakeColor(i: number, len: number) {
  if (len <= 1) return toHex([...HEAD]);
  return toHex(lerp(HEAD, TAIL, i / (len - 1)));
}

function lengthForEats(eats: number) {
  return Math.min(MAX_LEN, START_LEN + Math.floor(eats / EATS_PER_GROW));
}

function willGrowAfterEat(eats: number, len: number) {
  return (eats + 1) % EATS_PER_GROW === 0 && len < MAX_LEN;
}

function inBounds(x: number, y: number, width: number, height: number) {
  return x >= -1 && x <= width && y >= -2 && y <= height;
}

/** Body cells that block the next head move. Tail vacates unless growing. */
function blockedSet(snake: Point[], growing: boolean) {
  const s = new Set<string>();
  const end = growing ? snake.length : Math.max(0, snake.length - 1);
  for (let i = 0; i < end; i++) s.add(key(snake[i].x, snake[i].y));
  return s;
}

function hasSelfOverlap(snake: Point[]) {
  const s = new Set<string>();
  for (const p of snake) {
    const k = key(p.x, p.y);
    if (s.has(k)) return true;
    s.add(k);
  }
  return false;
}

function moveSnake(snake: Point[], next: Point, grow: boolean) {
  const nextSnake = [next, ...snake];
  if (!grow) nextSnake.pop();
  return nextSnake;
}

function bfs(
  snake: Point[],
  target: Point,
  width: number,
  height: number,
  growingOnArrive: boolean,
): Point[] | null {
  const start = snake[0];
  const startK = key(start.x, start.y);
  const goal = key(target.x, target.y);
  if (startK === goal) return [];

  // Conservative: treat body as blocked for the whole path search.
  // Tail is free only if we won't grow (typical case for long paths).
  const blocked = blockedSet(snake, growingOnArrive);
  const q: Point[] = [start];
  const prev = new Map<string, string | null>([[startK, null]]);

  while (q.length) {
    const cur = q.shift()!;
    for (const d of DIRS) {
      const nx = cur.x + d.x;
      const ny = cur.y + d.y;
      const nk = key(nx, ny);
      if (prev.has(nk)) continue;
      if (!inBounds(nx, ny, width, height)) continue;
      if (blocked.has(nk) && nk !== goal) continue;
      // never step onto current body except vacating tail / goal
      prev.set(nk, key(cur.x, cur.y));
      if (nk === goal) {
        const path: Point[] = [];
        let p: string | null = nk;
        while (p && p !== startK) {
          path.push(parseKey(p));
          p = prev.get(p) ?? null;
        }
        path.reverse();
        return path;
      }
      q.push({ x: nx, y: ny });
    }
  }
  return null;
}

function safeStep(snake: Point[], width: number, height: number) {
  const blocked = blockedSet(snake, false);
  const head = snake[0];
  for (const d of DIRS) {
    const nx = head.x + d.x;
    const ny = head.y + d.y;
    if (!inBounds(nx, ny, width, height)) continue;
    if (blocked.has(key(nx, ny))) continue;
    const trial = moveSnake(snake, { x: nx, y: ny }, false);
    if (!hasSelfOverlap(trial)) return { x: nx, y: ny };
  }
  return null;
}

/** Eat order from classic snk route (not the length-4 body itself). */
function extractFoodOrder(
  grid0: ReturnType<typeof cellsToGrid>,
  chain: Snake[],
): Point[] {
  const grid = copyGrid(grid0);
  const foods: Point[] = [];
  for (const s of chain) {
    const x = getHeadX(s);
    const y = getHeadY(s);
    if (!isInside(grid, x, y)) continue;
    const color = getColor(grid, x, y);
    if (isEmpty(color)) continue;
    foods.push({ x, y });
    setColorEmpty(grid, x, y);
  }
  return foods;
}

function buildFrames(grid0: ReturnType<typeof cellsToGrid>, chain: Snake[]) {
  const width = grid0.width;
  const height = grid0.height;
  const levels = new Map<string, number>();
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const c = getColor(grid0, x, y);
      if (!isEmpty(c)) levels.set(key(x, y), c as number);
    }
  }

  const foodOrder = extractFoodOrder(grid0, chain);
  const remaining = new Set(foodOrder.map((p) => key(p.x, p.y)));

  let snake = snakeToCells(chain[0]).map((p) => ({ ...p }));
  // ensure head-first (snakeToCells is head-first already)
  let eats = 0;
  const frames: Frame[] = [];

  const push = (grew: boolean, ate: string | null, level: number) => {
    if (hasSelfOverlap(snake)) {
      throw new Error(`self-overlap at eats=${eats} len=${snake.length}`);
    }
    frames.push({
      snake: snake.map((p) => ({ ...p })),
      length: snake.length,
      grew,
      ate,
      level,
      eats,
    });
  };

  push(false, null, 0);

  for (const food of foodOrder) {
    const fk = key(food.x, food.y);
    if (!remaining.has(fk)) continue;

    let guard = 0;
    while (key(snake[0].x, snake[0].y) !== fk && guard++ < 4000) {
      const growOnFood = willGrowAfterEat(eats, snake.length);
      let path = bfs(snake, food, width, height, growOnFood);
      if (!path || path.length === 0) {
        const step = safeStep(snake, width, height);
        if (!step) {
          console.warn(`stuck going to ${fk}, skipping`);
          remaining.delete(fk);
          break;
        }
        path = [step];
      }

      const next = path[0];
      const landing = key(next.x, next.y);
      const isFood = remaining.has(landing);
      let grow = false;
      let ate: string | null = null;
      let level = 0;

      if (isFood) {
        remaining.delete(landing);
        ate = landing;
        level = levels.get(landing) ?? 1;
        eats += 1;
        grow = snake.length < lengthForEats(eats);
      }

      const nextSnake = moveSnake(snake, next, grow);
      if (hasSelfOverlap(nextSnake)) {
        // refuse illegal step — try a safe wander instead
        const step = safeStep(snake, width, height);
        if (!step) {
          console.warn(`collision deadlock at ${landing}`);
          break;
        }
        snake = moveSnake(snake, step, false);
        push(false, null, 0);
        continue;
      }

      snake = nextSnake;
      push(grow, ate, level);

      if (isFood) break; // retarget next food in snk order
    }
  }

  // park above grid like snk
  const park = { x: Math.min(3, Math.max(0, width - 1)), y: -1 };
  for (let i = 0; i < 80; i++) {
    if (snake[0].x === park.x && snake[0].y === park.y) break;
    let path = bfs(snake, park, width, height, false);
    if (!path?.length) {
      const step = safeStep(snake, width, height);
      if (!step) break;
      path = [step];
    }
    const nextSnake = moveSnake(snake, path[0], false);
    if (hasSelfOverlap(nextSnake)) break;
    snake = nextSnake;
    push(false, null, 0);
  }

  if (remaining.size) {
    console.warn(`leftover food: ${remaining.size}`);
  }

  return frames;
}

/** Smooth taper head → tip across the whole body. */
function sizeFor(i: number, len: number) {
  if (len <= 1) return SIZE_HEAD;
  const t = i / (len - 1); // 0 head .. 1 tip
  // slight ease so mid-body doesn't collapse too fast
  const u = (1 - t) ** 1.15;
  return SIZE_TAIL + (SIZE_HEAD - SIZE_TAIL) * u;
}

function minifyCss(css: string) {
  return css
    .replace(/\s+/g, " ")
    .replace(/\s*([{};:,])\s*/g, "$1")
    .trim();
}

function esc(v: string | number) {
  return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function h(
  tag: string,
  attrs: Record<string, string | number | undefined>,
  open = false,
) {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${esc(v!)}"`)
    .join(" ");
  return open ? `<${tag} ${a}>` : `<${tag} ${a}/>`;
}

function buildSvg(
  cells: { x: number; y: number; level: number }[],
  grid: ReturnType<typeof cellsToGrid>,
  frames: Frame[],
  palette: (typeof PALETTES)["light"],
) {
  const n = Math.max(frames.length - 1, 1);
  const duration = Math.max(frames.length * STEP_MS, 1000);
  const width = grid.width;
  const height = grid.height;
  const svgW = (width + 2) * SIZE_CELL;
  const svgH = (height + 5) * SIZE_CELL;
  const viewBox = [-SIZE_CELL, -SIZE_CELL * 2, svgW, svgH].join(" ");
  const maxLen = Math.max(...frames.map((f) => f.length), START_LEN);

  const eatAt = new Map<string, number>();
  frames.forEach((f, i) => {
    if (f.ate) eatAt.set(f.ate, i / n);
  });

  const styles: string[] = [];
  const elements: string[] = [];

  styles.push(`:root{
    --cb:${palette.colorDotBorder};
    --ce:${palette.colorEmpty};
    ${palette.colorDots.map((c, i) => `--c${i}:${c};`).join("")}
  }`);

  styles.push(`.c{
    shape-rendering:geometricPrecision;
    fill:var(--ce);
    stroke-width:1px;
    stroke:var(--cb);
    animation:none ${duration}ms linear infinite;
  }`);

  const mDot = (SIZE_CELL - SIZE_DOT) / 2;
  let ci = 0;
  for (const cell of cells) {
    const k = key(cell.x, cell.y);
    const level = cell.level;
    const t = eatAt.get(k);
    const id = t != null ? `c${(ci++).toString(36)}` : null;

    if (id && t != null) {
      const t0 = Math.max(0, t - 0.0008);
      styles.push(
        `@keyframes ${id}{${(t0 * 100).toFixed(3)}%{fill:var(--c${level})} ${(t * 100).toFixed(3)}%,100%{fill:var(--ce)}}`,
        `.c.${id}{fill:var(--c${level});animation-name:${id}}`,
      );
    } else if (level > 0) {
      styles.push(`.c.keep-${cell.x}-${cell.y}{fill:var(--c${level})}`);
    }

    elements.push(
      h("rect", {
        class: ["c", id, level > 0 && t == null ? `keep-${cell.x}-${cell.y}` : ""]
          .filter(Boolean)
          .join(" "),
        x: cell.x * SIZE_CELL + mDot,
        y: cell.y * SIZE_CELL + mDot,
        width: SIZE_DOT,
        height: SIZE_DOT,
        rx: DOT_RADIUS,
        ry: DOT_RADIUS,
      }),
    );
  }

  const stack: { t: number; level: number }[] = [];
  frames.forEach((f, i) => {
    if (f.ate) stack.push({ t: i / n, level: f.level });
  });
  const stackY = (height + 2) * SIZE_CELL;
  styles.push(`.u{
    shape-rendering:geometricPrecision;
    fill:var(--ce);
    animation:none ${duration}ms linear infinite;
  }`);
  stack.forEach((s, i) => {
    const id = `u${i.toString(36)}`;
    styles.push(
      `@keyframes ${id}{0%,${(s.t * 100).toFixed(3)}%{fill:var(--ce)} ${((s.t + 0.0008) * 100).toFixed(3)}%,100%{fill:var(--c${s.level})}}`,
      `.u.${id}{animation-name:${id}}`,
    );
    elements.push(
      h("rect", {
        class: `u ${id}`,
        x: i * (SIZE_DOT + 1),
        y: stackY,
        width: SIZE_DOT,
        height: SIZE_DOT,
        rx: DOT_RADIUS,
        ry: DOT_RADIUS,
      }),
    );
  });

  const segCount = Math.min(MAX_LEN, maxLen);
  styles.push(`.s{
    shape-rendering:geometricPrecision;
    animation:none linear ${duration}ms infinite;
  }`);

  for (let i = 0; i < segCount; i++) {
    const id = `s${i}`;
    const baseSize = sizeFor(i, segCount);
    const parts: string[] = [];

    frames.forEach((f, fi) => {
      const t = fi / n;
      const alive = i < f.length;
      const p = alive ? f.snake[i] : f.snake[f.snake.length - 1];
      const color = snakeColor(i, Math.max(f.length, 2));
      const grewNow = Boolean(f.grew && i === f.length - 1);
      const targetSize = alive ? sizeFor(i, f.length) : baseSize;
      const sizeScale = targetSize / baseSize;
      const scale = !alive ? 0 : grewNow ? 0.2 * sizeScale : sizeScale;
      const opacity = alive ? 1 : 0;
      // center the variable-sized rect inside the cell
      const margin = (SIZE_CELL - baseSize) / 2;
      parts.push(
        `${(t * 100).toFixed(3)}%{transform:translate(${p.x * SIZE_CELL + margin}px,${p.y * SIZE_CELL + margin}px) scale(${scale});opacity:${opacity};fill:${color}}`,
      );

      if (grewNow) {
        const t2 = Math.min(1, (fi + 0.4) / n);
        parts.push(
          `${(t2 * 100).toFixed(3)}%{transform:translate(${p.x * SIZE_CELL + margin}px,${p.y * SIZE_CELL + margin}px) scale(${(1.2 * sizeScale).toFixed(3)});opacity:1;fill:${color}}`,
        );
        const t3 = Math.min(1, (fi + 0.8) / n);
        parts.push(
          `${(t3 * 100).toFixed(3)}%{transform:translate(${p.x * SIZE_CELL + margin}px,${p.y * SIZE_CELL + margin}px) scale(${sizeScale});opacity:1;fill:${color}}`,
        );
      }
    });

    styles.push(`@keyframes ${id}{${parts.join("")}}`);
    styles.push(`.s.${id}{
      fill:${snakeColor(i, Math.max(segCount, 2))};
      animation-name:${id};
      opacity:0;
    }`);

    const r = Math.min(4.5, (4 * baseSize) / SIZE_DOT);
    elements.push(
      h("rect", {
        class: `s ${id}`,
        x: 0,
        y: 0,
        width: baseSize.toFixed(1),
        height: baseSize.toFixed(1),
        rx: r.toFixed(1),
        ry: r.toFixed(1),
      }),
    );
  }

  const css = minifyCss(styles.join("\n"));
  return [
    h(
      "svg",
      {
        viewBox,
        width: svgW,
        height: svgH,
        xmlns: "http://www.w3.org/2000/svg",
      },
      true,
    ),
    "<desc>Generated with k0ddo growing snake (no self-collision)</desc>",
    `<style>${css}</style>`,
    ...elements,
    "</svg>",
  ].join("");
}

async function main() {
  const username = process.env.GITHUB_USER || process.env.GITHUB_ACTOR;
  const token = process.env.GITHUB_TOKEN;
  if (!username) throw new Error("GITHUB_USER is required");
  if (!token) throw new Error("GITHUB_TOKEN is required");

  console.log(`fetching contributions for ${username}`);
  const cells = await getGithubUserContribution(username, {
    githubToken: token,
  });
  const filled = cells.filter((c) => c.level > 0).length;
  console.log(`cells: ${cells.length}, filled: ${filled}`);

  const grid = cellsToGrid(cells);
  console.log("computing snk food order");
  const chain = getBestRoute(grid, snake4)!;
  chain.push(...getPathToPose(chain.slice(-1)[0], snake4)!);
  console.log(`snk steps: ${chain.length}`);

  console.log("simulating growing snake with self-collision checks");
  const frames = buildFrames(grid, chain);
  const maxLen = Math.max(...frames.map((f) => f.length));
  const eats = frames.at(-1)?.eats ?? 0;
  console.log(`frames: ${frames.length}, max length: ${maxLen}, eats: ${eats}`);

  await mkdir(OUT_DIR, { recursive: true });
  const lightPath = path.join(OUT_DIR, "snake-v5.svg");
  const darkPath = path.join(OUT_DIR, "snake-v5-dark.svg");
  await writeFile(lightPath, buildSvg(cells, grid, frames, PALETTES.light), "utf8");
  await writeFile(darkPath, buildSvg(cells, grid, frames, PALETTES.dark), "utf8");
  console.log(`wrote ${lightPath}`);
  console.log(`wrote ${darkPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
