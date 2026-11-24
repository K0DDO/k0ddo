/**
 * Growing contribution snake for K0DDO/k0ddo
 * Route: Platane/snk solver (same as classic snake)
 * Growth: start 4, +1 every 7 eats, max 24
 * Look: head→tail gradient, growth swell (no trail / no head pulse)
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
  type Color,
  type Empty,
} from "@snk/types/grid";
import { snake4 } from "@snk/types/__fixtures__/snake";
import {
  getHeadX,
  getHeadY,
  snakeToCells,
  type Snake,
} from "@snk/types/snake";
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

const key = (x: number, y: number) => `${x},${y}`;
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

function buildFrames(grid0: ReturnType<typeof cellsToGrid>, chain: Snake[]) {
  const grid = copyGrid(grid0);
  const heads = chain.map((s) => ({ x: getHeadX(s), y: getHeadY(s) }));
  const initial = snakeToCells(chain[0]);
  const frames: Frame[] = [];
  let eats = 0;
  let prevLen = START_LEN;

  for (let i = 0; i < chain.length; i++) {
    const head = heads[i];
    let ate: string | null = null;
    let level = 0;

    if (isInside(grid, head.x, head.y)) {
      const color = getColor(grid, head.x, head.y);
      if (!isEmpty(color)) {
        ate = key(head.x, head.y);
        level = color as number;
        setColorEmpty(grid, head.x, head.y);
        eats += 1;
      }
    }

    const len = lengthForEats(eats);
    const grew = len > prevLen;
    prevLen = len;

    const snake: Point[] = [];
    for (let k = 0; k < len; k++) {
      const idx = i - k;
      if (idx >= 0) snake.push({ ...heads[idx] });
      else snake.push({ ...(initial[Math.min(-idx, initial.length - 1)] ?? initial[0]) });
    }

    frames.push({ snake, length: len, grew, ate, level, eats });
  }

  return frames;
}

function sizeFor(i: number, len: number) {
  const dMin = SIZE_DOT * 0.8;
  const dMax = SIZE_CELL * 0.9;
  const iMax = Math.min(4, Math.max(len - 1, 1));
  const u = (1 - Math.min(i, iMax) / iMax) ** 2;
  return dMin + (dMax - dMin) * u;
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
    const parts: string[] = [];

    frames.forEach((f, fi) => {
      const t = fi / n;
      const alive = i < f.length;
      const p = alive ? f.snake[i] : f.snake[f.snake.length - 1];
      const color = snakeColor(i, Math.max(f.length, 2));
      const grewNow = Boolean(f.grew && i === f.length - 1);
      const scale = !alive ? 0 : grewNow ? 0.2 : 1;
      const opacity = alive ? 1 : 0;
      parts.push(
        `${(t * 100).toFixed(3)}%{transform:translate(${p.x * SIZE_CELL}px,${p.y * SIZE_CELL}px) scale(${scale});opacity:${opacity};fill:${color}}`,
      );

      if (grewNow) {
        const t2 = Math.min(1, (fi + 0.4) / n);
        parts.push(
          `${(t2 * 100).toFixed(3)}%{transform:translate(${p.x * SIZE_CELL}px,${p.y * SIZE_CELL}px) scale(1.2);opacity:1;fill:${color}}`,
        );
        const t3 = Math.min(1, (fi + 0.8) / n);
        parts.push(
          `${(t3 * 100).toFixed(3)}%{transform:translate(${p.x * SIZE_CELL}px,${p.y * SIZE_CELL}px) scale(1);opacity:1;fill:${color}}`,
        );
      }
    });

    styles.push(`@keyframes ${id}{${parts.join("")}}`);
    styles.push(`.s.${id}{
      fill:${snakeColor(i, Math.max(segCount, 2))};
      animation-name:${id};
      opacity:0;
    }`);

    const s = sizeFor(i, segCount);
    const margin = (SIZE_CELL - s) / 2;
    const r = Math.min(4.5, (4 * s) / SIZE_DOT);
    elements.push(
      h("rect", {
        class: `s ${id}`,
        x: margin.toFixed(1),
        y: margin.toFixed(1),
        width: s.toFixed(1),
        height: s.toFixed(1),
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
    "<desc>Generated with k0ddo growing snake (snk route)</desc>",
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
  console.log("computing snk route");
  const snake = snake4;
  const chain = getBestRoute(grid, snake)!;
  chain.push(...getPathToPose(chain.slice(-1)[0], snake)!);
  console.log(`route steps: ${chain.length}`);

  const frames = buildFrames(grid, chain);
  const maxLen = Math.max(...frames.map((f) => f.length));
  const eats = frames.at(-1)?.eats ?? 0;
  console.log(`frames: ${frames.length}, max length: ${maxLen}, eats: ${eats}`);

  await mkdir(OUT_DIR, { recursive: true });
  const lightPath = path.join(OUT_DIR, "snake.svg");
  const darkPath = path.join(OUT_DIR, "snake-dark.svg");
  await writeFile(lightPath, buildSvg(cells, grid, frames, PALETTES.light), "utf8");
  await writeFile(darkPath, buildSvg(cells, grid, frames, PALETTES.dark), "utf8");
  console.log(`wrote ${lightPath}`);
  console.log(`wrote ${darkPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
