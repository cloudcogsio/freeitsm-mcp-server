# freeitsm-mcp-server

A standalone [MCP](https://modelcontextprotocol.io) server that lets an AI assistant work with
[FreeITSM](https://github.com/edmozley/freeitsm) through its REST API (`/api/v1`): search, read,
create and update tickets, changes, problems, knowledge, assets and everything else the API offers
(285 endpoints as of FreeITSM 4.12).

**The API key is the security boundary.** The server is a plain API client: what the key may do
(its permissions, company scope, expiry, rate limit and the analyst it acts as) is all the
assistant may do. FreeITSM enforces this on every request. On top of that, the server:

- asks FreeITSM at startup what the key may do (`GET /api/v1/ping`) and **offers only the tools
  that key can use** - a ticket-read key never sees a write tool;
- checks each call against the key's permissions before sending it, and says which permission is missing;
- can run **read-only** (`FREEITSM_READ_ONLY=true`) whatever the key allows.

It is separate from FreeITSM's built-in MCP endpoint (`/api/mcp/`), which is read-only and offers a
fixed set of summary tools. This one covers the whole REST API, including writes.

## Requirements

- Node.js 20.12 or later, or Docker (see [Docker](#docker))
- A FreeITSM install with the REST API, and an API key from **System > API** with the
  permissions you want the assistant to have. A dedicated analyst (e.g. "AI Assistant") keeps
  the audit trail readable.

## Setup

```bash
git clone <this repository> freeitsm-mcp
cd freeitsm-mcp
npm install        # also builds dist/
```

Register it with your MCP client as a **stdio** server: the command is `node`, the argument is the
full path to `dist/index.js`, and the settings are environment variables. Most clients take a
JSON entry of this shape:

```json
{
  "mcpServers": {
    "freeitsm-api": {
      "command": "node",
      "args": ["/path/to/freeitsm-mcp/dist/index.js"],
      "env": {
        "FREEITSM_URL": "https://itsm.example.com",
        "FREEITSM_API_KEY": "fitsm_xxx",
        "FREEITSM_READ_ONLY": "true"
      }
    }
  }
}
```

| Variable | Meaning |
|---|---|
| `FREEITSM_URL` | Base URL of the install (`https://itsm.example.com`; a URL ending in `/api/v1` also works). Use https: plain http to a remote host is warned about, because the key would travel unencrypted. |
| `FREEITSM_API_KEY` | The API key. Required. |
| `FREEITSM_READ_ONLY` | `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`). `true` hides every write tool. Any other value stops the server, so a typo never leaves it writable. |
| `FREEITSM_UPLOAD_DIR` | Folder that `freeitsm_upload_change_evidence` may read local files from. Unset (the default): local files cannot be uploaded at all; base64 content still can. |
| `FREEITSM_UPLOAD_MAX_MB` | Largest upload accepted, default 20 |
| `FREEITSM_TIMEOUT_MS` | Per-request timeout, default 30000 |

The tool list is fixed when the server starts. After changing the key's permissions, restart the
server. The startup line on stderr says which key it uses, how many endpoints it may call, and
whether it is `READ-ONLY` or `WRITABLE`.

## Docker

The image is built from pinned base images. It runs on a distroless Node runtime (no shell, no
package manager) as a non-root user, and holds only production dependencies. The server's files
are owned by root, so the process cannot modify its own code.

```bash
docker build -t freeitsm-mcp-server .
```

The server speaks MCP over stdio, so the client starts the container itself and keeps stdin
open (`-i`). Recommended entry, locked down:

```json
{
  "mcpServers": {
    "freeitsm-api": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--memory=256m", "--pids-limit=64",
        "-e", "FREEITSM_URL", "-e", "FREEITSM_API_KEY", "-e", "FREEITSM_READ_ONLY",
        "freeitsm-mcp-server"
      ],
      "env": {
        "FREEITSM_URL": "https://itsm.example.com",
        "FREEITSM_API_KEY": "fitsm_xxx",
        "FREEITSM_READ_ONLY": "true"
      }
    }
  }
}
```

- `-e NAME` without a value copies the variable from the client's environment, so the key is not
  written on the `docker` command line (which other local users could see in the process list).
- The server needs no writable filesystem, so `--read-only` works as-is.
- **Uploads:** mount the folder read-only and point the variable at the mount, e.g. add
  `"-v", "/path/to/evidence:/uploads:ro", "-e", "FREEITSM_UPLOAD_DIR=/uploads"`.
- **FreeITSM on the same machine:** inside the container `localhost` is the container itself.
  Use `http://host.docker.internal:<port>` (on Linux also add
  `"--add-host=host.docker.internal:host-gateway"`). The server will warn that this is plain
  http, which is fine for a local install. Use https for anything remote.
- To restrict network access further, attach the container to a Docker network that can reach
  only the FreeITSM host.

## Tools

Dedicated tools (each appears only if the key has the permission it needs):

| Tool | Endpoint(s) |
|---|---|
| `freeitsm_whoami` | `GET /ping` - the key's analyst, companies, permissions |
| `freeitsm_search_tickets`, `freeitsm_get_ticket` | `GET /tickets`, `/tickets/{id}` (+ notes, thread, SLA, time, audit) |
| `freeitsm_create_ticket`, `freeitsm_update_ticket` | `POST /tickets`, `PATCH /tickets/{id}` |
| `freeitsm_add_ticket_note`, `freeitsm_log_time` | `POST /tickets/{id}/notes`, `/time-entries` |
| `freeitsm_search_knowledge`, `freeitsm_get_article` | `GET /knowledge/articles[/{id}]` |
| `freeitsm_search_changes`, `freeitsm_get_change` | `GET /changes[/{id}]` |
| `freeitsm_upload_change_evidence` | `POST /changes/{id}/attachments` (multipart) |
| `freeitsm_search_problems`, `freeitsm_search_assets` | `GET /problems`, `GET /assets` |
| `freeitsm_reference_data` | the `reference.read` lookup lists (statuses, priorities, types...) |

Generic tools, covering every endpoint:

| Tool | |
|---|---|
| `freeitsm_list_endpoints` | Sections, or endpoints filtered by section / search; can show what the key lacks |
| `freeitsm_describe_endpoint` | Parameters, body fields, examples, required permission |
| `freeitsm_api_get` | Any permitted GET |
| `freeitsm_api_write` | Any permitted POST / PUT / PATCH / DELETE (hidden when read-only or the key has no write permission) |

The endpoint catalogue is read at startup from the install's own `/api/v1/openapi.json` and
`/api/v1/spec.json`, so it matches the FreeITSM version you connect to. An endpoint whose required
permission cannot be determined is treated as unavailable.

## Security notes

- **Give the key only what the assistant needs.** The local filtering above is a convenience and
  a second line of defence; the key's permissions in FreeITSM are what actually protect your data.
  Start with a read-only key or `FREEITSM_READ_ONLY=true`.
- **Records contain other people's text.** Ticket bodies, emails and articles can include
  instructions aimed at an AI ("ignore your rules and ..."). An assistant with write access could be
  talked into acting on them. Keep write access narrow, and use an MCP client that asks before
  running write tools (they are annotated as such).
- **Local files.** Only files inside `FREEITSM_UPLOAD_DIR` can be uploaded (symlinks are resolved
  first), so an assistant cannot be steered into uploading, say, SSH keys. Leave it unset unless
  you need it.
- **Paths are checked strictly.** The generic tools accept only plain API paths (no `..`,
  percent-encoding or backslashes), so the endpoint that is checked is the endpoint that is called.
  Redirects are never followed, so the key is only ever sent to `FREEITSM_URL`.

## Development

```bash
npm test            # builds, then runs unit and in-process tests with a stubbed FreeITSM
npm run typecheck   # src, tests and scripts
npm run smoke       # read-only checks against a real install; settings in .env (see .env.example)
npm run fixtures    # refresh test/fixtures from FREEITSM_URL
npx @modelcontextprotocol/inspector node dist/index.js   # interactive
```

## Licence and credits

MIT - see [LICENSE](LICENSE).

[FreeITSM](https://github.com/edmozley/freeitsm) is by Ed Mozley and is also MIT-licensed. The
files in `test/fixtures/` are FreeITSM's own API description documents, generated by a FreeITSM
install, and are included for testing under its licence.
