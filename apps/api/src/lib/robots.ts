// robots.txt: decides whether our bot may fetch a URL. Used by the career-site adapters and probes,
// so a site that asks automated readers to stay out is left alone.
//
// Follows RFC 9309: the most specific user-agent group that names us, else "*"; the longest
// matching rule wins, and Allow wins a tie; "*" and "$" wildcards. A missing robots.txt (4xx)
// allows everything; one that can't be read (5xx, network error) allows nothing.

export const BOT_NAME = "MyCareerAgentBot";

interface Rule { allow: boolean; pattern: string }
interface Parsed { rules: Rule[]; delayMs: number }

export function parseRobots(text: string, agent = BOT_NAME): Rule[] {
  return parseRobotsFull(text, agent).rules;
}

export function parseRobotsFull(text: string, agent = BOT_NAME): Parsed {
  const groups: Array<{ agents: string[]; rules: Rule[]; delay?: number }> = [];
  let cur: { agents: string[]; rules: Rule[]; delay?: number } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase(), value = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (key === "disallow" && value === "") continue; // "Disallow:" with nothing allows all
      cur.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay" && cur) {
      lastWasAgent = false;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) cur.delay = Math.min(n, 30);
    } else {
      lastWasAgent = false;
    }
  }
  const me = agent.toLowerCase();
  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && me.includes(a)));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  const delay = Math.max(0, ...chosen.map((g) => g.delay ?? 0));
  return { rules: chosen.flatMap((g) => g.rules), delayMs: delay * 1000 };
}

function matches(pattern: string, path: string): number {
  // Returns the pattern's length if it matches, or -1.
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path) ? pattern.length : -1;
}

export function allowedBy(rules: Rule[], pathAndQuery: string): boolean {
  let best: Rule | null = null, bestLen = -1;
  for (const r of rules) {
    const n = matches(r.pattern, pathAndQuery);
    if (n > bestLen || (n === bestLen && n >= 0 && r.allow)) { best = r; bestLen = n; }
  }
  return best ? best.allow : true;
}

const cache = new Map<string, Promise<Parsed | "deny-all">>();
const lastHit = new Map<string, number>();

/** Whether our bot may fetch this URL, by the host's robots.txt (cached per host for the run). */
export async function robotsAllows(url: string, f: typeof fetch = fetch): Promise<boolean> {
  const u = new URL(url);
  const key = u.origin;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      try {
        const r = await f(`${u.origin}/robots.txt`, { headers: { "user-agent": `${BOT_NAME}/0.1 (+https://github.com/ayushjainid/my-career-agent)` }, redirect: "follow" });
        if (!r.ok) await r.body?.cancel().catch(() => {});
        if (r.status >= 400 && r.status < 500) return { rules: [], delayMs: 0 };
        if (!r.ok) return "deny-all";
        return parseRobotsFull(await r.text());
      } catch { return "deny-all"; }
    })());
  }
  const p = await cache.get(key)!;
  return p === "deny-all" ? false : allowedBy(p.rules, u.pathname + u.search);
}

/** Waits out the host's Crawl-delay since our last request to it. */
const queue = new Map<string, Promise<void>>();
async function honourDelay(url: string): Promise<void> {
  const origin = new URL(url).origin;
  const p = await cache.get(origin);
  const delay = p && p !== "deny-all" ? p.delayMs : 0;
  if (!delay) return;
  // One request at a time per host that asks for a delay, each `delay` after the last.
  const turn = (queue.get(origin) ?? Promise.resolve()).then(async () => {
    const wait = (lastHit.get(origin) ?? 0) + delay - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit.set(origin, Date.now());
  });
  queue.set(origin, turn);
  await turn;
}

export class RobotsDisallowedError extends Error {}

/** A fetch that refuses URLs the site's robots.txt closes to our bot. */
export function politeFetch(base: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof process !== "undefined" && process.env?.MCA_SKIP_ROBOTS === "1") return base(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!(await robotsAllows(url, base))) throw new RobotsDisallowedError(`${new URL(url).host}: robots.txt asks bots not to fetch ${new URL(url).pathname}`);
    await honourDelay(url);
    return base(input, init);
  }) as typeof fetch;
}

/** Gap between requests to one site; MCA_PACE_MS overrides it (tests set 0). */
export function paceMs(fallback: number): number {
  const v = typeof process !== "undefined" ? process.env?.MCA_PACE_MS : undefined;
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback;
}
