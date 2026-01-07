#!/usr/bin/env bash
set -euo pipefail
APP=proton-drive-sync
REPO="damianb-bitflipper/proton-drive-sync"
ASSETS_URL="https://www.damianb.dev/proton-drive-sync"

MUTED='\033[0;2m'
RED='\033[0;31m'
GREEN='\033[0;32m'
ORANGE='\033[38;5;214m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

show_banner() {
	echo -e "${CYAN}"
	cat <<'EOF'
  ____            _                ____       _              ____                   
 |  _ \ _ __ ___ | |_ ___  _ __   |  _ \ _ __(_)_   _____   / ___| _   _ _ __   ___ 
 | |_) | '__/ _ \| __/ _ \| '_ \  | | | | '__| \ \ / / _ \  \___ \| | | | '_ \ / __|
 |  __/| | | (_) | || (_) | | | | | |_| | |  | |\ V /  __/   ___) | |_| | | | | (__ 
 |_|   |_|  \___/ \__\___/|_| |_| |____/|_|  |_| \_/ \___|  |____/ \__, |_| |_|\___|
                                                                   |___/            
EOF
	echo -e "${NC}"
}

usage() {
	cat <<EOF
Proton Drive Sync Installer

Usage: install [options]

Options:
    -h, --help              Display this help message
    -v, --version <version> Install a specific version (e.g., v0.1.0)
        --no-modify-path    Don't modify shell config files (.zshrc, .bashrc, etc.)

Examples:
    bash <(curl -fsSL $ASSETS_URL/install.sh)
    bash <(curl -fsSL $ASSETS_URL/install.sh) --version v0.1.0
EOF
}

requested_version=${VERSION:-}
no_modify_path=false

while [[ $# -gt 0 ]]; do
	case "$1" in
	-h | --help)
		usage
		exit 0
		;;
	-v | --version)
		if [[ -n "${2:-}" ]]; then
			requested_version="$2"
			shift 2
		else
			echo -e "${RED}Error: --version requires a version argument${NC}"
			exit 1
		fi
		;;
	--no-modify-path)
		no_modify_path=true
		shift
		;;
	*)
		echo -e "${ORANGE}Warning: Unknown option '$1'${NC}" >&2
		shift
		;;
	esac
done

raw_os=$(uname -s)
os=$(echo "$raw_os" | tr '[:upper:]' '[:lower:]')
case "$raw_os" in
Darwin*) os="darwin" ;;
Linux*) os="linux" ;;
MINGW* | MSYS* | CYGWIN*) os="windows" ;;
esac

arch=$(uname -m)
if [[ "$arch" == "aarch64" ]]; then
	arch="arm64"
fi
if [[ "$arch" == "x86_64" ]]; then
	arch="x64"
fi

# Rosetta detection (macOS only)
show_banner
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
	rosetta_flag=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
	if [ "$rosetta_flag" = "1" ]; then
		arch="arm64"
	fi
fi

# Validate OS/arch combination
combo="$os-$arch"
case "$combo" in
darwin-x64 | darwin-arm64 | linux-x64 | linux-arm64) ;;
*)
	echo -e "${RED}Unsupported platform: $combo${NC}"
	echo -e "${MUTED}Supported platforms: macOS (x64, arm64), Linux (x64, arm64)${NC}"
	exit 1
	;;
esac

archive_ext=".tar.gz"

target="$os-$arch"
filename="$APP-$target$archive_ext"

if ! command -v tar >/dev/null 2>&1; then
	echo -e "${RED}Error: 'tar' is required but not installed.${NC}"
	exit 1
fi

# ============================================================================
# Install dependencies (Linux only)
# ============================================================================

install_linux_dependencies() {
	if [ "$os" != "linux" ]; then
		return
	fi

	echo -e "${MUTED}Installing dependencies (libsecret, jq)...${NC}"

	if command -v apt-get >/dev/null 2>&1; then
		sudo apt-get update
		sudo apt-get install -y libsecret-1-0 jq
	elif command -v dnf >/dev/null 2>&1; then
		sudo dnf install -y libsecret jq
	elif command -v pacman >/dev/null 2>&1; then
		sudo pacman -Sy --noconfirm libsecret jq
	else
		echo -e "${ORANGE}Warning: Could not install dependencies automatically${NC}"
		echo -e "${MUTED}Please install libsecret and jq manually${NC}"
	fi
}

