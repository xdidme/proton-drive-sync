# Proton Drive Sync

A CLI tool to list files in your Proton Drive.

## Setup

```bash
git submodule update --init --recursive
cd sdk/js/sdk && pnpm install && pnpm build && cd ../../..
pnpm install
```

## Run

```bash
node src/list-files.js
```

Credentials are saved to your macOS Keychain after first login.
