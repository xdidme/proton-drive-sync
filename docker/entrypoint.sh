#!/bin/bash
set -e

# Ensure directories exist
mkdir -p /config/proton-drive-sync /state/proton-drive-sync

# Handle graceful shutdown
cleanup() {
	echo "Shutting down..."
	proton-drive-sync stop 2>/dev/null || true
	exit 0
}
trap cleanup SIGTERM SIGINT

# Start sync in foreground (no daemon mode)
echo "Starting Proton Drive Sync..."
exec proton-drive-sync start --no-daemon "$@"
