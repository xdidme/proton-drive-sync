/**
 * Proton Drive Sync - Cross-platform Path Helpers
 *
 * Provides consistent paths across macOS, Linux, and Windows:
 * - macOS/Linux: Uses XDG Base Directory specification
 * - Windows: Uses %APPDATA% and %LOCALAPPDATA%
 */

import { join } from 'path';

/**
 * Get the configuration directory path.
 * - macOS/Linux: ~/.config/proton-drive-sync
 * - Windows: %APPDATA%\proton-drive-sync
 */
export function getConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error('APPDATA environment variable is not set');
    }
    return join(appData, 'proton-drive-sync');
  }

  // macOS/Linux: Use XDG Base Directory
  // Dynamic import not needed - xdg-basedir is safe to import, just returns null on Windows
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { xdgConfig } = require('xdg-basedir');
  if (!xdgConfig) {
    throw new Error('Could not determine XDG config directory');
  }
  return join(xdgConfig, 'proton-drive-sync');
}

/**
 * Get the state directory path (for database, logs, etc.).
 * - macOS/Linux: ~/.local/state/proton-drive-sync
 * - Windows: %LOCALAPPDATA%\proton-drive-sync
 */
export function getStateDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error('LOCALAPPDATA environment variable is not set');
    }
    return join(localAppData, 'proton-drive-sync');
  }

  // macOS/Linux: Use XDG Base Directory
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { xdgState } = require('xdg-basedir');
  if (!xdgState) {
    throw new Error('Could not determine XDG state directory');
  }
  return join(xdgState, 'proton-drive-sync');
}
