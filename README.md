# GitHub contributions in the AI era

Chart any public GitHub user's monthly contributions since 2021, overlaid with
the launch dates of major AI coding tools (Copilot, ChatGPT, GPT-4, Cursor,
Claude, Claude Code, Codex, etc.).

Live at: https://github-contributions-chart.asdfasdfadsfasdf3323e234.workers.dev

Made by [@joshferge](https://x.com/joshferge).

## How it works

A single Cloudflare Worker serves:

- **`/`** — a static `index.html` (from `public/`) rendered by Chart.js with a
  dashed-rule annotation for each AI tool launch.
- **`/api/chart?username=<handle>&from=<year>&smoothing=<n>`** — fetches the
  GitHub GraphQL `contributionsCollection` year-by-year, aggregates into
  monthly buckets, applies an N-month moving average, and returns JSON with
  the series + markers.
- **`/api/markers`** — just the AI tool launch marker list (used for legend
  rendering on first paint).

Responses are cached at the Cloudflare edge for 6 hours per `(username, from,
smoothing)` tuple.

## Stack

- Cloudflare Workers + static assets (via `wrangler.jsonc`)
- TypeScript (worker) — no build step; Wrangler handles bundling
- Vanilla HTML/CSS/JS (frontend) with Chart.js 4.x +
  `chartjs-plugin-annotation` loaded from a CDN
- Geist + JetBrains Mono (Google Fonts)

No framework, no database, no bundler config beyond Wrangler.

## Layout

```
src/index.ts          Worker: routes, GitHub GraphQL fetch, aggregation, cache
public/index.html     Frontend: hero, search, controls, chart, share buttons
wrangler.jsonc        Worker config (name, main, assets dir, compat date)
package.json          Dev deps only (wrangler, workers-types, typescript)
tsconfig.json         TS config for editor type-checking
```

## Local development

```bash
npm install
npx wrangler login                              # once, OAuth to Cloudflare
gh auth token | npx wrangler secret put GITHUB_TOKEN
npm run dev                                     # starts wrangler dev
```

The `GITHUB_TOKEN` secret is required for any GitHub GraphQL call. The `gh`
CLI token works fine (needs no specific scopes for public contribution data).
A fine-grained PAT with zero scopes is the safer long-term option.

## Deploying

```bash
npm run deploy
```

Deploys to the account you logged into with `wrangler login`. First deploy
creates the Worker; subsequent deploys update it.

### Updating the GitHub token

```bash
gh auth token | npx wrangler secret put GITHUB_TOKEN
```

## Editing AI tool markers

Two places, and they need to stay in sync:

- **`src/index.ts`** — `AI_MARKERS` is the full list returned by the API.
  Each entry is `{ date: "YYYY-MM-DD", label, category }`.
- **`public/index.html`** — `KEY_MARKERS` is the curated subset actually
  rendered on the chart (to avoid label collisions). Add the date of any
  new marker you want to appear on the chart here too.

After editing markers, `npm run deploy`. The edge cache will still serve old
chart responses for up to 6 hours — append any dummy query param to bust it
if you want the new markers to appear immediately.

## Share flow

Buttons appear once a chart renders:

- **Share on X** — opens `twitter.com/intent/tweet` with prefilled text + the
  permalink. The permalink includes `?u=<handle>`, so clicking the shared
  link lands directly on the recipient's chart.
- **Copy link** — just the permalink.
- **Copy image** — writes a PNG of the chart canvas to the clipboard via the
  async Clipboard API (Safari-compatible: Promise is passed directly to
  `ClipboardItem`). Falls back to a file download if the clipboard is
  unavailable.
- **Download PNG** — direct download.

X intents don't support attaching media — that requires the X API with OAuth.
The viral-ready path is an OG image endpoint so the permalink unfurls to the
chart inside the tweet; not built yet.

## License

No license declared; ask before forking commercially.