# Install Linux dependencies (libsecret, jq) before any proton-drive-sync commands
# These are required for the binary to even start on Linux
install_linux_dependencies

INSTALL_DIR=$HOME/.local/bin
mkdir -p "$INSTALL_DIR"

if [ -z "$requested_version" ]; then
	url="https://github.com/$REPO/releases/latest/download/$filename"
	# Extract version from redirect URL to avoid GitHub API rate limits
	redirect_url=$(curl -sIL -o /dev/null -w "%{url_effective}" "https://github.com/$REPO/releases/latest" 2>/dev/null)
	specific_version=$(echo "$redirect_url" | sed -n 's|.*/tag/v\([^/]*\)$|\1|p')

	if [[ -z "$specific_version" ]]; then
		echo -e "${RED}Failed to fetch version information${NC}"
		echo -e "${MUTED}Could not determine latest version from: $redirect_url${NC}"
		echo -e "${MUTED}Try specifying a version manually: --version 0.1.0${NC}"
		exit 1
	fi
else
	# Validate version format (must start with 'v')
	if [[ ! "$requested_version" =~ ^v[0-9] ]]; then
		echo -e "${RED}Error: Version must start with 'v' (e.g., v0.1.0)${NC}"
		exit 1
	fi
	url="https://github.com/$REPO/releases/download/${requested_version}/$filename"
	specific_version=${requested_version#v}
fi

print_message() {
	local level=$1
	local message=$2
	local color=""

	case $level in
	info) color="${NC}" ;;
	warning) color="${NC}" ;;
	error) color="${RED}" ;;
	esac

	echo -e "${color}${message}${NC}"
}

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

skip_download=false

check_version() {
	if [ -x "$INSTALL_DIR/proton-drive-sync" ]; then
		installed_version=$("$INSTALL_DIR/proton-drive-sync" --version 2>/dev/null || echo "0.0.0")
		installed_version=$(echo "$installed_version" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "0.0.0")

		if [[ "$installed_version" != "$specific_version" ]]; then
			print_message info "${MUTED}Installed version: ${NC}$installed_version"
		else
			print_message info "${MUTED}Version ${NC}$specific_version${MUTED} already installed${NC}"
			skip_download=true
		fi
	fi
}

download_and_install() {
	print_message info "\n${MUTED}Installing ${NC}proton-drive-sync ${MUTED}version: ${NC}$specific_version"
	local tmp_dir="${TMPDIR:-/tmp}/proton_drive_sync_install_$$"
	mkdir -p "$tmp_dir"

	curl -# -L -o "$tmp_dir/$filename" "$url"

	tar -xzf "$tmp_dir/$filename" -C "$tmp_dir"

	mv "$tmp_dir/proton-drive-sync" "$INSTALL_DIR/"
	chmod 755 "${INSTALL_DIR}/proton-drive-sync"
	rm -rf "$tmp_dir"
}

check_version
if [[ "$skip_download" != "true" ]]; then
	download_and_install
fi

add_to_path() {
	local config_file=$1
	local command=$2

	if grep -Fxq "$command" "$config_file"; then
		print_message info "Command already exists in $config_file, skipping write."
	elif [[ -w $config_file ]]; then
		echo -e "\n# proton-drive-sync" >>"$config_file"
		echo "$command" >>"$config_file"
		print_message info "${MUTED}Successfully added ${NC}proton-drive-sync ${MUTED}to \$PATH in ${NC}$config_file"
	else
		print_message warning "Manually add the directory to $config_file (or similar):"
		print_message info "  $command"
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

if [[ "$no_modify_path" != "true" ]]; then
	config_file=""
	for file in $config_files; do
		if [[ -f $file ]]; then
			config_file=$file
			break
		fi
	done

	if [[ -z $config_file ]]; then
		print_message warning "No config file found for $current_shell. You may need to manually add to PATH:"
		print_message info "  export PATH=$INSTALL_DIR:\$PATH"
	elif [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
		case $current_shell in
		fish)
			add_to_path "$config_file" "fish_add_path $INSTALL_DIR"
			;;
		zsh | bash | ash | sh)
			add_to_path "$config_file" "export PATH=$INSTALL_DIR:\$PATH"
			;;
		*)
			export PATH=$INSTALL_DIR:$PATH
			print_message warning "Manually add the directory to $config_file (or similar):"
			print_message info "  export PATH=$INSTALL_DIR:\$PATH"
			;;
		esac
	fi
