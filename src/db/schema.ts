/**
 * Proton Drive Sync - Database Schema
 *
 * Drizzle ORM schema for SQLite state storage.
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Clocks table for storing per-directory watchman clocks.
 */
export const clocks = sqliteTable('clocks', {
    directory: text('directory').primaryKey(),
    clock: text('clock').notNull(),
});

/**
 * Signals table for inter-process communication queue.
 */
export const signals = sqliteTable('signals', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    signal: text('signal').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
        .notNull()
        .$defaultFn(() => new Date()),
});
