// robots.txt: decides whether our bot may fetch a URL. Used by the career-site adapters and probes,
// so a site that asks automated readers to stay out is left alone.
//
// Follows RFC 9309: the most specific user-agent group that names us, else "*"; the longest
// matching rule wins, and Allow wins a tie; "*" and "$" wildcards. A missing robots.txt (4xx)
// allows everything; one that can't be read (5xx, network error) allows nothing.

export const BOT_NAME = "MyCareerAgentBot";

interface Rule { allow: boolean; pattern: string }

export function parseRobots(text: string, agent = BOT_NAME): Rule[] {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
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
    } else {
      lastWasAgent = false;
    }
  }
  const me = agent.toLowerCase();
  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && me.includes(a)));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
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

const cache = new Map<string, Promise<Rule[] | "deny-all">>();

/** Whether our bot may fetch this URL, by the host's robots.txt (cached per host for the run). */
export async function robotsAllows(url: string, f: typeof fetch = fetch): Promise<boolean> {
  const u = new URL(url);
  const key = u.origin;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      try {
        const r = await f(`${u.origin}/robots.txt`, { headers: { "user-agent": `${BOT_NAME}/0.1 (+https://github.com/ayushjainid/my-career-agent)` }, redirect: "follow" });
        if (r.status >= 400 && r.status < 500) return [];
        if (!r.ok) return "deny-all";
        return parseRobots(await r.text());
      } catch { return "deny-all"; }
    })());
  }
  const rules = await cache.get(key)!;
  return rules === "deny-all" ? false : allowedBy(rules, u.pathname + u.search);
}