fi

# Verify proton-drive-sync is found
if [ ! -x "$INSTALL_DIR/proton-drive-sync" ]; then
	echo -e "${RED}Error: proton-drive-sync not found at $INSTALL_DIR after installation${NC}"
	exit 1
fi

echo -e ""
echo -e "${MUTED}Proton Drive Sync${NC} installed successfully!"
echo -e ""

# ============================================================================
# Remote Dashboard Configuration (config only, no keyring setup)
# ============================================================================

echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${CYAN}Remote Dashboard Access${NC}"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e ""
echo -e "  The dashboard is available at ${NC}localhost:4242${MUTED} by default.${NC}"
echo -e ""
echo -e "  For headless/server installs, you can enable remote access by binding"
echo -e "  the web interface to all network interfaces (0.0.0.0:4242)."
echo -e ""
echo -e "  ${ORANGE}WARNING: This exposes the dashboard to your network.${NC}"
echo -e "  ${MUTED}The dashboard allows service control and configuration changes.${NC}"
echo -e "  ${MUTED}Only enable this on trusted networks or behind a firewall.${NC}"
echo -e ""
DASHBOARD_HOST="127.0.0.1"
if prompt_yn "  Enable remote dashboard access?" "n"; then
	DASHBOARD_HOST="0.0.0.0"
	echo -e ""
	echo -e "  ${MUTED}Enabling remote dashboard access...${NC}"
	"$INSTALL_DIR/proton-drive-sync" config --set dashboard_host=0.0.0.0
else
	echo -e ""
	echo -e "  ${MUTED}Keeping dashboard local-only (localhost:4242)...${NC}"
	"$INSTALL_DIR/proton-drive-sync" config --set dashboard_host=127.0.0.1
fi

# ============================================================================
# Service Installation (before auth on Linux to set up keyring)
# ============================================================================

echo -e ""
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${CYAN}Service Installation${NC}"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e ""

SERVICE_INSTALLED=false

if [ "$os" = "linux" ]; then
	echo -e "  When should the sync service start?"
	echo -e ""
	echo -e "    ${CYAN}0)${NC} Don't start automatically - manual start only"
	echo -e "    ${CYAN}1)${NC} On login (user service) - runs when you log in"
	echo -e "    ${CYAN}2)${NC} On boot (system service) - runs at system startup ${MUTED}(requires sudo)${NC}"
	echo -e ""
	read -p "  Choice [0/1/2]: " service_choice

	if [ "$service_choice" = "2" ]; then
		echo -e ""
		echo -e "  ${MUTED}Installing system service (requires sudo)...${NC}"
		if ! sudo "$INSTALL_DIR/proton-drive-sync" service install --install-scope=system; then
			echo -e ""
			echo -e "${RED}Service installation failed.${NC}"
			exit 1
		fi
		SERVICE_INSTALLED=true
	elif [ "$service_choice" = "1" ]; then
		echo -e ""
		echo -e "  ${MUTED}Installing user service...${NC}"
		if ! "$INSTALL_DIR/proton-drive-sync" service install; then
			echo -e ""
			echo -e "${RED}Service installation failed.${NC}"
			exit 1
		fi
		SERVICE_INSTALLED=true
	else
		echo -e ""
		echo -e "  ${MUTED}Skipping automatic startup.${NC}"
		echo -e "  ${MUTED}You can start manually with: proton-drive-sync start${NC}"
		echo -e "  ${MUTED}You can enable it later with: proton-drive-sync service install${NC}"
	fi
