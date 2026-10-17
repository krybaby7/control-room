import { integer, sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  userId: text('user_id').primaryKey().notNull(),
  content: text('content').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workspaceMutations = sqliteTable('workspace_mutations', {
  userId: text('user_id').notNull(),
  mutationId: text('mutation_id').notNull(),
  commandHash: text('command_hash').notNull(),
  revision: integer('revision').notNull(),
  committedAt: text('committed_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.mutationId] })]);

export const workspaceRecovery = sqliteTable('workspace_recovery', {
  userId: text('user_id').primaryKey().notNull(),
  content: text('content').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: text('updated_at').notNull(),
});
