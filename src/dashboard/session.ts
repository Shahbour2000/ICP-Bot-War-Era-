import * as crypto from 'crypto';
import { config } from '../config';

/**
 * Stateless, signed dashboard session. Intentionally does NOT store the
 * Discord OAuth access token anywhere (not in the cookie, not in the
 * database) — only the minimum identity + permission snapshot needed to
 * render the guild list and re-validate access on every request. Signed
 * with HMAC-SHA256 using SESSION_SECRET so the client cannot forge or
 * tamper with it (e.g. inject a guild it doesn't actually have access to).
 */
export interface SessionGuild {
  id: string;
  name: string;
  /** Discord permission bitfield for this user in this guild, as a decimal string. */
  permissions: string;
}

export interface SessionPayload {
  discordId: string;
  username: string;
  avatar: string | null;
  guilds: SessionGuild[];
  /** Unix seconds expiry. */
  exp: number;
}

export const SESSION_COOKIE_NAME = 'dash_session';
export const OAUTH_STATE_COOKIE_NAME = 'dash_oauth_state';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signSession(payload: Omit<SessionPayload, 'exp'>): string {
  if (!config.sessionSecret) {
    throw new Error('SESSION_SECRET is not configured — dashboard sessions cannot be created.');
  }
  const full: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS };
  const body = base64url(JSON.stringify(full));
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token || !config.sessionSecret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  const expectedSig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload: SessionPayload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  });
  return out;
}

function cookieAttrs(maxAgeSeconds: number): string {
  return `HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure`;
}

export function serializeSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttrs(SESSION_MAX_AGE_SECONDS)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; ${cookieAttrs(0)}`;
}

export function serializeOAuthStateCookie(state: string): string {
  return `${OAUTH_STATE_COOKIE_NAME}=${encodeURIComponent(state)}; ${cookieAttrs(600)}`; // 10 min
}

export function clearOAuthStateCookie(): string {
  return `${OAUTH_STATE_COOKIE_NAME}=; ${cookieAttrs(0)}`;
}
