# Repository Guidelines

## Project Structure & Module Organization

- `feedbin_fetch.ts`: Fetches recent Feedbin entries (games industry tagged) and writes `feedbin_articles.json` to repo root.
- `feedbin_summarize.ts`: Summarizes the full dataset via OpenAI Responses API; writes `feedbin_summary.md`.
- `dist/`: Compiled JavaScript (`tsc` output). Do not edit.
- `.env`: Local secrets (not committed).
- `tsconfig.json`: TypeScript strict config (CommonJS, output to `dist/`).

## Build, Test, and Development Commands

- `yarn build`: Compile TypeScript to `dist/`
- `yarn feedbin`: Compile + run fetch (`node dist/feedbin_fetch.js`).
- `yarn summarize`: Compile + run summarizer (`node dist/feedbin_summarize.js`).

Example run

```
# .env
FEEDBIN_USERNAME=...
FEEDBIN_PASSWORD=...
OPENAI_API_KEY=...

yarn feedbin    # produces feedbin_articles.json and feedbin_articles.csv
yarn summarize  # produces feedbin_summary.md
```

## Coding Style & Naming Conventions

- TypeScript (strict). Prefer explicit types at module boundaries.
- Indentation: 2 spaces; ~100-char lines.
- Async: use `async/await`; avoid shared mutable state.
- Naming: files `snake_case.ts`; vars/functions `camelCase`; types `PascalCase`; constants `UPPER_SNAKE_CASE`.
- Logging: concise, consistent with existing output.

## Testing Guidelines

- No runner configured. If adding tests, use `vitest` and place files under `tests/*.test.ts`.
- Unit test helpers (e.g., batching, token estimation); mock network and FS.

## Commit & Pull Request Guidelines

- Commits: short, imperative (e.g., "fetch games feeds", "summarize weekly report"). Group related changes.
- PRs: include steps to run (`yarn feedbin`, `yarn summarize`), expected output (`feedbin_summary.md`), and link issues. Keep diffs focused.

## Security & Configuration

- Do not commit `.env`. Required keys: `FEEDBIN_USERNAME`, `FEEDBIN_PASSWORD`, `OPENAI_API_KEY`.
- Handle API errors/rate limits gracefully; never log credentials.
- Large outputs are ignored by Git; commit only small samples if needed for review.
