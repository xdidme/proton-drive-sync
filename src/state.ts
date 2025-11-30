/**
 * Proton Drive Sync - State Management
 *
 * Persists sync state to ~/.local/state/proton-drive-sync/state.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { xdgState } from 'xdg-basedir';

// ============================================================================
// Types
// ============================================================================

export interface StateData {
    clock: string | null;
}

// ============================================================================
// Constants
// ============================================================================

if (!xdgState) {
    console.error('Could not determine XDG state directory');
    process.exit(1);
}

const STATE_DIR = join(xdgState, 'proton-drive-sync');
const STATE_FILE = join(STATE_DIR, 'state.json');

// ============================================================================
// State Management
// ============================================================================

function loadState(): StateData {
    if (!existsSync(STATE_FILE)) {
        return { clock: null };
    }
    try {
        return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    } catch {
        return { clock: null };
    }
}

export function saveState(data: StateData): void {
    if (!existsSync(STATE_DIR)) {
        mkdirSync(STATE_DIR, { recursive: true });
    }
    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

export const appState = loadState();
