#!/usr/bin/env bash
set -euo pipefail
APP=proton-drive-sync

MUTED='\033[0;2m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Prompt for yes/no input, re-prompting until valid
# Usage: prompt_yn "Your question here" [y|n]
# Second arg is the recommended default (shown as [Y/n] or [y/N])
# Returns: 0 for yes, 1 for no
prompt_yn() {
	local prompt="$1"
	local recommended="${2:-}"
	local hint="(y/n)"

	if [[ "$recommended" == "y" ]]; then
		hint="[Y/n]"
	elif [[ "$recommended" == "n" ]]; then
		hint="[y/N]"
	fi

	local response
	while true; do
		read -r -p "$prompt $hint: " response
		case "$response" in
		[Yy]) return 0 ;;
		[Nn]) return 1 ;;
		*) echo "Please enter 'y' or 'n'." ;;
		esac
	done
}

INSTALL_DIR="$HOME/.local/bin"

# Detect OS
raw_os=$(uname -s)
case "$raw_os" in
Darwin*) os="darwin" ;;
Linux*) os="linux" ;;
*) os="unknown" ;;
esac

# Detect architecture
arch=$(uname -m)
if [[ "$arch" == "aarch64" ]]; then
	arch="arm64"
fi
if [[ "$arch" == "x86_64" ]]; then
	arch="x64"
fi

echo -e ""
echo -e "${MUTED}Uninstalling Proton Drive Sync...${NC}"
echo -e ""

# Uninstall service files if proton-drive-sync exists
if [[ -f "$INSTALL_DIR/$APP" ]]; then
	echo -e "${MUTED}Removing service files...${NC}"
	if [ "$os" = "linux" ]; then
		# Check if system service exists, use sudo directly if so
		if [[ -f "/etc/systemd/system/$APP.service" ]]; then
			sudo "$INSTALL_DIR/$APP" service uninstall -y 2>/dev/null || true
		else
			"$INSTALL_DIR/$APP" service uninstall -y 2>/dev/null || true
		fi
	else
		# macOS - just run normally
		"$INSTALL_DIR/$APP" service uninstall -y 2>/dev/null || true
	fi
fi

# Remove the binary
if [[ -f "$INSTALL_DIR/$APP" ]]; then
	rm -f "$INSTALL_DIR/$APP"
	echo -e "${MUTED}Removed ${NC}$INSTALL_DIR/$APP"
else
	echo -e "${MUTED}Binary not found at $INSTALL_DIR/$APP${NC}"
fi

# Linux-specific cleanup
if [ "$os" = "linux" ]; then
	# Remove system-level directories if they exist
	if [[ -d "/etc/proton-drive-sync" ]]; then
		sudo rm -rf /etc/proton-drive-sync
		echo -e "${MUTED}Removed ${NC}/etc/proton-drive-sync"
	fi
	if [[ -d "/var/lib/proton-drive-sync" ]]; then
		sudo rm -rf /var/lib/proton-drive-sync
		echo -e "${MUTED}Removed ${NC}/var/lib/proton-drive-sync"
	fi

fi

echo -e ""
echo -e "${MUTED}Proton Drive Sync${NC} uninstalled successfully!"
echo -e ""

# ============================================================================
# Remove PATH from shell config
# ============================================================================

remove_from_path() {
	local config_file=$1

	if [[ ! -f "$config_file" ]]; then
		return
	fi

	# Check if our PATH entry exists in the file
	if grep -q "# proton-drive-sync" "$config_file"; then
		echo -e "${MUTED}Removing PATH entry from ${NC}$config_file"
		# Remove the comment line and the following export/fish_add_path line
		# Use sed to remove both lines (the comment and the PATH line that follows)
		if [[ "$os" == "darwin" ]]; then
			# macOS sed requires backup extension with -i
			sed -i '' '/# proton-drive-sync/{N;d;}' "$config_file"
		else
			# GNU sed
			sed -i '/# proton-drive-sync/{N;d;}' "$config_file"
		fi
	fi
}

XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}

current_shell=$(basename "$SHELL")
case $current_shell in
fish)
	config_files="$HOME/.config/fish/config.fish"
	;;
zsh)
	config_files="$HOME/.zshrc $HOME/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv"
	;;
bash)
	config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
	;;
ash)
	config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
	;;
sh)
	config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
	;;
*)
	config_files="$HOME/.bashrc $HOME/.bash_profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
	;;
esac

for file in $config_files; do
	remove_from_path "$file"
done

# Prompt user about config and data directories
CONFIG_DIR="$HOME/.config/proton-drive-sync"
STATE_DIR="$HOME/.local/state/proton-drive-sync"

if [[ -d "$CONFIG_DIR" ]] || [[ -d "$STATE_DIR" ]]; then
	if prompt_yn "Delete your configuration settings and sync history?" "n"; then
		[[ -d "$CONFIG_DIR" ]] && rm -rf "$CONFIG_DIR" && echo -e "${MUTED}Removed${NC} $CONFIG_DIR"
		[[ -d "$STATE_DIR" ]] && rm -rf "$STATE_DIR" && echo -e "${MUTED}Removed${NC} $STATE_DIR"
	fi
	echo -e ""
fi

# Note about Linux packages
if [ "$os" = "linux" ]; then
	echo -e ""
	echo -e "${MUTED}Note: The following packages were installed as dependencies and may be${NC}"
	echo -e "${MUTED}used by other applications. Remove them manually if no longer needed:${NC}"
	echo -e "${MUTED}  sudo apt remove libsecret-1-0 jq${NC}"
fi

echo -e ""
