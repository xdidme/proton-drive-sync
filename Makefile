.PHONY: install build dev pre-commit publish clean db-inspect

# Install dependencies
install:
	pnpm install

# Build the project
build:
	pnpm build

# Run directly with tsx (no build required)
dev:
	PROTON_DEV=1 pnpm tsx src/index.ts $(ARGS)

# Run pre-commit checks on all files
pre-commit:
	pnpm eslint --fix 'src/**/*.ts'
	pnpm prettier --write 'src/**/*.ts' '*.json' '*.md'

# Publish to npm
publish:
	pnpm build
	pnpm publish

# Clean build artifacts
clean:
	rm -rf dist

# Open Drizzle Studio to inspect the database
db-inspect:
	npx drizzle-kit studio
