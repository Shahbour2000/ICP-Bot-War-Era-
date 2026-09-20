const BASE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0b0d12; color: #e6e8eb; min-height: 100vh;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 32px 20px; }
  .center-wrap { max-width: 420px; margin: 0 auto; padding: 32px 20px; min-height: 100vh; display:flex; align-items:center; }
  a { color: #7c9cff; text-decoration: none; }
  .card {
    background: #12151c; border: 1px solid #22262f; border-radius: 14px; padding: 24px;
  }
  .btn {
    display: inline-block; background: #5865F2; color: #fff; padding: 12px 20px;
    border-radius: 10px; font-weight: 600; border: none; cursor: pointer; font-size: 14px;
  }
  .btn:hover { background: #4752C4; }
  .btn-secondary { background: #22262f; color: #e6e8eb; }
  .btn-secondary:hover { background: #2b3040; }
  .btn-block { display: block; width: 100%; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  h2 { font-size: 16px; margin: 0 0 14px; color: #9aa1ad; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
  p.sub { color: #9aa1ad; font-size: 14px; margin: 0 0 24px; }
  .guild-row {
    display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 10px;
    border: 1px solid #22262f; margin-bottom: 10px; background: #171a21;
  }
  .guild-icon { width: 40px; height: 40px; border-radius: 50%; background: #2b3040; flex-shrink: 0; object-fit: cover; }
  .guild-name { font-weight: 600; font-size: 15px; }
  .badge { font-size: 11px; padding: 3px 8px; border-radius: 6px; font-weight: 600; }
  .badge-ok { background: #16332322; color: #3ddc84; border: 1px solid #235c3d; }
  .badge-warn { background: #33280f; color: #f5b642; border: 1px solid #5c451f; }
  .badge-off { background: #332020; color: #f56666; border: 1px solid #5c2323; }
  .spacer { flex: 1; }
  form-field { display: block; margin-bottom: 16px; }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 13px; color: #9aa1ad; margin-bottom: 6px; }
  .field select, .field input {
    width: 100%; background: #171a21; border: 1px solid #2b3040; color: #e6e8eb;
    padding: 10px 12px; border-radius: 8px; font-size: 14px;
  }
  .section { margin-bottom: 26px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 600px) { .grid2 { grid-template-columns: 1fr; } }
  .notice { padding: 12px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 20px; }
  .notice-success { background: #16332322; color: #3ddc84; border: 1px solid #235c3d; }
  .notice-warn { background: #33280f; color: #f5b642; border: 1px solid #5c451f; }
  .notice-error { background: #332020; color: #f56666; border: 1px solid #5c2323; }
  .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
  .user-chip { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #9aa1ad; }
  .back-link { font-size: 13px; color: #9aa1ad; margin-bottom: 16px; display: inline-block; }
  .empty { text-align: center; padding: 40px 20px; color: #9aa1ad; }
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · WarEra Bot</title>
  <style>${BASE_STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

export function renderLoginPage(error?: string): string {
  const errorHtml = error
    ? `<div class="notice notice-error">${escapeHtml(error)}</div>`
    : '';
  return shell(
    'Login',
    `<div class="center-wrap"><div class="card" style="width:100%">
      <h1>WarEra Bot Dashboard</h1>
      <p class="sub">Sign in with Discord to configure your server.</p>
      ${errorHtml}
      <a class="btn btn-block" href="/dashboard/login">Login with Discord</a>
    </div></div>`
  );
}

export interface GuildRowData {
  id: string;
  name: string;
  icon: string | null;
  botPresent: boolean;
  configured: boolean;
}

export function renderGuildListPage(username: string, guilds: GuildRowData[]): string {
  const rows = guilds
    .map((g) => {
      const icon = g.icon
        ? `<img class="guild-icon" src="${escapeAttr(g.icon)}" alt="" />`
        : `<div class="guild-icon"></div>`;
      let badge: string;
      let action: string;
      if (!g.botPresent) {
        badge = `<span class="badge badge-off">Bot not added</span>`;
        action = `<a class="btn btn-secondary" href="https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(
          process.env.DISCORD_CLIENT_ID || ''
        )}&scope=bot%20applications.commands&permissions=2415987712&guild_id=${encodeURIComponent(
          g.id
        )}" target="_blank" rel="noopener">Add Bot</a>`;
      } else if (!g.configured) {
        badge = `<span class="badge badge-warn">Not configured</span>`;
        action = `<a class="btn" href="/dashboard/guilds/${g.id}">Configure</a>`;
      } else {
        badge = `<span class="badge badge-ok">Configured</span>`;
        action = `<a class="btn btn-secondary" href="/dashboard/guilds/${g.id}">Manage</a>`;
      }
      return `<div class="guild-row">
        ${icon}
        <div>
          <div class="guild-name">${escapeHtml(g.name)}</div>
          ${badge}
        </div>
        <div class="spacer"></div>
        ${action}
      </div>`;
    })
    .join('');

  const body = guilds.length
    ? rows
    : `<div class="empty">No servers found where you have Manage Server / Administrator permission.</div>`;

  return shell(
    'My Servers',
    `<div class="wrap">
      <div class="topbar">
        <h1>My Servers</h1>
        <div class="user-chip">${escapeHtml(username)} · <a href="/dashboard/logout">Logout</a></div>
      </div>
      ${body}
    </div>`
  );
}

export interface RoleOption {
  id: string;
  name: string;
  color: string; // hex
  position: number;
  aboveBotHighest: boolean;
}

export interface RoleFieldSpec {
  key: string; // RoleMapping type
  label: string;
}

export interface GuildConfigLike {
  communityType?: string;
  communityName?: string | null;
  description?: string | null;
  countryId?: string | null;
  countryName?: string | null;
  partyId?: string | null;
  muId?: string | null;
  logoUrl?: string | null;
  accentColor?: string | null;
}

const COMMUNITY_TYPES = [
  ['COUNTRY_GOVERNMENT', 'Country / Government'],
  ['POLITICAL_PARTY', 'Political Party'],
  ['MILITARY_UNIT', 'Military Unit'],
  ['ORGANIZATION', 'Organization'],
  ['CUSTOM', 'Custom'],
];

export function renderGuildSettingsPage(
  guildName: string,
  guildId: string,
  roleFields: RoleFieldSpec[],
  roles: RoleOption[],
  currentValues: Record<string, string | null | undefined>,
  cfg: GuildConfigLike | null | undefined,
  notice?: { type: 'success' | 'error'; message: string },
  botHighestWarning?: boolean
): string {
  const roleOptionsHtml = (selectedId: string | null | undefined) =>
    [`<option value="">— Not set —</option>`]
      .concat(
        roles.map((r) => {
          const selected = r.id === selectedId ? ' selected' : '';
          const warn = r.aboveBotHighest ? ' ⚠️ above bot role' : '';
          return `<option value="${r.id}"${selected}>${escapeHtml(r.name)}${warn}</option>`;
        })
      )
      .join('');

  const fieldsHtml = roleFields
    .map(
      (f) => `<div class="field">
        <label>${escapeHtml(f.label)}</label>
        <select name="${f.key}">${roleOptionsHtml(currentValues[f.key])}</select>
      </div>`
    )
    .join('');

  const noticeHtml = notice
    ? `<div class="notice notice-${notice.type === 'success' ? 'success' : 'error'}">${escapeHtml(notice.message)}</div>`
    : '';

  const hierarchyWarningHtml = botHighestWarning
    ? `<div class="notice notice-warn">Some roles above are positioned higher than the bot's own highest role — the bot cannot assign or remove those until you move its role up in Server Settings → Roles.</div>`
    : '';

  const communityTypeOptionsHtml = COMMUNITY_TYPES.map(
    ([value, label]) =>
      `<option value="${value}"${cfg?.communityType === value ? ' selected' : ''}>${label}</option>`
  ).join('');

  return shell(
    `${guildName} Settings`,
    `<div class="wrap">
      <a class="back-link" href="/dashboard">← My Servers</a>
      <div class="topbar">
        <h1>${escapeHtml(guildName)}</h1>
        <a class="btn btn-secondary" href="/dashboard/guilds/${guildId}/flairs">🏷️ Profile Flairs</a>
      </div>
      ${noticeHtml}
      ${hierarchyWarningHtml}
      <form method="POST" action="/dashboard/guilds/${guildId}">
        <div class="section card">
          <h2>Community</h2>
          <div class="grid2">
            <div class="field">
              <label>Community Type</label>
              <select name="communityType">${communityTypeOptionsHtml}</select>
            </div>
            <div class="field">
              <label>Community Name</label>
              <input type="text" name="communityName" value="${escapeAttr(cfg?.communityName || '')}" placeholder="e.g. Islamic Caliphate Party" />
            </div>
          </div>
          <div class="field">
            <label>Description</label>
            <input type="text" name="description" value="${escapeAttr(cfg?.description || '')}" />
          </div>
        </div>
        <div class="section card">
          <h2>WarEra Identifiers</h2>
          <p class="sub" style="margin-bottom:14px">Only set the ones that apply to this community — none are required.</p>
          <div class="grid2">
            <div class="field">
              <label>Country ID</label>
              <input type="text" name="countryId" value="${escapeAttr(cfg?.countryId || '')}" />
            </div>
            <div class="field">
              <label>Country Name (display only)</label>
              <input type="text" name="countryName" value="${escapeAttr(cfg?.countryName || '')}" />
            </div>
            <div class="field">
              <label>WarEra Party ID</label>
              <input type="text" name="partyId" value="${escapeAttr(cfg?.partyId || '')}" />
            </div>
            <div class="field">
              <label>WarEra MU ID</label>
              <input type="text" name="muId" value="${escapeAttr(cfg?.muId || '')}" />
            </div>
          </div>
        </div>
        <div class="section card">
          <h2>Branding</h2>
          <div class="grid2">
            <div class="field">
              <label>Logo URL</label>
              <input type="text" name="logoUrl" value="${escapeAttr(cfg?.logoUrl || '')}" />
            </div>
            <div class="field">
              <label>Accent Color</label>
              <input type="text" name="accentColor" value="${escapeAttr(cfg?.accentColor || '')}" placeholder="#2b2d31" />
            </div>
          </div>
        </div>
        <div class="section card">
          <h2>Role Mapping</h2>
          <div class="grid2">${fieldsHtml}</div>
        </div>
        <button class="btn" type="submit">Save Settings</button>
      </form>
    </div>`
  );
}

export interface FlairRow {
  id: string;
  name: string;
  triggerType: string;
  displayText: string;
  enabled: boolean;
  priority: number;
  userTargets: { wareraUserId: string }[];
  muTargets: { muId: string }[];
}

export function renderFlairListPage(guildName: string, guildId: string, flairs: FlairRow[]): string {
  const rows = flairs
    .map((f) => {
      const targetCount = f.triggerType === 'SPECIFIC_USERS' ? f.userTargets.length : f.muTargets.length;
      const status = f.enabled ? '<span class="badge badge-ok">Enabled</span>' : '<span class="badge badge-off">Disabled</span>';
      return `<div class="guild-row">
        <div>
          <div class="guild-name">${escapeHtml(f.name)}</div>
          <div style="font-size:13px;color:#9aa1ad;margin-top:4px">${escapeHtml(f.triggerType)} · ${targetCount} target(s) · "${escapeHtml(f.displayText)}"</div>
        </div>
        <div class="spacer"></div>
        ${status}
        <a class="btn btn-secondary" href="/dashboard/guilds/${guildId}/flairs/${f.id}">Edit</a>
      </div>`;
    })
    .join('');

  const body = flairs.length ? rows : `<div class="empty">No profile flairs configured yet.</div>`;

  return shell(
    'Profile Flairs',
    `<div class="wrap">
      <a class="back-link" href="/dashboard/guilds/${guildId}">← ${escapeHtml(guildName)} Settings</a>
      <div class="topbar">
        <h1>Profile Flairs</h1>
        <a class="btn" href="/dashboard/guilds/${guildId}/flairs/new">+ New Flair</a>
      </div>
      ${body}
    </div>`
  );
}

export function renderFlairFormPage(
  guildName: string,
  guildId: string,
  flair: FlairRow | null,
  notice?: { type: 'success' | 'error'; message: string }
): string {
  const isNew = !flair;
  const noticeHtml = notice
    ? `<div class="notice notice-${notice.type === 'success' ? 'success' : 'error'}">${escapeHtml(notice.message)}</div>`
    : '';
  const currentTargets = flair
    ? (flair.triggerType === 'SPECIFIC_USERS' ? flair.userTargets.map((t) => t.wareraUserId) : flair.muTargets.map((t) => t.muId)).join('\n')
    : '';

  return shell(
    isNew ? 'New Profile Flair' : `Edit ${flair!.name}`,
    `<div class="wrap">
      <a class="back-link" href="/dashboard/guilds/${guildId}/flairs">← Profile Flairs</a>
      <div class="topbar"><h1>${isNew ? 'New Profile Flair' : `Edit "${escapeHtml(flair!.name)}"`}</h1></div>
      ${noticeHtml}
      <form method="POST" action="/dashboard/guilds/${guildId}/flairs/${isNew ? 'new' : flair!.id}">
        <div class="section card">
          <div class="field">
            <label>Flair Name</label>
            <input type="text" name="name" value="${escapeAttr(flair?.name || '')}" placeholder="e.g. Role Model" required />
          </div>
          <div class="field">
            <label>Trigger Type</label>
            <select name="triggerType" ${!isNew ? 'disabled' : ''}>
              <option value="SPECIFIC_USERS"${!flair || flair.triggerType === 'SPECIFIC_USERS' ? ' selected' : ''}>Specific WarEra Users</option>
              <option value="MILITARY_UNITS"${flair?.triggerType === 'MILITARY_UNITS' ? ' selected' : ''}>Military Units</option>
            </select>
            ${!isNew ? '<input type="hidden" name="triggerType" value="' + flair!.triggerType + '" />' : ''}
          </div>
          <div class="field">
            <label>Target IDs (one WarEra user or MU ID per line)</label>
            <textarea name="targets" rows="4" style="width:100%;background:#171a21;border:1px solid #2b3040;color:#e6e8eb;padding:10px 12px;border-radius:8px;font-size:14px" placeholder="6933026bcb40c06497f414f3&#10;6a5ce045f3fc7e579e2d159c">${escapeHtml(currentTargets)}</textarea>
          </div>
          <div class="field">
            <label>Display Text</label>
            <input type="text" name="displayText" value="${escapeAttr(flair?.displayText || '')}" placeholder="e.g. ☝️ القدوة" required />
          </div>
          <div class="field">
            <label>Priority (lower shows first)</label>
            <input type="text" name="priority" value="${flair?.priority ?? 0}" />
          </div>
          ${
            !isNew
              ? `<div class="field"><label><input type="checkbox" name="enabled" ${flair!.enabled ? 'checked' : ''} style="width:auto;margin-right:8px" />Enabled</label></div>`
              : ''
          }
        </div>
        <button class="btn" type="submit">${isNew ? 'Create Flair' : 'Save Changes'}</button>
      </form>
      ${
        !isNew
          ? `<form method="POST" action="/dashboard/guilds/${guildId}/flairs/${flair!.id}" style="margin-top:12px">
              <input type="hidden" name="_action" value="delete" />
              <button class="btn btn-secondary" type="submit" onclick="return confirm('Delete this flair?')">Delete Flair</button>
            </form>`
          : ''
      }
    </div>`
  );
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(input: string): string {
  return escapeHtml(input);
}
