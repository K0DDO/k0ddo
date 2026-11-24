/**
 * Custom contribution-snake generator for K0DDO/k0ddo
 * - start length 4, +1 every 7 eats, max 24
 * - head→tail gradient #f5983c → #e55ae7
 * - effects: head pulse, trail, growth swell
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist");

const START_LEN = 4;
const MAX_LEN = 24;
const EATS_PER_GROW = 7;
const HEAD = [0xf5, 0x98, 0x3c];
const TAIL = [0xe5, 0x5a, 0xe7];
const STEP_MS = 85;
const SIZE_CELL = 16;
const SIZE_DOT = 12;
const DOT_RADIUS = 2;
const TRAIL_GHOSTS = 3;

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

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const key = (x, y) => `${x},${y}`;
const parseKey = (k) => k.split(",").map(Number);

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const toHex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

function snakeColor(i, len) {
  if (len <= 1) return toHex(HEAD);
  return toHex(lerp(HEAD, TAIL, i / (len - 1)));
}

async function fetchContributions(username, token) {
  const query = `
    query ($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks {
              contributionDays {
                contributionCount
                contributionLevel
                weekday
                date
              }
            }
          }
        }
      }
    }`;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "k0ddo-snake",
    },
    body: JSON.stringify({ query, variables: { login: username } }),
  });

  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.[0]) throw new Error(json.errors[0].message);

  return json.data.user.contributionsCollection.contributionCalendar.weeks.flatMap(
    ({ contributionDays }, x) =>
      contributionDays.map((d) => ({
        x,
        y: d.weekday,
        date: d.date,
        count: d.contributionCount,
        level:
          ({
            FOURTH_QUARTILE: 4,
            THIRD_QUARTILE: 3,
            SECOND_QUARTILE: 2,
            FIRST_QUARTILE: 1,
            NONE: 0,
          })[d.contributionLevel] ?? 0,
      })),
  );
}

function gridBounds(cells) {
  return {
    width: Math.max(0, ...cells.map((c) => c.x)) + 1,
    height: Math.max(0, ...cells.map((c) => c.y)) + 1,
  };
}

function inBounds(x, y, width, height) {
  return x >= -1 && x <= width && y >= -2 && y <= height;
}

function bodySet(snake, ignoreTail = true) {
  const s = new Set();
  const end = ignoreTail ? snake.length - 1 : snake.length;
  for (let i = 0; i < end; i++) s.add(key(snake[i].x, snake[i].y));
  return s;
}

function bfs(snake, target, width, height) {
  const start = snake[0];
  const blocked = bodySet(snake, true);
  const goal = key(target.x, target.y);
  const startK = key(start.x, start.y);
  if (startK === goal) return [];

  const q = [start];
  const prev = new Map([[startK, null]]);

  while (q.length) {
    const cur = q.shift();
    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nk = key(nx, ny);
      if (prev.has(nk)) continue;
      if (!inBounds(nx, ny, width, height)) continue;
      if (blocked.has(nk) && nk !== goal) continue;
      prev.set(nk, key(cur.x, cur.y));
      if (nk === goal) {
        const path = [];
        let p = nk;
        while (p && p !== startK) {
          const [x, y] = parseKey(p);
          path.push({ x, y });
          p = prev.get(p);
        }
        path.reverse();
        return path;
      }
      q.push({ x: nx, y: ny });
    }
  }
  return null;
}

function safeStep(snake, width, height) {
  const blocked = bodySet(snake, true);
  const head = snake[0];
  // prefer continuing roughly rightward / toward grid
  const ordered = [
    [1, 0],
    [0, 1],
    [0, -1],
    [-1, 0],
  ];
  for (const [dx, dy] of ordered) {
    const nx = head.x + dx;
    const ny = head.y + dy;
    if (!inBounds(nx, ny, width, height)) continue;
    if (blocked.has(key(nx, ny))) continue;
    return { x: nx, y: ny };
  }
  return null;
}

function moveSnake(snake, next, grow) {
  const nextSnake = [next, ...snake];
  if (!grow) nextSnake.pop();
  return nextSnake;
}

function nearestFood(head, food) {
  let best = null;
  let bestScore = Infinity;
  for (const f of food) {
    const [x, y] = parseKey(f);
    const d = Math.abs(x - head.x) + Math.abs(y - head.y);
    const score = d * 1000 + x * 10 + y;
    if (score < bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best;
}

function simulate(cells) {
  const { width, height } = gridBounds(cells);
  const levels = new Map(cells.map((c) => [key(c.x, c.y), c.level]));
  const food = new Set(
    cells.filter((c) => c.level > 0).map((c) => key(c.x, c.y)),
  );

  let snake = Array.from({ length: START_LEN }, (_, i) => ({
    x: START_LEN - 1 - i,
    y: -1,
  }));
  let eats = 0;
  const frames = [];
  const vacated = [];

  const pushFrame = (grew, ateKey, trail) => {
    frames.push({
      snake: snake.map((p) => ({ ...p })),
      length: snake.length,
      grew,
      ate: ateKey,
      level: ateKey ? levels.get(ateKey) : 0,
      eats,
      trail: trail.map((p) => ({ ...p })),
    });
  };

  pushFrame(false, null, []);

  let guard = 0;
  const guardMax = Math.max(8000, food.size * 120);
  let stuck = 0;

  while (food.size > 0 && guard++ < guardMax) {
    const target = nearestFood(snake[0], food);
    let path = bfs(snake, target, width, height);

    if (!path || path.length === 0) {
      const step = safeStep(snake, width, height);
      if (!step) {
        stuck += 1;
        if (stuck > 50) break;
        // desperate: ignore body except head collision with self mid
        const head = snake[0];
        path = [{ x: head.x + 1, y: head.y }];
        if (!inBounds(path[0].x, path[0].y, width, height)) {
          path = [{ x: head.x, y: head.y - 1 }];
        }
      } else {
        path = [step];
        stuck = 0;
      }
    } else {
      stuck = 0;
    }

    const next = path[0];
    const landing = key(next.x, next.y);
    const isFood = food.has(landing);
    let grow = false;

    if (isFood) {
      food.delete(landing);
      eats += 1;
      if (eats % EATS_PER_GROW === 0 && snake.length < MAX_LEN) grow = true;
    }

    const oldTail = snake[snake.length - 1];
    snake = moveSnake(snake, next, grow);

    if (!grow) {
      vacated.push({ ...oldTail });
      if (vacated.length > TRAIL_GHOSTS) vacated.shift();
    } else {
      vacated.length = 0;
    }

    pushFrame(grow, isFood ? landing : null, [...vacated].reverse());
  }

  if (food.size > 0) {
    console.warn(`warning: ${food.size} cells left uneaten (path stuck)`);
  }

  const park = { x: Math.min(3, Math.max(0, width - 1)), y: -1 };
  for (let i = 0; i < 60; i++) {
    if (snake[0].x === park.x && snake[0].y === park.y) break;
    let path = bfs(snake, park, width, height);
    if (!path?.length) {
      const step = safeStep(snake, width, height);
      if (!step) break;
      path = [step];
    }
    const oldTail = snake[snake.length - 1];
    snake = moveSnake(snake, path[0], false);
    vacated.push({ ...oldTail });
    if (vacated.length > TRAIL_GHOSTS) vacated.shift();
    pushFrame(false, null, [...vacated].reverse());
  }

  return {
    frames,
    width,
    height,
    cells,
    maxLen: Math.max(...frames.map((f) => f.length)),
    leftover: food.size,
  };
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};:,])\s*/g, "$1")
    .trim();
}

