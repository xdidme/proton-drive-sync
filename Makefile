.PHONY: install build build-check run dev pre-commit publish clean db-inspect

# Install dependencies
install:
	bun install

# Build standalone binary with bun
build:
	bun build --compile --minify ./src/index.ts --outfile ./dist/proton-drive-sync

# Type-check without emitting files
build-check:
	bun run build:check

# Run directly with bun (one-off commands)
run:
	PATH="$(PWD)/dist:$(PATH)" PROTON_DEV=1 bun src/index.ts $(ARGS)

# Run directly with bun in watch mode (auto-reload on file changes)
dev:
	PATH="$(PWD)/dist:$(PATH)" PROTON_DEV=1 bun --watch src/index.ts start --watch

# Run pre-commit checks on all files
pre-commit:
	bun eslint --fix 'src/**/*.ts'
	bun prettier --write 'src/**/*.ts' '*.json' '*.md'

# Publish to npm
publish:
	bun run build
	bun publish

# Clean build artifacts
clean:
	rm -rf dist

# Open Drizzle Studio to inspect the database
db-inspect:
	bun drizzle-kit studio
