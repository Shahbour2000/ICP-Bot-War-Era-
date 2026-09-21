import * as http from 'http';
import * as crypto from 'crypto';
import { Client } from 'discord.js';
import { GuildConfigRepository } from '../repositories/guildConfig.repository';
import { RoleMappingService, ROLE_MAPPING_TYPES, isValidRoleMappingType } from '../services/roleMapping.service';
import { ProfileFlairService } from '../services/profileFlair.service';
import { ProfileFlairRepository } from '../repositories/profileFlair.repository';
import { WarEraService } from '../warera/service';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  parseCookies,
  signSession,
  verifySession,
  serializeSessionCookie,
  clearSessionCookie,
  serializeOAuthStateCookie,
  clearOAuthStateCookie,
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SessionPayload,
} from './session';
import { getAuthorizeUrl, exchangeCode, getDiscordUser, getUserGuilds } from './discordOAuth';
import { hasManageAccess } from './permissions';
import {
  renderLoginPage,
  renderGuildListPage,
  renderGuildSettingsPage,
  renderFlairListPage,
  renderFlairFormPage,
  GuildRowData,
  RoleOption,
  RoleFieldSpec,
} from './pages';

/** Every supported role mapping type, with a friendlier dashboard label. */
const ROLE_FIELD_LABELS: Record<string, string> = {
  CITIZEN_GATE: 'Citizen Gate (manual prerequisite)',
  TRUSTED_GATE: 'Trusted Gate (manual prerequisite)',
  VERIFIED_CITIZEN: 'Verified Citizen (automatic)',
  PRESIDENT: 'Country President',
  VICE_PRESIDENT: 'Vice President',
  CONGRESS: 'Congress Member',
  WAR_SPECIALIST: 'War Specialist',
  ECONOMY_SPECIALIST: 'Economy Specialist',
  HYBRID_SPECIALIST: 'Hybrid Specialist',
  OFFICER: 'Officer',
  MU_COMMANDER: 'MU Commander',
  MU_OWNER: 'MU Owner',
  NO_MU: 'No MU Yet',
  PARTY_PRESIDENT: 'Party President',
  PARTY_TREASURER: 'Party Treasurer',
  PARTY_COUNCIL: 'Party Council',
  PARTY_MEMBER: 'Party Member',
  EDUCATION_LEVEL_1: 'Education Level 1',
  EDUCATION_LEVEL_2: 'Education Level 2',
};
const ROLE_FIELDS: RoleFieldSpec[] = ROLE_MAPPING_TYPES.map((type) => ({
  key: type,
  label: ROLE_FIELD_LABELS[type] || type,
}));

export interface DashboardDeps {
  getClient: () => Client | null;
  guildConfigRepo: GuildConfigRepository;
  roleMappingService: RoleMappingService;
  profileFlairService: ProfileFlairService;
  profileFlairRepo: ProfileFlairRepository;
  wareraService: WarEraService;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendHtml(res: http.ServerResponse, status: number, html: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...(extraHeaders || {}) });
  res.end(html);
}

function redirect(
  res: http.ServerResponse,
  location: string,
  extraHeaders?: Record<string, string | string[]>
): void {
  res.writeHead(302, {
    Location: location,
    ...(extraHeaders || {}),
  });
  res.end();
}

/**
 * Re-derives the user's manage-access guild list from the SIGNED session
 * cookie only — never from anything the client passes in the URL or a form
 * field. Returns null if there is no valid session.
 */
function getSession(req: http.IncomingMessage): SessionPayload | null {
  const cookies = parseCookies(req.headers.cookie);
  return verifySession(cookies[SESSION_COOKIE_NAME]);
}

/**
 * Every /dashboard/guilds/:guildId(/...) route goes through this first:
 * re-validates the guild against the SIGNED session (never the URL alone),
 * then confirms the bot is actually present. This is the single choke point
 * every guild-scoped dashboard operation must pass through — never trust a
 * guildId supplied by the browser by itself.
 */
function requireGuildAccess(
  session: SessionPayload,
  guildId: string,
  deps: DashboardDeps
): { guild: NonNullable<ReturnType<Client['guilds']['cache']['get']>> } | { error: number; message: string } {
  const sessionGuild = session.guilds.find((g) => g.id === guildId);
  if (!sessionGuild) {
    return { error: 403, message: 'You do not have permission to configure this server.' };
  }
  const client = deps.getClient();
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) {
    return { error: 404, message: 'Bot not in this server. Add the bot to this server first, then come back.' };
  }
  return { guild };
}

