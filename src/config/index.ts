import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

export interface Config {
  discordToken: string;
  discordClientId: string;
  databaseUrl: string;
  wareraApiKey: string;
  wareraApiBaseUrl: string;
  port: number;
  internalApiKey?: string;
  discordClientSecret?: string;
  sessionSecret?: string;
  dashboardBaseUrl: string;
}

const getEnvOrThrow = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const config: Config = {
  discordToken: getEnvOrThrow('DISCORD_TOKEN'),
  discordClientId: getEnvOrThrow('DISCORD_CLIENT_ID'),
  databaseUrl: getEnvOrThrow('DATABASE_URL'),
  wareraApiKey: getEnvOrThrow('WARERA_API_KEY'),
  wareraApiBaseUrl: process.env.WARERA_API_BASE_URL || 'https://api2.warera.io/trpc/',
  port: parseInt(process.env.PORT || '10000', 10),
  internalApiKey: process.env.INTERNAL_API_KEY || process.env.API_SECRET_KEY,
  // Dashboard is OPTIONAL: intentionally NOT using getEnvOrThrow here. The bot must keep
  // booting normally even if these are never set — the dashboard routes simply stay
  // disabled (see src/dashboard/index.ts) until an admin configures them.
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET,
  sessionSecret: process.env.SESSION_SECRET,
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || `http://localhost:${parseInt(process.env.PORT || '10000', 10)}`,
};
