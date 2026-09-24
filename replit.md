# Contractor Visual Quote Demo

A contractor intake prototype with an authenticated, budget-limited AI room-redesign endpoint. Contractor configuration and quote-request previews remain local demo state.

## Run & Operate

- Run the API server through its managed artifact workflow
- `pnpm --filter @workspace/contractor-visual-quote-demo run dev` — run the demo frontend through its managed workflow
- `pnpm --filter @workspace/contractor-visual-quote-demo run typecheck` — check the demo frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- AI access uses Clerk sessions and `OPENAI_API_KEY`. The public homeowner preview does not grant redesign access.
- Optional positive integer limits: `REDESIGN_MONTHLY_CONTRACTOR_LIMIT` (default 3 requests), `REDESIGN_MONTHLY_BUDGET_CENTS` (default 1000), `REDESIGN_RESERVATION_CENTS` (default 100 per dispatched request). All periods reset at midnight UTC on the first of the month. Reservations remain counted after provider errors/timeouts. Set the per-request reservation above your expected upper-bound image cost; this is an *estimated* internal ceiling, not an exact OpenAI bill or provider-side spending limit. Review OpenAI's own billing controls before a public launch.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Demo frontend: React, Vite, TypeScript, Tailwind CSS, Wouter, Framer Motion

## Where things live

- `artifacts/contractor-visual-quote-demo/src/App.tsx` — routes, demo state, mocked workflow, and page components
- `artifacts/contractor-visual-quote-demo/src/index.css` — visual theme and responsive styling
- `artifacts/contractor-visual-quote-demo/public/` — bundled sample renovation images

## Architecture decisions

- The redesign endpoint uses real AI, Clerk contractor sessions, and database-backed monthly reservations. Email delivery remains a demo preview.
- Contractor configuration and submitted demo state persist only in browser local storage.
- Custom uploads are processed ephemerally for a redesign; sample imagery remains available for preview.
- Keep prototype simulation disclosures visible so the UI does not imply that real AI or email delivery occurred.

## Product

- Configure a sample contractor and preview an embeddable intake widget.
- Complete a homeowner flow from room selection and photo upload through an authenticated AI redesign and rough scope generation.
- Submit homeowner details and inspect the contractor-facing lead email preview.
- Reset the complete demo from the contractor experience.

## Gotchas

- Run the frontend through the managed artifact workflow so `PORT` and `BASE_PATH` are provided.
- Object URLs for custom uploads are session-local; the prepared demo projects are the reliable repeatable presentation path.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
