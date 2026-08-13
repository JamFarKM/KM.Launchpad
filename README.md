# Pipeline Launchpad

A self-hosted web app for browsing and running your **Azure DevOps** pipelines from
a UI you control — instead of clicking through Azure DevOps' pipeline tree and
breadcrumbs.

- 🔍 **Auto-discovers** every pipeline in your project(s).
- 🧩 **Custom views** — drag the pipelines you care about into your own saved
  dashboards ("Placement dev", "Settlement", …). Views are stored per user.
- ▶️ **Trigger** any pipeline with a branch picker and parameter/variable overrides.
- 🟢 **Live status** — recent runs with auto-refreshing state badges.
- 📜 **Logs & history** — drill into a run and read step logs without leaving the app.
- 🔐 **Per-user PAT** — everyone signs in with their own Azure DevOps personal
  access token. Runs are attributed to the real person, and each user only sees
  and does what their token allows. Tokens are **encrypted at rest** and never
  leave the server or reach the browser.

Built with ASP.NET Core (.NET 10) + React (Vite/TypeScript), shipped as a single
Docker image.

---

## Quick start

```bash
cp .env.example .env          # optional: set ADO_DEFAULT_ORG, PORT
docker compose up -d --build
```

Then open <http://localhost:8080>, enter your organization (defaults to
`BetagyDevOps`) and a personal access token, and you're in.

State (the SQLite database, encryption keys, and saved views) lives in the
`launchpad-data` Docker volume, so it survives restarts and image rebuilds.

## Creating a personal access token

In Azure DevOps: **User settings → Personal access tokens → New Token**, scoped to
your organization with:

| Scope     | Access         | Why                                                      |
| --------- | -------------- | -------------------------------------------------------- |
| Build     | Read & execute | list pipelines, read runs, trigger                       |
| Code      | Read & write   | branches and diffs, **and** posting PR comments and votes |
| Project   | Read           | list projects                                            |

**Code needs write, not just read.** Read alone covers the branch picker and the
Review page's diffs, but the Review page also posts comment threads, replies,
thread resolution, and your approve/reject vote — all of which Azure DevOps puts
behind Code (write). With a read-only token the app signs in and browses fine, and
then fails the moment you try to comment or vote.

Paste it on the connect screen. The app validates it, resolves your identity, and
keys your saved views to you.

## Running it

Docker is the only supported way to run the app. The image builds the frontend and
serves it from the ASP.NET Core host, so there is one process, one port, and one
artifact that behaves the same everywhere — there is no `npm run dev` path to keep
in sync.

Everyday commands:

```bash
docker compose logs -f          # follow the logs
docker compose up -d --build    # rebuild and restart after a code change
docker compose down             # stop (your data survives in the volume)
docker compose down -v          # stop AND delete the database, keys and views
```

A few things worth knowing:

- **Rebuild after changing code.** `docker compose up -d` on its own reuses the
  existing image; without `--build` your changes won't be in it.
- **Use compose, not a bare `docker run`.** Compose mounts the
  `pipeline-launchpad_launchpad-data` volume. A hand-rolled `docker run -v
  launchpad-data:/data` creates a *different*, empty volume, and the app comes up
  asking for a PAT as though it had never been configured.
- **`down -v` is destructive** — it drops the volume, which means the SQLite
  database, the PAT-encryption keys, and every saved view.

Run the frontend checks directly when you're changing the UI, since they're faster
than a rebuild:

```bash
cd src/web
npm install
npx tsc --noEmit -p tsconfig.json   # typecheck
npm test                            # unit tests
```

## Configuration

| Env var             | Default        | Purpose                                                     |
| ------------------- | -------------- | ----------------------------------------------------------- |
| `ADO_DEFAULT_ORG`   | `BetagyDevOps` | Org pre-filled on the connect screen (users can override).  |
| `PORT`              | `8080`         | Host port (compose only).                                   |
| `PL_DATA_DIR`       | `/data`        | Where the SQLite db + Data Protection keys are written.     |

## Architecture

```
Browser ──► ASP.NET Core (minimal API)  ──►  Azure DevOps REST API (v7.1)
                │
                ├─ SQLite  (users, sessions, saved views)
                └─ Data Protection (encrypts each user's PAT at rest)

The React SPA is built and served as static files by the same ASP.NET process,
so the whole thing is one container on one port.
```

| Path                  | What                                                     |
| --------------------- | -------------------------------------------------------- |
| `src/server`          | ASP.NET Core backend (API + static host)                 |
| `src/server/Services` | `AdoService` (REST client), auth/session, PAT encryption |
| `src/web`             | React + Vite frontend                                    |
| `Dockerfile`          | 3-stage build: web → server → runtime                    |

## Security notes

- PATs are encrypted with ASP.NET Data Protection before being written to SQLite;
  the keyring is persisted to the data volume. The raw token is only ever held in
  memory to make an Azure DevOps request and is never sent to the browser.
- The session cookie is `HttpOnly` and `SameSite=Lax`.
- This is an internal tool. Put it behind your normal network controls / reverse
  proxy (and terminate TLS there) before exposing it to a team.

## License

[MIT](LICENSE) © 2026 James Farrugia. Free to use, modify, and redistribute;
just keep the copyright notice and license text.
