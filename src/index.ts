interface Env {
  ASSETS: Fetcher;
  GITHUB_TOKEN: string;
}

interface DayContribution {
  date: string;
  contributionCount: number;
}

interface MonthPoint {
  month: string; // YYYY-MM
  count: number;
  smoothed: number;
}

const GQL_ENDPOINT = "https://api.github.com/graphql";

// GitHub's contributionsCollection returns at most ~1 year per query.
// We fetch year-by-year ranges and stitch them together.
const CONTRIB_QUERY = /* GraphQL */ `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      login
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/chart") {
      return handleChart(url, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleChart(url: URL, env: Env): Promise<Response> {
  const username = (url.searchParams.get("username") || "").trim();
  if (!username || !/^[a-zA-Z0-9-]{1,39}$/.test(username)) {
    return json({ error: "Invalid username" }, 400);
  }
  if (!env.GITHUB_TOKEN) {
    return json({ error: "Server is missing GITHUB_TOKEN secret" }, 500);
  }

  const fromYear = clampYear(url.searchParams.get("from"), 2021);
  const now = new Date();
  const smoothing = clampInt(url.searchParams.get("smoothing"), 6, 1, 24);

  let days: DayContribution[];
  try {
    days = await fetchContributionDays(username, fromYear, now, env.GITHUB_TOKEN);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/NOT_FOUND|could not resolve/i.test(msg)) {
      return json({ error: "User not found" }, 404);
    }
    return json({ error: msg }, 502);
  }

  const series = aggregateByMonth(days, smoothing);

  return json(
    {
      username,
      from: `${fromYear}-01-01`,
      to: isoDate(now),
      series,
      meta: {
        source: "github_contribution_graph",
        includes_private: false,
        smoothing_window_months: smoothing,
      },
    },
    200,
    { "Cache-Control": "no-store" },
  );
}

async function fetchContributionDays(
  username: string,
  fromYear: number,
  now: Date,
  token: string,
): Promise<DayContribution[]> {
  const ranges: { from: string; to: string }[] = [];
  for (let y = fromYear; y <= now.getUTCFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1, 0, 0, 0));
    const toRaw = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    const to = toRaw > now ? now : toRaw;
    ranges.push({ from: from.toISOString(), to: to.toISOString() });
  }

  const perRange = await Promise.all(
    ranges.map((r) => gqlFetchYear(username, r.from, r.to, token)),
  );

  const seen = new Map<string, number>();
  for (const daysForYear of perRange) {
    for (const d of daysForYear) seen.set(d.date, d.contributionCount);
  }
  return [...seen.entries()]
    .map(([date, contributionCount]) => ({ date, contributionCount }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function gqlFetchYear(
  login: string,
  from: string,
  to: string,
  token: string,
): Promise<DayContribution[]> {
  const res = await fetch(GQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "github-contributions-chart (cloudflare-worker)",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: CONTRIB_QUERY,
      variables: { login, from, to },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const payload = (await res.json()) as {
    data?: {
      user?: {
        contributionsCollection?: {
          contributionCalendar?: {
            weeks: { contributionDays: DayContribution[] }[];
          };
        };
      } | null;
    };
    errors?: { message: string; type?: string }[];
  };

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => `${e.type ?? ""} ${e.message}`).join("; "));
  }
  if (!payload.data?.user) {
    throw new Error("NOT_FOUND");
  }

  const weeks = payload.data.user.contributionsCollection?.contributionCalendar?.weeks ?? [];
  return weeks.flatMap((w) => w.contributionDays);
}

function aggregateByMonth(days: DayContribution[], smoothing: number): MonthPoint[] {
  const byMonth = new Map<string, number>();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + d.contributionCount);
  }

  const months = [...byMonth.keys()].sort();
  if (months.length === 0) return [];

  const [firstY, firstM] = months[0].split("-").map(Number);
  const [lastY, lastM] = months[months.length - 1].split("-").map(Number);
  const dense: { month: string; count: number }[] = [];
  let y = firstY;
  let m = firstM;
  while (y < lastY || (y === lastY && m <= lastM)) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    dense.push({ month: key, count: byMonth.get(key) ?? 0 });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  const out: MonthPoint[] = [];
  for (let i = 0; i < dense.length; i++) {
    const windowStart = Math.max(0, i - smoothing + 1);
    const window = dense.slice(windowStart, i + 1);
    const avg = window.reduce((s, p) => s + p.count, 0) / window.length;
    out.push({ month: dense[i].month, count: dense[i].count, smoothed: round1(avg) });
  }
  return out;
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

function clampYear(v: string | null, fallback: number): number {
  const n = v ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const nowY = new Date().getUTCFullYear();
  return Math.min(Math.max(n, 2008), nowY);
}

function clampInt(v: string | null, fallback: number, min: number, max: number): number {
  const n = v ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
