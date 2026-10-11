import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
import { getDatabaseUrl } from './src/db/config';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/**/*.ts',
  out: './drizzle',
  schemaFilter: ['commitmentos'],
  dbCredentials: {
    url: getDatabaseUrl(),
  },
});
