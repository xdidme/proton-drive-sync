# Proton Drive Sync

A CLI tool that watches a local directory and syncs changes to Proton Drive in real-time using Facebook's Watchman.

## Requirements

- [pnpm](https://pnpm.io/installation)
- [Watchman](https://facebook.github.io/watchman/docs/install) - `brew install watchman` on macOS

## Installation

```bash
git clone --recursive https://github.com/user/proton-drive-sync
cd proton-drive-sync
pnpm install
pnpm build
pnpm link --global
```

## Usage

```bash
# Start syncing
proton-drive-sync sync

# Show help
proton-drive-sync --help
```

This will:

1. Prompt for your Proton credentials (with optional 2FA)
2. Save credentials to your macOS Keychain for future use
3. Watch the `my_files/` directory for changes
4. Automatically sync file/directory creates, updates, and deletes to Proton Drive

Press `Ctrl+C` to stop watching.

## Development

For an editable install (changes to source are reflected immediately):

```bash
pnpm install
pnpm link --global
```

Then run directly with tsx (no build step required):

```bash
tsx src/index.ts sync
```

Or rebuild after changes:

```bash
pnpm build
proton-drive-sync sync
```