else
	# macOS - only user scope supported
	echo -e "  When should the sync service start?"
	echo -e ""
	echo -e "    ${CYAN}0)${NC} Don't start automatically - manual start only"
	echo -e "    ${CYAN}1)${NC} On login - runs when you log in"
	echo -e ""
	read -p "  Choice [0/1]: " service_choice

	if [ "$service_choice" = "1" ]; then
		echo -e ""
		echo -e "  ${MUTED}Installing service...${NC}"
		if ! "$INSTALL_DIR/proton-drive-sync" service install; then
			echo -e ""
			echo -e "${RED}Service installation failed.${NC}"
			exit 1
		fi
		SERVICE_INSTALLED=true
	else
		echo -e ""
		echo -e "  ${MUTED}Skipping automatic startup.${NC}"
		echo -e "  ${MUTED}You can start manually with: proton-drive-sync start${NC}"
		echo -e "  ${MUTED}You can enable it later with: proton-drive-sync service install${NC}"
	fi
fi

# ============================================================================
# Authentication
# ============================================================================

echo -e ""
echo -e "${MUTED}Starting authentication...${NC}"
echo -e ""

# On Linux, set KEYRING_PASSWORD for file-based credential storage
# This must match the hardcoded password in the service file
if [ "$os" = "linux" ]; then
	export KEYRING_PASSWORD="proton-drive-sync"

	if ! "$INSTALL_DIR/proton-drive-sync" auth; then
		echo -e ""
		echo -e "${RED}Authentication failed or was cancelled.${NC}"
		echo -e "${MUTED}Run the install command again to retry.${NC}"
		exit 1
	fi
else
	# macOS - no KEYRING_PASSWORD needed, uses Keychain
	if ! "$INSTALL_DIR/proton-drive-sync" auth; then
		echo -e ""
		echo -e "${RED}Authentication failed or was cancelled.${NC}"
		echo -e "${MUTED}Run the install command again to retry.${NC}"
		exit 1
	fi
fi

# Open browser (platform-specific)
open_browser() {
	local url="$1"
	if [ "$os" = "darwin" ]; then
		open "$url"
	elif [ "$os" = "linux" ]; then
		if command -v xdg-open >/dev/null 2>&1; then
			xdg-open "$url" 2>/dev/null || echo -e "${MUTED}Open $url in your browser${NC}"
		else
			echo -e "${MUTED}Open $url in your browser${NC}"
		fi
	fi
}

# Wait for service to be ready
echo -e ""
echo -e "${MUTED}Waiting for service to start...${NC}"
max_attempts=30
attempt=0
port=4242
status=""

while [ $attempt -lt $max_attempts ]; do
	if status_json=$("$INSTALL_DIR/proton-drive-sync" status 2>/dev/null); then
		status=$(echo "$status_json" | jq -r '.status' 2>/dev/null) || true
		port=$(echo "$status_json" | jq -r '.port' 2>/dev/null) || true
		if [ "$status" = "running" ]; then
			break
		fi
	fi
	sleep 1
	attempt=$((attempt + 1))
done

if [ "$status" = "running" ]; then
	echo -e "${GREEN}✔${NC} Service started successfully"
	echo -e ""
	if [ "$DASHBOARD_HOST" != "0.0.0.0" ]; then
		echo -e "${MUTED}Opening dashboard...${NC}"
		open_browser "http://localhost:${port:-4242}"
	fi
else
	echo -e "${RED}Warning: Service did not start within 30 seconds${NC}"
	echo -e "${MUTED}Check logs with: proton-drive-sync logs${NC}"
fi

echo -e ""
echo -e "${MUTED}Complete your configuration by visiting the dashboard at:${NC}"
echo -e ""
if [ "$DASHBOARD_HOST" = "0.0.0.0" ]; then
	# Try to get local IP address
	if [ "$os" = "darwin" ]; then
		LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "your-server-ip")
	else
		LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "your-server-ip")
	fi
	echo -e "  http://${LOCAL_IP}:4242"
	echo -e "  ${MUTED}(Also accessible at http://localhost:4242 on this machine)${NC}"
else
	echo -e "  http://localhost:4242"
fi
echo -e ""
