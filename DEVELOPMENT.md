# Development

## Requirements

- [Bun](https://bun.sh) - JavaScript runtime and package manager
- [Watchman](https://facebook.github.io/watchman/) - Required only for `make dev` hot-reload (not needed for production)

### Installing Watchman (for development only)

Watchman is used by `make dev` for hot-reload during development. It is **not** required for production use.

```bash
# macOS
brew install watchman

# Linux (Ubuntu/Debian)
sudo apt-get install watchman

# Linux (from source) - see https://facebook.github.io/watchman/docs/install
```

On Linux, you may also need `pywatchman` for the `watchman-wait` command:

```bash
pip install pywatchman
```

## Setup

```bash
git clone https://github.com/damianb-bitflipper/proton-drive-sync
cd proton-drive-sync
make install
```

## Running Locally

The canonical way to develop is via the `make dev` command, which runs the app directly with bun in watch mode (auto-reload on file changes):

```bash
make dev
```

This runs `start --no-daemon` automatically. Use `Ctrl+C` to stop.

For one-off commands (like service install), use `make run`:

```bash
make run ARGS="service install"
```

## Make Commands

| Command           | Description                                       |
| ----------------- | ------------------------------------------------- |
| `make install`    | Install dependencies                              |
| `make build`      | Build standalone binary to `./dist`               |
| `make dev`        | Run `start --no-daemon` with bun (auto-reload)    |
| `make run ARGS=…` | Run one-off commands with bun (exits on complete) |
| `make pre-commit` | Run lint and format on all files                  |
| `make clean`      | Remove build artifacts                            |
| `make db-inspect` | Open Drizzle Studio to inspect database           |

## Publishing

To publish a new version:

1. Update version in `package.json`
2. Create a new release with the respective tag

The GitHub Actions release workflow will automatically build binaries for all platforms.

## Installing Pre-release Versions

To install a pre-release candidate (e.g., `v0.1.4-rc.1`):

```bash
bash <(curl -fsSL https://www.damianb.dev/proton-drive-sync/install.sh) --version v0.1.4-rc.1
```

The version must include the `v` prefix and match an existing GitHub release tag.