function esc(v) {
  return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function h(tag, attrs, open = false) {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(" ");
  return open ? `<${tag} ${a}>` : `<${tag} ${a}/>`;
}

function sizeFor(i, len) {
  const dMin = SIZE_DOT * 0.8;
  const dMax = SIZE_CELL * 0.9;
  const iMax = Math.min(4, Math.max(len - 1, 1));
  const u = (1 - Math.min(i, iMax) / iMax) ** 2;
  return dMin + (dMax - dMin) * u;
}

function buildSvg({ frames, width, height, cells, maxLen }, palette) {
  const n = Math.max(frames.length - 1, 1);
  const duration = Math.max(frames.length * STEP_MS, 1000);
  const svgW = (width + 2) * SIZE_CELL;
  const svgH = (height + 5) * SIZE_CELL;
  const viewBox = [-SIZE_CELL, -SIZE_CELL * 2, svgW, svgH].join(" ");

  const eatAt = new Map();
  frames.forEach((f, i) => {
    if (f.ate) eatAt.set(f.ate, i / n);
  });

  const styles = [];
  const elements = [];

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

  // eaten stack
  const stack = [];
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

  const segCount = Math.min(MAX_LEN, Math.max(maxLen, START_LEN));

  styles.push(`.s{
    shape-rendering:geometricPrecision;
    animation:none linear ${duration}ms infinite;
  }`);
  styles.push(`@keyframes headPulse{
    0%,100%{filter:drop-shadow(0 0 0 rgba(245,152,60,0))}
    50%{filter:drop-shadow(0 0 5px rgba(245,152,60,.85))}
  }`);

  for (let i = 0; i < segCount; i++) {
    const id = `s${i}`;
    const parts = [];

    frames.forEach((f, fi) => {
      const t = fi / n;
      const alive = i < f.length;
      const p = alive ? f.snake[i] : f.snake[f.snake.length - 1];
      const s = sizeFor(Math.min(i, Math.max(f.length - 1, 0)), f.length);
      const color = snakeColor(i, Math.max(f.length, 2));
      const grewNow = Boolean(f.grew && i === f.length - 1);
      const scale = !alive ? 0 : grewNow ? 0.2 : 1;
      const opacity = alive ? 1 : 0;
      const transform = `transform:translate(${p.x * SIZE_CELL}px,${p.y * SIZE_CELL}px) scale(${scale})`;

      parts.push(
        `${(t * 100).toFixed(3)}%{${transform};opacity:${opacity};fill:${color}}`,
      );

      // growth swell overshoot
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

    if (i === 0) {
      styles.push(`.s.${id}{
        fill:${snakeColor(0, 2)};
        animation-name:${id},headPulse;
        animation-duration:${duration}ms,700ms;
        animation-timing-function:linear,ease-in-out;
        animation-iteration-count:infinite,infinite;
        opacity:0;
      }`);
    } else {
      styles.push(`.s.${id}{
        fill:${snakeColor(i, Math.max(segCount, 2))};
        animation-name:${id};
        opacity:0;
      }`);
    }

    // draw rect centered in cell via margin baked into size; use fixed max size box
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

  // trail ghosts
  for (let g = 0; g < TRAIL_GHOSTS; g++) {
    const id = `tr${g}`;
    const parts = frames.map((f, fi) => {
      const t = fi / n;
      const p = f.trail[g];
      if (!p) {
        return `${(t * 100).toFixed(3)}%{opacity:0;transform:translate(0px,0px) scale(0)}`;
      }
      const op = (0.36 - g * 0.1).toFixed(2);
      return `${(t * 100).toFixed(3)}%{opacity:${op};fill:${toHex(TAIL)};transform:translate(${p.x * SIZE_CELL}px,${p.y * SIZE_CELL}px) scale(${(0.85 - g * 0.12).toFixed(2)})}`;
    });
    styles.push(`@keyframes ${id}{${parts.join("")}}`);
    styles.push(`.tr.${id}{
      shape-rendering:geometricPrecision;
      fill:${toHex(TAIL)};
      opacity:0;
      animation-name:${id};
      animation-duration:${duration}ms;
      animation-timing-function:linear;
      animation-iteration-count:infinite;
    }`);
    const s = SIZE_DOT * 0.7;
    const margin = (SIZE_CELL - s) / 2;
    elements.push(
      h("rect", {
        class: `tr ${id}`,
        x: margin.toFixed(1),
        y: margin.toFixed(1),
        width: s.toFixed(1),
        height: s.toFixed(1),
        rx: 2,
        ry: 2,
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
    "<desc>Generated with k0ddo custom growing snake</desc>",
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
  const cells = await fetchContributions(username, token);
  const filled = cells.filter((c) => c.level > 0).length;
  console.log(`cells: ${cells.length}, filled: ${filled}`);

  console.log("simulating growing snake");
  const sim = simulate(cells);
  console.log(
    `frames: ${sim.frames.length}, max length: ${sim.maxLen}, eats: ${sim.frames.at(-1)?.eats ?? 0}, leftover: ${sim.leftover}`,
  );

  await mkdir(OUT_DIR, { recursive: true });
  const lightPath = path.join(OUT_DIR, "github-contribution-grid-snake.svg");
  const darkPath = path.join(OUT_DIR, "github-contribution-grid-snake-dark.svg");
  await writeFile(lightPath, buildSvg(sim, PALETTES.light), "utf8");
  await writeFile(darkPath, buildSvg(sim, PALETTES.dark), "utf8");
  console.log(`wrote ${lightPath}`);
  console.log(`wrote ${darkPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
