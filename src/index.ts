// --- Maximum-visibility crash instrumentation ---------------------------
// These run BEFORE any other import in this file. If the process dies with
// zero output on some hosts, it's usually because: (a) a synchronous throw
// during module load happened before the logger was ready, or (b) the
// panel's console doesn't reliably surface stderr / a pino async transport
// that never got to flush before the process exited. Raw process.stdout.write
// bypasses all of that — it is unbuffered and synchronous.
process.stdout.write('[BOOT] index.ts: module evaluation started\n');

process.on('uncaughtException', (err) => {
  process.stdout.write(`[FATAL] uncaughtException: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  process.stdout.write(`[FATAL] unhandledRejection: ${msg}\n`);
  process.exit(1);
});

// discord/client.ts transitively imports every command/service in the
// project — if ANY of them throws during module load (e.g. a missing env
// var read at import time, a bad top-level constant), this is where it
// would happen. Loading it via require() inside a try/catch (rather than a
// top-level `import`, which cannot be caught) pinpoints it explicitly
// instead of leaving a bare, possibly-invisible crash.
process.stdout.write('[BOOT] index.ts: loading ./config...\n');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require('./config');
process.stdout.write('[BOOT] index.ts: ./config loaded OK\n');

if (config.databaseUrl && config.databaseUrl.includes('localhost')) {
  process.stdout.write(
    '[FATAL] DATABASE_URL contains "localhost" — this will NEVER work on Wispbyte (there is no ' +
    'Postgres server inside this container). This means either a stray .env file with a ' +
    'placeholder value is being loaded, or the DATABASE_URL environment variable in the Wispbyte ' +
    'panel itself is wrong. Set DATABASE_URL to your real Supabase Session Pooler connection ' +
    'string in the Wispbyte panel, then restart.\n'
  );
  process.exit(1);
}
if (config.databaseUrl && config.databaseUrl.includes('your_password')) {
  process.stdout.write(
    '[FATAL] DATABASE_URL still contains the literal placeholder "your_password" — a template ' +
    'value is being used instead of your real connection string. Check the Wispbyte panel\'s ' +
    'DATABASE_URL variable.\n'
  );
  process.exit(1);
}

process.stdout.write('[BOOT] index.ts: loading ./database (instantiates PrismaClient)...\n');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('./database');
process.stdout.write('[BOOT] index.ts: ./database loaded OK\n');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger } = require('./utils/logger');
process.stdout.write('[BOOT] index.ts: loading ./server (also pulls in ./dashboard/router)...\n');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startHealthServer } = require('./server');
process.stdout.write('[BOOT] index.ts: ./server loaded OK\n');

process.stdout.write('[BOOT] index.ts: loading ./discord/client (pulls in every command/service)...\n');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDiscordBot } = require('./discord/client');
process.stdout.write('[BOOT] index.ts: ./discord/client loaded OK\n');

// Type-only import — erased entirely at compile time, so it cannot affect
// runtime execution order or hoisting the way a value import would.
import type { Client } from 'discord.js';

process.stdout.write('[BOOT] index.ts: all imports resolved, entering bootstrap()\n');

async function bootstrap() {
  logger.info('Starting WarEra Discord Bot...');
  
  // 1. Start HTTP health check server immediately so Render detects the open port without delay
  let client: Client | null = null;
  const httpServer = startHealthServer({
    port: config.port,
    isReady: () => client?.isReady() ?? false,
    getClient: () => client,
  });

  try {
    client = await initDiscordBot();

    // Graceful Shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down gracefully...');
      
      try {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        logger.info('HTTP health check server closed.');
      } catch (err) {
        logger.error({ err }, 'Error closing HTTP server');
      }

      try {
        if (client) {
          await client.destroy();
          logger.info('Discord client disconnected.');
        }
      } catch (err) {
        logger.error({ err }, 'Error disconnecting Discord client');
      }

      try {
        await prisma.$disconnect();
        logger.info('Prisma Database disconnected.');
      } catch (err) {
        logger.error({ err }, 'Error disconnecting database');
      }

      logger.info('Shutdown complete. Exiting process.');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.fatal({ error: (error as Error).message }, 'Failed to bootstrap application');
    process.exit(1);
  }
}

bootstrap();