export async function handleDashboardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: DashboardDeps
): Promise<void> {
  if (!config.discordClientSecret || !config.sessionSecret) {
    sendHtml(
      res,
      503,
      '<h1>Dashboard is not configured</h1><p>DISCORD_CLIENT_SECRET and SESSION_SECRET must be set to enable it.</p>'
    );
    return;
  }

  // --- /dashboard/login ---
  if (pathname === '/dashboard/login') {
    const state = crypto.randomBytes(24).toString('base64url');
    redirect(res, getAuthorizeUrl(state), { 'Set-Cookie': serializeOAuthStateCookie(state) });
    return;
  }

  // --- /dashboard/logout ---
  if (pathname === '/dashboard/logout') {
    redirect(res, '/dashboard/login', { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  // --- /dashboard/callback ---
  if (pathname === '/dashboard/callback') {
    const url = new URL(req.url || '', config.dashboardBaseUrl);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookies = parseCookies(req.headers.cookie);
    const expectedState = cookies[OAUTH_STATE_COOKIE_NAME];

    if (!code || !state || !expectedState || state !== expectedState) {
      sendHtml(res, 400, renderLoginPage('Login failed or expired — please try again.'), {
        'Set-Cookie': clearOAuthStateCookie(),
      });
      return;
    }

    try {
      const token = await exchangeCode(code);
      const [user, guilds] = await Promise.all([
        getDiscordUser(token.access_token),
        getUserGuilds(token.access_token),
      ]);

      const manageable = guilds.filter((g) => hasManageAccess(g.permissions));
      const sessionToken = signSession({
        discordId: user.id,
        username: user.username,
        avatar: user.avatar,
        guilds: manageable.map((g) => ({ id: g.id, name: g.name, permissions: g.permissions })),
      });

      logger.info({ discordId: user.id, guildCount: manageable.length }, 'Dashboard: user logged in');

      redirect(res, '/dashboard', {
  'Set-Cookie': [
    serializeSessionCookie(sessionToken),
    clearOAuthStateCookie(),
  ],
});
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Dashboard: OAuth callback failed');
      sendHtml(res, 500, renderLoginPage('Login failed — please try again.'), {
        'Set-Cookie': clearOAuthStateCookie(),
      });
    }
    return;
  }

  // Everything below requires a valid session.
  const session = getSession(req);
  if (!session) {
    redirect(res, '/dashboard/login');
    return;
  }

  // --- /dashboard (guild list) ---
  if (pathname === '/dashboard' || pathname === '/dashboard/') {
    const client = deps.getClient();
    const rows: GuildRowData[] = [];
    for (const g of session.guilds) {
      const botPresent = !!client?.guilds.cache.has(g.id);
      let configured = false;
      if (botPresent) {
        const cfg = await deps.guildConfigRepo.getByGuildId(g.id);
        if (cfg) {
          const roleMap = await deps.roleMappingService.getEnabledMap(cfg.id);
          configured = Object.keys(roleMap).length > 0;
        }
      }
      rows.push({ id: g.id, name: g.name, icon: null, botPresent, configured });
    }
    sendHtml(res, 200, renderGuildListPage(session.username, rows));
    return;
  }

  // --- /dashboard/guilds/:guildId/flairs (Profile Flair CRUD) ---
  const flairListMatch = pathname.match(/^\/dashboard\/guilds\/(\d+)\/flairs\/?$/);
  const flairFormMatch = pathname.match(/^\/dashboard\/guilds\/(\d+)\/flairs\/(new|[\w-]+)\/?$/);

  if (flairListMatch || flairFormMatch) {
    const guildId = (flairListMatch || flairFormMatch)![1];
    const access = requireGuildAccess(session, guildId, deps);
    if ('error' in access) {
      sendHtml(res, access.error, `<h1>${access.error}</h1><p>${access.message}</p>`);
      return;
    }
    const guildConfig = await deps.guildConfigRepo.getByGuildId(guildId);
    if (!guildConfig) {
      sendHtml(res, 404, '<h1>No configuration yet</h1><p>Configure this guild first before adding profile flairs.</p>');
      return;
    }

    if (flairListMatch) {
      const flairs = await deps.profileFlairRepo.listAllByGuildConfig(guildConfig.id);
      sendHtml(res, 200, renderFlairListPage(access.guild.name, guildId, flairs));
      return;
    }

    // --- /dashboard/guilds/:guildId/flairs/new or /:flairId (create/edit form) ---
    const flairId = flairFormMatch![2];
    const isNew = flairId === 'new';

    if (req.method === 'POST') {
      const body = await readRequestBody(req).catch(() => '');
      const form = new URLSearchParams(body);
      const action = form.get('_action');

      if (action === 'delete' && !isNew) {
        await deps.profileFlairRepo.delete(guildConfig.id, flairId);
        logger.info({ guildId, flairId, discordId: session.discordId }, 'Dashboard: profile flair deleted');
        redirect(res, `/dashboard/guilds/${guildId}/flairs`);
        return;
      }

      const name = (form.get('name') || '').trim();
      const triggerType = form.get('triggerType') === 'MILITARY_UNITS' ? 'MILITARY_UNITS' : 'SPECIFIC_USERS';
      const displayText = (form.get('displayText') || '').trim();
      const priority = parseInt(form.get('priority') || '0', 10) || 0;
      const enabled = form.get('enabled') === 'on';
      // Targets submitted as newline/comma-separated raw WarEra user or MU IDs —
      // this dashboard doesn't do live WarEra search/autocomplete (out of scope for
      // this pass); admins paste IDs directly. Never trusted further than "these
      // are the literal target IDs for this ONE flair, scoped to this guild".
      const targetIds = (form.get('targets') || '')
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (!name || !displayText || targetIds.length === 0) {
        sendHtml(
          res,
          400,
          renderFlairFormPage(access.guild.name, guildId, isNew ? null : await deps.profileFlairRepo.getByIdForGuild(guildConfig.id, flairId), {
            type: 'error',
            message: 'Name, display text, and at least one target are required.',
          })
        );
        return;
      }

      if (isNew) {
        await deps.profileFlairRepo.create(guildConfig.id, { name, triggerType, displayText, priority }, targetIds);
        logger.info({ guildId, discordId: session.discordId, name }, 'Dashboard: profile flair created');
      } else {
        await deps.profileFlairRepo.update(guildConfig.id, flairId, { name, displayText, priority, enabled }, targetIds);
        logger.info({ guildId, flairId, discordId: session.discordId }, 'Dashboard: profile flair updated');
      }
      redirect(res, `/dashboard/guilds/${guildId}/flairs`);
      return;
    }

    // GET
    const flair = isNew ? null : await deps.profileFlairRepo.getByIdForGuild(guildConfig.id, flairId);
    if (!isNew && !flair) {
      sendHtml(res, 404, '<h1>Flair not found</h1>');
      return;
    }
    sendHtml(res, 200, renderFlairFormPage(access.guild.name, guildId, flair));
    return;
  }

  // --- /dashboard/guilds/:guildId (general + role settings) ---
  const guildMatch = pathname.match(/^\/dashboard\/guilds\/(\d+)\/?$/);
  if (guildMatch) {
    const guildId = guildMatch[1];
    const access = requireGuildAccess(session, guildId, deps);
    if ('error' in access) {
      sendHtml(res, access.error, `<h1>${access.error}</h1><p>${access.message}</p>`);
      return;
    }
    const guild = access.guild;

    const botMember = guild.members.me;
    const botHighestPosition = botMember ? botMember.roles.highest.position : -1;

    const roleOptions: RoleOption[] = guild.roles.cache
      .filter((r) => r.id !== guild.id) // exclude @everyone
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.hexColor,
        position: r.position,
        aboveBotHighest: r.position >= botHighestPosition,
      }));

    if (req.method === 'POST') {
      let body: string;
      try {
        body = await readRequestBody(req);
      } catch {
        sendHtml(res, 400, '<h1>Request too large</h1>');
        return;
      }
      const form = new URLSearchParams(body);

      let config1 = await deps.guildConfigRepo.getByGuildId(guildId);
      if (!config1) {
        config1 = await deps.guildConfigRepo.upsertConfig(guildId, {});
      }

      // Validate every submitted role ID actually exists as a real role in THIS
      // guild before writing anything — never trust the form blindly.
      let hadInvalidRole = false;
      for (const field of ROLE_FIELDS) {
        const value = form.get(field.key);
        if (value && !guild.roles.cache.has(value)) {
          hadInvalidRole = true;
          continue;
        }
        await deps.roleMappingService.setMapping(config1.id, field.key, value || null);
      }

      const generalUpdate: Record<string, string | null> = {
        communityName: (form.get('communityName') || '').trim() || null,
        description: (form.get('description') || '').trim() || null,
        logoUrl: (form.get('logoUrl') || '').trim() || null,
        accentColor: (form.get('accentColor') || '').trim() || null,
      };
      const communityType = form.get('communityType');
      const communityTypeUpdate = communityType ? { communityType: communityType as never } : {};

      // Each WarEra identifier is validated live before being saved — an invalid
      // ID is dropped (existing value preserved) rather than saved blindly.
      const invalidIds: string[] = [];
      const partyIdInput = (form.get('partyId') || '').trim();
      if (partyIdInput) {
        try {
          const party = await deps.wareraService.getParty(partyIdInput);
          generalUpdate.partyId = partyIdInput;
          generalUpdate.partyName = party.name || null;
        } catch {
          invalidIds.push('Party ID');
        }
      } else {
        generalUpdate.partyId = null;
        generalUpdate.partyName = null;
      }

      const countryIdInput = (form.get('countryId') || '').trim();
      if (countryIdInput) {
        try {
          const country = await deps.wareraService.getCountryById(countryIdInput);
          generalUpdate.countryId = countryIdInput;
          generalUpdate.countryName = country.name;
        } catch {
          invalidIds.push('Country ID');
        }
      } else {
        generalUpdate.countryId = null;
        generalUpdate.countryName = null;
      }

      const muIdInput = (form.get('muId') || '').trim();
      if (muIdInput) {
        try {
          const mu = await deps.wareraService.getMu(muIdInput);
          generalUpdate.muId = muIdInput;
          generalUpdate.muName = mu.name || null;
        } catch {
          invalidIds.push('MU ID');
        }
      } else {
        generalUpdate.muId = null;
        generalUpdate.muName = null;
      }

      await deps.guildConfigRepo.upsertConfig(guildId, { ...generalUpdate, ...communityTypeUpdate });
      logger.info({ guildId, discordId: session.discordId, invalidIds }, 'Dashboard: guild settings updated');

      const cfg = await deps.guildConfigRepo.getByGuildId(guildId);
      const roleMap = await deps.roleMappingService.getEnabledMap(cfg!.id);
      const currentValues: Record<string, string | null | undefined> = {};
      for (const f of ROLE_FIELDS) currentValues[f.key] = (roleMap as Record<string, string | undefined>)[f.key];

      const anySelectedAboveBotHighest = Object.values(currentValues).some(
        (val) => val && roleOptions.find((r) => r.id === val)?.aboveBotHighest
      );

      const saveNotice = hadInvalidRole || invalidIds.length > 0
        ? {
            type: 'error' as const,
            message:
              'Settings saved, but some values were invalid and NOT changed: ' +
              [hadInvalidRole ? 'one or more roles no longer exist' : null, ...invalidIds.map((f) => `${f} not found on WarEra`)]
                .filter(Boolean)
                .join('; ') +
              '.',
          }
        : { type: 'success' as const, message: 'Settings saved successfully.' };

      sendHtml(
        res,
        200,
        renderGuildSettingsPage(
          guild.name,
          guildId,
          ROLE_FIELDS,
          roleOptions,
          currentValues,
          cfg,
          saveNotice,
          anySelectedAboveBotHighest
        )
      );
      return;
    }

    // GET — render current config
    const cfg = await deps.guildConfigRepo.getByGuildId(guildId);
    const roleMap = cfg ? await deps.roleMappingService.getEnabledMap(cfg.id) : {};
    const currentValues: Record<string, string | null | undefined> = {};
    for (const f of ROLE_FIELDS) currentValues[f.key] = (roleMap as Record<string, string | undefined>)[f.key];
    const anySelectedAboveBotHighest = Object.values(currentValues).some(
      (val) => val && roleOptions.find((r) => r.id === val)?.aboveBotHighest
    );

    sendHtml(
      res,
      200,
      renderGuildSettingsPage(guild.name, guildId, ROLE_FIELDS, roleOptions, currentValues, cfg, undefined, anySelectedAboveBotHighest)
    );
    return;
  }

  sendHtml(res, 404, '<h1>Not Found</h1>');
}
