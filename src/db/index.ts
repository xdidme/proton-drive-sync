/**
 * Proton Drive Sync - Database Connection
 *
 * SQLite database using Drizzle ORM for state persistence.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { xdgState } from 'xdg-basedir';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

// ============================================================================
// Constants
// ============================================================================

if (!xdgState) {
    console.error('Could not determine XDG state directory');
    process.exit(1);
}

export const STATE_DIR = join(xdgState, 'proton-drive-sync');
const DB_PATH = join(STATE_DIR, 'state.db');

// ============================================================================
// Database Initialization
// ============================================================================

function initializeDatabase() {
    // Ensure state directory exists
    if (!existsSync(STATE_DIR)) {
        mkdirSync(STATE_DIR, { recursive: true });
    }

    const sqlite = new Database(DB_PATH);
    const db = drizzle(sqlite, { schema });

    // Run migrations from the compiled migrations folder
    const migrationsPath = new URL('./migrations', import.meta.url).pathname;
    migrate(db, { migrationsFolder: migrationsPath });

    return db;
}

export const db = initializeDatabase();
export { schema };
