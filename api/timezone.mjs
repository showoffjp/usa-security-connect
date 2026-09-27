/**
 * The self-contained demo (a deployment with no database configured) runs on
 * Eastern time, so its shift times and "today" read as they would in Florida
 * rather than in the server's UTC. A deployment with a database is left as
 * configured; set TZ on the project to change it there.
 * Imported first by index.mjs so it applies before anything reads a date.
 */
if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.TZ?.replace(/^:?UTC$/, '')) {
  process.env.TZ = 'America/New_York';
}
