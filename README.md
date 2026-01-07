# Proton Drive Sync

Automatically syncs selected local folders to Proton Drive in the background, with a dashboard for monitoring.

<p align="center">

https://github.com/user-attachments/assets/bf1fccac-9a08-4da1-bc0c-2c06d510fbf1

</p>

## Installation

### macOS (Homebrew)

```bash
brew tap DamianB-BitFlipper/tap
brew install proton-drive-sync
proton-drive-sync setup
```

### Debian / Ubuntu

Download the appropriate `.deb` file for your architecture from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases).

```bash
# For amd64:
sudo apt install ./proton-drive-sync_amd64.deb

# For arm64:
sudo apt install ./proton-drive-sync_arm64.deb

proton-drive-sync setup
```

### Fedora / RHEL / CentOS

Download the appropriate `.rpm` file for your architecture from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases).

```bash
# For x86_64:
sudo dnf install ./proton-drive-sync.x86_64.rpm

# For aarch64:
sudo dnf install ./proton-drive-sync.aarch64.rpm

proton-drive-sync setup
```

<details>
<summary>Other Linux</summary>

Download the Linux tarball from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases/latest):

```bash
tar -xzf proton-drive-sync-linux-x64.tar.gz
sudo mv proton-drive-sync /usr/local/bin/
proton-drive-sync setup
```

</details>

<details>
<summary>Windows</summary>

Download the `.zip` from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases/latest), extract, and add to your PATH.

</details>

<details>
<summary>Docker (WIP)</summary>

See **[DOCKER_SETUP.md](DOCKER_SETUP.md)** for running with Docker Compose on Linux x86_64 and ARM64.

```bash
cd docker/
cp .env.example .env
# Edit .env with KEYRING_PASSWORD and sync directory paths
docker compose up -d
docker exec -it proton-drive-sync proton-drive-sync auth
```

</details>

## Usage

### Dashboard

The dashboard runs locally at http://localhost:4242. Use it to configure and manage the sync client.

### Commands

| Command                    | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `proton-drive-sync setup`  | Interactive setup wizard (recommended for first run) |
| `proton-drive-sync auth`   | Authenticate with Proton                             |
| `proton-drive-sync start`  | Start the sync daemon                                |
| `proton-drive-sync stop`   | Stop the sync daemon                                 |
| `proton-drive-sync status` | Show sync status                                     |
| `proton-drive-sync --help` | Show all available commands                          |

### Uninstall

To completely remove proton-drive-sync and all its data:

```bash
proton-drive-sync reset --purge
```

This will stop the service, remove credentials, and delete all configuration and sync history.

For package managers:

- **Homebrew**: `brew uninstall proton-drive-sync`
- **Debian/Ubuntu**: `sudo apt remove proton-drive-sync`
- **Fedora/RHEL**: `sudo dnf remove proton-drive-sync`

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for development setup and contributing guidelines.
