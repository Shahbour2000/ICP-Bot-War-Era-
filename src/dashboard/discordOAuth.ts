import { config } from '../config';

const DISCORD_API = 'https://discord.com/api/v10';

export function getRedirectUri(): string {
  return `${config.dashboardBaseUrl}/dashboard/callback`;
}

export function getAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.discordClientId,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  if (!config.discordClientSecret) {
    throw new Error('DISCORD_CLIENT_SECRET is not configured.');
  }
  const body = new URLSearchParams({
    client_id: config.discordClientId,
    client_secret: config.discordClientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Discord token exchange failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<TokenResponse>;
}

export interface DiscordUser {
  id: string;
  username: string;
  avatar: string | null;
}

export async function getDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Discord identity (${res.status})`);
  }
  return res.json() as Promise<DiscordUser>;
}

export interface DiscordUserGuild {
  id: string;
  name: string;
  icon: string | null;
  /** Decimal-string permission bitfield for THIS user in THIS guild. */
  permissions: string;
}

/**
 * Fetches the guilds the authenticated user is a member of, each annotated
 * with that user's own permission bitfield — this is what lets us determine
 * "can this person configure this server" without ever needing the bot's
 * own token or trusting anything the browser sends us.
 */
export async function getUserGuilds(accessToken: string): Promise<DiscordUserGuild[]> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch user guilds (${res.status})`);
  }
  return res.json() as Promise<DiscordUserGuild[]>;
}
