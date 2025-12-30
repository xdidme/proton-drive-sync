#Requires -Version 5.1
<#
.SYNOPSIS
    Installs Proton Drive Sync on Windows

.DESCRIPTION
    Downloads and installs proton-drive-sync and Watchman, configures PATH,
    and guides user through authentication.

.PARAMETER Version
    Specific version to install (e.g., "v0.1.6"). Defaults to latest.

.PARAMETER NoModifyPath
    Skip modifying the PATH environment variable.

.EXAMPLE
    irm https://www.damianb.dev/proton-drive-sync/install.ps1 | iex

.EXAMPLE
    .\install.ps1 -Version "v0.1.6" -NoModifyPath
#>

param(
    [string]$Version = "",
    [switch]$NoModifyPath = $false
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # Speeds up Invoke-WebRequest

# ============================================================================
# Configuration
# ============================================================================

$APP = "proton-drive-sync"
$REPO = "damianb-bitflipper/proton-drive-sync"
$INSTALL_DIR = "$env:LOCALAPPDATA\$APP"
$BIN_DIR = "$INSTALL_DIR\bin"
$WATCHMAN_DIR = "$INSTALL_DIR\watchman"

# ============================================================================
# Helper Functions
# ============================================================================

function Write-Step {
    param([string]$Message)
    Write-Host "`n=> $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Test-Command {
    param([string]$Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Open-Browser {
    param([string]$Url)
    try {
        Start-Process $Url
    }
    catch {
        Write-Warn "Could not open browser. Please visit: $Url"
    }
}

# ============================================================================
# Pre-flight Checks
# ============================================================================

Write-Host @"

  ____            _                ____       _             ____                   
 |  _ \ _ __ ___ | |_ ___  _ __   |  _ \ _ __(_)_   _____  / ___| _   _ _ __   ___ 
 | |_) | '__/ _ \| __/ _ \| '_ \  | | | | '__| \ \ / / _ \ \___ \| | | | '_ \ / __|
 |  __/| | | (_) | || (_) | | | | | |_| | |  | |\ V /  __/  ___) | |_| | | | | (__ 
 |_|   |_|  \___/ \__\___/|_| |_| |____/|_|  |_| \_/ \___| |____/ \__, |_| |_|\___|
                                                                  |___/            
                                                                   
"@ -ForegroundColor Magenta

Write-Host "Windows Installer" -ForegroundColor White
Write-Host ""

# Check architecture
if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Host "Error: Only 64-bit Windows is supported" -ForegroundColor Red
    exit 1
}

Write-Step "Detected Windows x64"

# ============================================================================
# Create Directories
# ============================================================================

Write-Step "Creating installation directories..."

New-Item -ItemType Directory -Force -Path $BIN_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $WATCHMAN_DIR | Out-Null

Write-Success "Created $INSTALL_DIR"

# ============================================================================
# Install Watchman
# ============================================================================

Write-Step "Installing Watchman..."

try {
    # Get latest Watchman release
    $watchmanRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/facebook/watchman/releases/latest"
    $watchmanVersion = $watchmanRelease.tag_name
    $watchmanAsset = $watchmanRelease.assets | Where-Object { $_.name -like "*windows.zip" }
    
    if (-not $watchmanAsset) {
        throw "Could not find Windows Watchman release"
    }
    
    $watchmanUrl = $watchmanAsset.browser_download_url
    $watchmanZip = "$env:TEMP\watchman.zip"
    
    Write-Host "  Downloading Watchman $watchmanVersion..."
    Invoke-WebRequest -Uri $watchmanUrl -OutFile $watchmanZip
    
    Write-Host "  Extracting..."
    # Remove old watchman if exists
    if (Test-Path "$WATCHMAN_DIR\bin") {
        Remove-Item -Recurse -Force "$WATCHMAN_DIR\*"
    }
    
    Expand-Archive -Path $watchmanZip -DestinationPath $env:TEMP -Force
    
    # Find the extracted folder (named like watchman-vYYYY.MM.DD.00-windows)
    $extractedDir = Get-ChildItem -Path $env:TEMP -Directory | Where-Object { $_.Name -like "watchman-*-windows" } | Select-Object -First 1
    
    if ($extractedDir) {
        # Create bin directory if needed
        New-Item -ItemType Directory -Force -Path "$WATCHMAN_DIR\bin" | Out-Null
        # Copy bin folder contents
        Copy-Item -Path "$($extractedDir.FullName)\bin\*" -Destination "$WATCHMAN_DIR\bin" -Recurse -Force
        Remove-Item -Recurse -Force $extractedDir.FullName
    }
    
    Remove-Item $watchmanZip -ErrorAction SilentlyContinue
    
    Write-Success "Watchman $watchmanVersion installed"
}
catch {
    Write-Warn "Warning: Failed to install Watchman: $_"
    Write-Warn "You may need to install Watchman manually from:"
    Write-Warn "https://github.com/facebook/watchman/releases"
}

# ============================================================================
# Install Proton Drive Sync
# ============================================================================

Write-Step "Installing Proton Drive Sync..."

try {
    # Get release (specific version or latest)
    if ($Version) {
        $releaseUrl = "https://api.github.com/repos/$REPO/releases/tags/$Version"
        Write-Host "  Fetching version $Version..."
    }
    else {
        $releaseUrl = "https://api.github.com/repos/$REPO/releases/latest"
        Write-Host "  Fetching latest version..."
    }
    
    $release = Invoke-RestMethod -Uri $releaseUrl
    $version = $release.tag_name
    $asset = $release.assets | Where-Object { $_.name -like "*windows-x64*" }
    
    if (-not $asset) {
        throw "Could not find Windows release asset"
    }
    
    $downloadUrl = $asset.browser_download_url
    $zipPath = "$env:TEMP\$APP.zip"
    
    Write-Host "  Downloading $APP $version..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath
    
    Write-Host "  Extracting..."
    Expand-Archive -Path $zipPath -DestinationPath $BIN_DIR -Force
    Remove-Item $zipPath
    
    Write-Success "Proton Drive Sync $version installed"
}
catch {
    Write-Host "Error: Failed to install Proton Drive Sync: $_" -ForegroundColor Red
    exit 1
}

# ============================================================================
# Update PATH
# ============================================================================

if (-not $NoModifyPath) {
    Write-Step "Updating PATH environment variable..."

    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $pathsToAdd = @($BIN_DIR, "$WATCHMAN_DIR\bin")
    $pathModified = $false

    foreach ($p in $pathsToAdd) {
        if ($userPath -notlike "*$p*") {
            $userPath = "$userPath;$p"
            $pathModified = $true
            Write-Host "  Added: $p"
        }
    }

    if ($pathModified) {
        [Environment]::SetEnvironmentVariable("PATH", $userPath, "User")
        # Update current session
        $env:Path = [Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH", "User")
        Write-Success "PATH updated"
    }
    else {
        Write-Host "  PATH already configured"
    }
}
else {
    Write-Warn "Skipping PATH modification (--NoModifyPath specified)"
    Write-Host "  Add these to your PATH manually:"
    Write-Host "    $BIN_DIR"
    Write-Host "    $WATCHMAN_DIR\bin"
}

# ============================================================================
# Verify Installation
# ============================================================================

Write-Step "Verifying installation..."

$binPath = "$BIN_DIR\$APP.exe"
if (-not (Test-Path $binPath)) {
    # Check if it was extracted without .exe extension
    $binPathNoExt = "$BIN_DIR\$APP"
    if (Test-Path $binPathNoExt) {
        Rename-Item -Path $binPathNoExt -NewName "$APP.exe"
    }
}

# Verify watchman
$watchmanPath = "$WATCHMAN_DIR\bin\watchman.exe"
if (Test-Path $watchmanPath) {
    Write-Success "Watchman: OK"
}
else {
    Write-Warn "Watchman: Not found (may need manual installation)"
}

# Verify proton-drive-sync
if (Test-Path "$BIN_DIR\$APP.exe") {
    Write-Success "Proton Drive Sync: OK"
}
else {
    Write-Host "Error: Installation verification failed" -ForegroundColor Red
    exit 1
}

# ============================================================================
# Authentication
# ============================================================================

Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor White
Write-Host ""

$response = Read-Host "Would you like to authenticate now? (Y/n)"
if ($response -eq '' -or $response -eq 'y' -or $response -eq 'Y') {
    Write-Host ""
    Write-Host "Starting authentication..." -ForegroundColor Cyan
    Write-Host "A browser window will open for you to log in to Proton." -ForegroundColor White
    Write-Host ""
    
    & "$BIN_DIR\$APP.exe" auth
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Success "Authentication successful!"
        Write-Host ""
        
        # Start the daemon
        Write-Step "Starting sync daemon..."
        & "$BIN_DIR\$APP.exe" start
        
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Daemon started!"
            
            # Open dashboard
            Write-Host ""
            Write-Host "Opening dashboard..." -ForegroundColor Cyan
            Start-Sleep -Seconds 2  # Give daemon time to start
            Open-Browser "http://localhost:4242"
            
            Write-Host ""
            Write-Host "Dashboard available at: http://localhost:4242" -ForegroundColor Green
            Write-Host ""
            Write-Host "Next steps:" -ForegroundColor Cyan
            Write-Host "  1. Add a directory to sync in the dashboard"
            Write-Host "  2. Or run: $APP config add <path>"
            Write-Host "  3. To run at startup: $APP service install"
        }
        else {
            Write-Warn "Could not start daemon automatically."
            Write-Host ""
            Write-Host "To start manually:" -ForegroundColor Cyan
            Write-Host "  1. Add a directory: $APP config add <path>"
            Write-Host "  2. Start syncing:   $APP start"
        }
    }
    else {
        Write-Warn "Authentication was not completed."
        Write-Host ""
        Write-Host "You can authenticate later by running: $APP auth" -ForegroundColor Yellow
    }
}
else {
    Write-Host ""
    Write-Host "You can authenticate later by running: $APP auth" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Quick start:" -ForegroundColor Cyan
    Write-Host "  1. Authenticate:     $APP auth"
    Write-Host "  2. Add a directory:  $APP config add <path>"
    Write-Host "  3. Start syncing:    $APP start"
    Write-Host "  4. Run at startup:   $APP service install"
}

Write-Host ""
