#!/bin/bash
# Setup GPG for package signing in CI environment
# Required environment variables:
#   GPG_PRIVATE_KEY - ASCII-armored GPG private key
#
# Exports:
#   GPG_KEY_ID - The key ID for use in signing commands

set -euo pipefail

if [[ -z "${GPG_PRIVATE_KEY:-}" ]]; then
	echo "Error: GPG_PRIVATE_KEY environment variable is required"
	exit 1
fi

# Import the GPG private key
echo "${GPG_PRIVATE_KEY}" | gpg --batch --import

# Extract and export the key ID
GPG_KEY_ID=$(gpg --list-secret-keys --keyid-format LONG | grep sec | head -1 | awk '{print $2}' | cut -d'/' -f2)
echo "GPG_KEY_ID=${GPG_KEY_ID}" >>"$GITHUB_ENV"

# Configure gpg-agent for non-interactive signing
mkdir -p ~/.gnupg
chmod 700 ~/.gnupg
echo "allow-preset-passphrase" >>~/.gnupg/gpg-agent.conf
echo "pinentry-mode loopback" >>~/.gnupg/gpg.conf
gpg-connect-agent reloadagent /bye

# Configure RPM macros for signing
cat >~/.rpmmacros <<'EOF'
%_signature gpg
%_gpg_name Proton Drive Sync Release Signing
%__gpg_sign_cmd %{__gpg} gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 -u "%{_gpg_name}" -sbo %{__signature_filename} %{__plaintext_filename}
EOF

echo "GPG setup complete. Key ID: ${GPG_KEY_ID}"
