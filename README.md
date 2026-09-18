# htmldoc-cli

Share an HTML or Markdown file from your laptop as a link. One command. No deploy, no repo, no drag-and-drop.

![npx htmldoc-cli report.html prints a share link](https://raw.githubusercontent.com/ajaxray/htmldoc-cli/main/docs/cli.gif)

```sh
npx -y htmldoc-cli report.html
# https://p.htmldoc.space/NO8JWj8cd57m
```

The link is unlisted, lives 30 days, and can be updated in place so the URL never changes. Hosted at [htmldoc.space](https://htmldoc.space): free, run by one person, no ads or analytics on your pages.

## Setup, once

```sh
npx -y htmldoc-cli login   # opens an approval page, waits for your click, stores the key
```

`login` prints `Open this link to approve: https://htmldoc.space/connect/<code>` and the code, and opens the link in your browser. Sign in there with GitHub (an account is created if you have none), check that the code matches, and click Approve. In a terminal the same command waits for that click, stores the key, and says who you are.

Agents have no terminal, so for them `login` exits at once after printing the link, and a second command finishes the job. The [agent skill](https://github.com/ajaxray/htmldoc-skill) runs both for you:

```sh
npx -y htmldoc-cli login --no-wait   # print the link and exit (automatic when stdin is not a terminal)
npx -y htmldoc-cli login --wait      # after the click: store the key, say who you are
```

`login --wait` polls until the approval lands, times out, or is denied. Pass `--no-browser` (or set `HTMLDOC_NO_BROWSER=1`) to only print the link, for example on a headless machine; open it on any device.

Prefer to copy the key yourself? Sign in at [htmldoc.space/dashboard](https://htmldoc.space/dashboard), copy the key, and run `npx -y htmldoc-cli login --paste`.

Prefer a global install? `npm i -g htmldoc-cli` gives you `htmldoc` on PATH. Zero dependencies; needs Node 22 or newer.

## From an AI agent

Install the skill, then say "share this report" in Claude Code, Codex, Pi, or [any agent that supports skills](https://www.skills.sh/agent):

```sh
npx skills add ajaxray/htmldoc-skill
```

Then ask your agent in plain words: **"share this report"**, **"publish process.html with htmldoc"**, or **"make this plan shareable"**. It replies with the link and the expiry date.

![Claude Code answering "share the report.html" with a link](https://raw.githubusercontent.com/ajaxray/htmldoc-cli/main/docs/agent.gif)

The agent runs this CLI. It never sees or handles your key.

Agents write better HTML than Markdown, and the Claude Code team [says so with twenty examples](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html). Their one caveat is sharing the file. This is that step.

## What you get

- One file per link. HTML is served byte for byte; Markdown is rendered.
- Caps: 2 MB HTML, 512 KB Markdown, 100 live pages per account.
- 30-day expiry, reset by every `--update`. Re-sharing the same file keeps the same link.
- A small badge with a Report link on every page. That is the only thing added to your HTML.

## Commands

| Command | What it does |
|---|---|
| `htmldoc <file> [--update <id\|url>] [--json]` | Upload an `.html`, `.htm`, `.md`, or `.markdown` file. With `--update` the existing page keeps its URL and gets a fresh 30 days. |
| `htmldoc login [--no-browser] [--no-wait]` | Sign in: prints an approval link and code and opens the link in your browser (unless `--no-browser` or `HTMLDOC_NO_BROWSER=1`). In a terminal it then waits for your click like `login --wait`. Without a terminal, or with `--no-wait`, it exits 0 at once so an agent can relay the link. Running it again replaces the pending request. |
| `htmldoc login --wait [--timeout <seconds>]` | Wait for a pending approval (what agents run after `login`), then store the key and print `Logged in as @you` and the dashboard URL. Gives up at the request's expiry (10 minutes) or `--timeout`, whichever is sooner. |
| `htmldoc login --paste` | Paste your API key (hidden input) and store it. Needs an interactive terminal. |
| `htmldoc list [--json]` | List your live pages. |
| `htmldoc delete <id\|url>` | Delete a page. No confirmation prompt. |
| `htmldoc --version`, `htmldoc --help` | Version and usage. |

`login`, `list`, and `delete` are reserved first arguments; anything else is treated as a file to share. Unknown flags exit 1. The key is never accepted as a flag.

## Output contract

Scripts and agents can rely on this:

- On success the upload prints **only the share URL** on stdout, followed by a newline. The id and expiry go to stderr. With `--json`, stdout is one line: `{"id":"...","url":"...","expires_at":"..."}`.
- `list` prints a table on stdout (`ID  STATE  EXPIRES  FILENAME  URL`), or the raw `{"pages":[...]}` payload with `--json`. With no pages, stdout is empty and stderr says `no pages`.
- `delete` prints nothing on stdout and `deleted <url>` on stderr.
- Every failure exits 1 with a one-line reason on stderr and nothing on stdout. Some failures add hint lines after the reason (for example where to get a key).
- stderr never contains an API key.

Typical failure lines:

| Situation | stderr |
|---|---|
| No key configured | `no API key configured.` then `sign in with: npx htmldoc-cli login` and `or copy your key from https://htmldoc.space/dashboard and run: npx htmldoc-cli login --paste` |
| Rejected key (401) | the server's line, then the same two hint lines |
| Unsupported extension | `unsupported file type ".txt": use .html, .htm, .md, or .markdown` |
| Over the size cap, locally or from the server | `file is too large: HTML files up to 2 MB, Markdown files up to 512 KB` |
| Bad encoding | `file is not valid UTF-8` or `file is UTF-16 (byte-order mark found); save it as UTF-8` |
| Rate limited (429) | the server's line plus `(retry after N seconds)`. During `login --wait` a 429 is never a failure: the CLI backs off and keeps polling. |
| `login --wait` with nothing pending | `no sign-in is waiting for approval.` then `run: npx htmldoc-cli login` |
| Approval denied, expired, or already consumed | one line naming the outcome (a consumed approval says the reply may have been lost), then the same `run: npx htmldoc-cli login` hint. The pending request is forgotten. |
| `login --wait` ran out of time | `timed out waiting for approval.` then the same hint |
| `login --paste` without a terminal | `login needs an interactive terminal to paste the key (stdin is not a TTY).` then `run: npx htmldoc-cli login instead; it needs no terminal` |
| Page deleted or purged on `--update` (410) | the server's line |
| Server down or unreachable | `could not reach <origin>: <reason>` (also used for the 60-second timeout) |
| Server unreachable or 5xx during `login --wait` | the CLI prints `<reason>; retrying in Ns…` and keeps polling; after 5 failures in a row it exits 1 with that reason and `to resume this sign-in, run: npx htmldoc-cli login --wait`. The pending request is kept. |
| Non-JSON error body (for example a proxy 502) | `server returned HTTP <status>` |

Files are checked locally before any request: extension, size (2 MB HTML, 512 KB Markdown), non-empty, valid UTF-8 without a UTF-16 byte-order mark.

## Configuration

Config lives in `$XDG_CONFIG_HOME/htmldoc` (default `~/.config/htmldoc`, mode 0700):

- `config.json` (mode 0600): `{"apiKey": "..."}`, written only by `login --wait` and `login --paste`.
- `pairing.json` (mode 0600): the sign-in request between `login` and `login --wait`: the device secret the CLI polls with, the code shown in the link, the expiry, the poll interval, and the API origin. It is deleted as soon as `--wait` finishes, one way or the other, and replaced by the next `login`. It never contains the key. Deleting it just cancels the pending sign-in.
- `state.json`: maps absolute file paths to `{id, url}` so a repeat upload of the same path prints a hint naming the earlier URL and the `--update` form. It is a cache; deleting it is harmless.

Environment variables:

- `HTMLDOC_API_KEY` overrides the stored key (for agents and CI).
- `HTMLDOC_NO_BROWSER=1` makes `login` print the approval link without opening a browser. Without it the CLI runs `open` on macOS, `xdg-open` on Linux (only when `DISPLAY` or `WAYLAND_DISPLAY` is set), or `cmd /c start` on Windows, and prints `Opening your browser…` first. A failed open is not an error; the link is always printed.
- `HTMLDOC_API_URL` points the CLI at another origin, for example `http://localhost:8000` when running the service locally. `https://` is accepted anywhere; `http://` only for `localhost`, `127.0.0.1`, `::1`, and `*.localhost`. Anything else exits 1 before any request. While the override is active every command prints `using API at <origin>` to stderr, and the dashboard URL in hints is derived from it.

## Development

```sh
git clone git@github.com:ajaxray/htmldoc-cli.git
cd htmldoc-cli
node --test
npm pack --dry-run
```

Tests mock `fetch` and use a temporary `XDG_CONFIG_HOME`; nothing touches your real config. To run an unpublished checkout as `htmldoc`, `npm link` in the clone.

## Feedback

CLI bugs: [issues here](https://github.com/ajaxray/htmldoc-cli/issues). Feature requests, roadmap votes, and anything about the site: [ajaxray/htmldoc.space](https://github.com/ajaxray/htmldoc.space/issues).

## Related

- Service and API: [ajaxray/htmldoc](https://github.com/ajaxray/htmldoc), live at [htmldoc.space](https://htmldoc.space).
- Agent skill that drives this CLI from Claude, Codex, Pi, or [any AI agent that supports skills](https://www.skills.sh/agent): [ajaxray/htmldoc-skill](https://github.com/ajaxray/htmldoc-skill), install with `npx skills add ajaxray/htmldoc-skill`.

## License

MIT
