# Brimble Task — Deployment Pipeline

A one-page deployment pipeline that takes a Git URL, builds a container image with Railpack, runs it via Docker, and routes traffic through Caddy — all from a single UI with live log streaming.

## Stack

- **Frontend** — Vite + React + TanStack Query
- **Backend** — NestJS + TypeScript + SQLite (better-sqlite3)
- **Build** — Railpack + BuildKit
- **Ingress** — Caddy (static file serving + dynamic reverse proxy via admin API)
- **Runtime** — Docker (containers managed via Docker socket mount)

## How it works

1. User submits a Git URL via the UI
2. Backend clones the repo to a temp directory
3. Railpack builds a container image via BuildKit
4. Backend runs the image as a named container on the compose network
5. Backend calls Caddy's admin API to prepend a new reverse proxy route for `/deploy/{id}/*`
6. Deployment status and live build logs stream to the UI over SSE throughout

Each phase updates the deployment status: `pending → building → deploying → running → failed`.

## Architecture

```
Browser
  └── Caddy :80
        ├── /api/*     → backend:3000 (NestJS)
        ├── /deploy/*  → deployment-{id}:3000 (dynamic, registered at runtime)
        └── /*         → frontend:4000 (Caddy static file server)

backend
  ├── SQLite at /app/data/deployments.db (persisted via named volume)
  ├── Spawns: git clone → railpack build → docker run
  └── SSE log streaming with in-memory buffer + replay for late clients

buildkit
  └── BuildKit daemon, reachable at tcp://buildkit:1234
      Railpack uses this to build images without a Docker daemon directly
```

One thing worth noting on the Caddy routing: deployment routes must be prepended before the frontend catch-all, not appended. Caddy evaluates routes in order — appending means the catch-all always matches first. The backend GETs the current route list, prepends the new route, and PATCHes the full array back.

## Running locally

**Prerequisites:** Docker, Docker Compose

```bash
git clone https://github.com/major101x/brimble-task
cd brimble-task
docker compose up --build
```

Open `http://localhost`. No other setup required. The BuildKit daemon starts automatically as part of the compose stack.

**To deploy an app**, paste any public Git URL into the form. The repo must be a Node.js app with a `start` script in `package.json`. The sample app used during development is at https://github.com/major101x/sample-deploy-app.

**Environment variables:**

No external accounts or API keys required. All defaults are set in `docker-compose.yml`.

## Project structure

```
brimble-task/
├── backend/          # NestJS API — deployments, pipeline, SSE
│   └── src/
│       └── deployments/
│           ├── database.ts
│           ├── deployments.controller.ts
│           ├── deployments.service.ts
│           └── deployments.module.ts
├── frontend/         # Vite + React — single page UI
├── caddy/
│   └── Caddyfile
└── docker-compose.yml
```

## Tests

```bash
cd backend
npm test
```

9 tests across two files. Service tests cover CRUD behavior and SSE log streaming including the replay-on-connect behavior. Controller tests cover HTTP responses using a mock service.

## Time spent

~24 hours over 4 days.

## What I'd do with another weekend

**Rollback / redeploy** — The image tag is already stored per deployment. Rollback would be: stop the current container, `docker run` the previous image tag, update the Caddy route to point at the new container. The data model already supports it.

**Build cache reuse** — Railpack supports BuildKit cache mounts. Right now every build pulls fresh. Persisting the BuildKit cache across builds (via a named volume on the BuildKit service) would cut build times significantly on repeat deploys of the same repo.

**Container cleanup** — Right now failed or replaced containers are left running or orphaned. A cleanup pass on deploy (stop + remove the previous container for the same deployment ID before starting the new one) would prevent resource leaks.

**Port allocation** — Currently uses a random port in the 4100–4999 range. In a real system this would be tracked in the database to guarantee no collisions across concurrent deployments.

**Graceful shutdown** — No zero-downtime redeploy. A proper implementation would start the new container, wait for it to be healthy, update the Caddy route, then stop the old one.

**Persistent Logs** — Currently logs are stored in-memory with a replay buffer. Persisting to SQLite or a log file would preserve build history across restarts and enable better debugging and audit trails.