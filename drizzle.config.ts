import { defineConfig } from 'drizzle-kit';

// TODO: fill in schema and migrations when db-schema-and-migrations (#4) is implemented
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/db/schema.ts', // will be created in #4
  out: './data/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? './data/app.db',
  },
});
