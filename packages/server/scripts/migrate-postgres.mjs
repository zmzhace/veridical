import { migratePostgres } from '../src/production/storage.ts';

const url = process.env.VERIDICAL_POSTGRES_URL;
if (!url) {
  console.error('VERIDICAL_POSTGRES_URL is required');
  process.exit(2);
}
try {
  await migratePostgres(url);
  console.log('PostgreSQL migration applied');
} catch (error) {
  console.error(
    'PostgreSQL migration failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}
