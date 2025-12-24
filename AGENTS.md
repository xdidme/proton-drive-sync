# AGENTS.md

## Build & Run Commands

- `make install` - install dependencies (requires watchman installed on system)
- `make build` - compile standalone binary to dist/proton-drive-sync
- `make run ARGS="<cmd>"` - run one-off command (e.g., `make run ARGS="status"`)
- `make dev ARGS="start"` - run with auto-reload on file changes
- `make pre-commit` - run eslint --fix and prettier on all files
- `make build-check` - type-check without emitting files
- `make db-inspect` - open Drizzle Studio to inspect SQLite database
- `make clean` - remove dist/ build artifacts
- No test suite exists in this project

## Code Style

- **Formatting**: Prettier - single quotes, semicolons, 2-space indent, 100 char width
- **Imports**: ESM with `.js` extension (e.g., `import { foo } from './bar.js'`)
- **Types**: Strict TypeScript, no `any` allowed, prefix unused params with `_`
- **Naming**: camelCase for functions/variables, PascalCase for types/interfaces
- **Exports**: Named exports preferred; re-export from index.ts barrel files
- **Logging**: Use winston logger (`import { logger } from './logger.js'`)
- **Errors**: Throw Error objects; no custom error classes used
