# htmldoc-cli

Share a local HTML or Markdown file as an unlisted link on [htmldoc.space](https://htmldoc.space). Links live 30 days and can be updated in place. Zero dependencies; needs Node 22 or newer.

```sh
npm i -g htmldoc-cli
htmldoc login          # once: paste the key from https://htmldoc.space/dashboard
htmldoc report.html    # prints https://p.htmldoc.space/<id>
```

Without a global install, `npx -y htmldoc-cli <file>` works the same way.

## Commands

| Command | What it does |
|---|---|
| `htmldoc <file> [--update <id\|url>] [--json]` | Upload an `.html`, `.htm`, `.md`, or `.markdown` file. With `--update` the existing page keeps its URL and gets a fresh 30 days. |
| `htmldoc login` | Paste your API key (hidden input) and store it. Needs an interactive terminal. |
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
| No key configured | `no API key configured.` then `Get your key at https://htmldoc.space/dashboard` and `then run: npx htmldoc-cli login` |
| Rejected key (401) | the server's line, then the same two hint lines |
| Unsupported extension | `unsupported file type ".txt": use .html, .htm, .md, or .markdown` |
| Over the size cap, locally or from the server | `file is too large: HTML files up to 2 MB, Markdown files up to 512 KB` |
| Bad encoding | `file is not valid UTF-8` or `file is UTF-16 (byte-order mark found); save it as UTF-8` |
| Rate limited (429) | the server's line plus `(retry after N seconds)` |
| Page deleted or purged on `--update` (410) | the server's line |
| Server down or unreachable | `could not reach <origin>: <reason>` (also used for the 60-second timeout) |
| Non-JSON error body (for example a proxy 502) | `server returned HTTP <status>` |

Files are checked locally before any request: extension, size (2 MB HTML, 512 KB Markdown), non-empty, valid UTF-8 without a UTF-16 byte-order mark.

## Configuration

Config lives in `$XDG_CONFIG_HOME/htmldoc` (default `~/.config/htmldoc`, mode 0700):

- `config.json` (mode 0600): `{"apiKey": "..."}`, written only by `login`.
- `state.json`: maps absolute file paths to `{id, url}` so a repeat upload of the same path prints a hint naming the earlier URL and the `--update` form. It is a cache; deleting it is harmless.

Environment variables:

- `HTMLDOC_API_KEY` overrides the stored key (for agents and CI).
- `HTMLDOC_API_URL` points the CLI at another origin, for example `http://localhost:8000` when running the service locally. `https://` is accepted anywhere; `http://` only for `localhost`, `127.0.0.1`, `::1`, and `*.localhost`. Anything else exits 1 before any request. While the override is active every command prints `using API at <origin>` to stderr, and the dashboard URL in hints is derived from it.

## Development

```sh
git clone git@github.com:ajaxray/htmldoc-cli.git
cd htmldoc-cli
node --test
npm pack --dry-run
```

Tests mock `fetch` and use a temporary `XDG_CONFIG_HOME`; nothing touches your real config. To run an unpublished checkout as `htmldoc`, `npm link` in the clone.

## Related

- Service and API: [ajaxray/htmldoc](https://github.com/ajaxray/htmldoc), live at [htmldoc.space](https://htmldoc.space).
- Agent skill that drives this CLI: [ajaxray/htmldoc-skill](https://github.com/ajaxray/htmldoc-skill), install with `npx skills add ajaxray/htmldoc-skill`.

## License

MIT
