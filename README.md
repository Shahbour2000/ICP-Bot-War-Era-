# Egypt Discord Bot for WarEra

A production-ready Discord bot for the game **WarEra** built with Node.js, TypeScript, discord.js v14, Prisma ORM, and SQLite/PostgreSQL.

This bot automates Egypt citizen role management, presidency/congressional government roles sync, military unit (MU) tags, player specialization alignment (War, Economy, Hybrid), an automatic **Political Party role system**, and provides an advanced **Military Recruitment & Operations System** for the Ministry of Defense (MoD).

---

## Key Features

1. **Role Synchronization**: Automatically detects Egypt nationality, level, MU ID, and dynamic specialization (War/Economy/Hybrid) calculated directly from player skills.
2. **Political Party Roles**: Automatically assigns Party President / Treasurer / Council / Member Discord roles based on a guild-configured WarEra Party ID, using WarEra's own party roster as the source of truth. See [Political Party System](#political-party-system) below.
3. **Recruitment Campaigns**: Allow MoD officers to start/stop level-restricted mobilization campaigns, exempt/unexempt players, and generate detailed conversion reports showing progress by Military Unit.
4. **Daily Reminders**: Automatically DMs eligible non-War specialists reminding them to switch to War specialization (limited to one reminder per user per day).
5. **Operations alerts**: Create targeted Direct Message operations notifications (`war`, `economy`, `hybrid`, `level`, `mu`, `all`) with interactive button RSVPs (✅ Available / ❌ Unavailable).
6. **Readiness Dashboard**: Aggregated server overview detailing total verified counts, specialization distributions, level thresholds, campaign status, and average operation response statistics.

---

## Directory Structure
```
src/
  ├── config/          # Environment configuration loader
  ├── types/           # Type definitions (Responses.d.ts & warera-openapi.d.ts)
  ├── database/        # Prisma Client database connector
  ├── warera/          # tRPC API client and service wrappers
  ├── repositories/    # Database queries isolation (Prisma)
  ├── services/        # Business logic services (RoleSync, Verification, MoD)
  ├── commands/        # Discord slash commands router and implementation
  ├── jobs/            # Node-cron background sync and daily reminders loops
  ├── utils/           # Shared logger (pino) and utilities
  └── index.ts         # Application bootstrapper and process monitors
```

---

## Configuration (`.env`)
Create a `.env` file in the root folder (see `.env.example` as a template):
```env
DISCORD_TOKEN=MTUxN...                  # Discord Bot Token
DISCORD_CLIENT_ID=1516...               # Bot App Client ID
DATABASE_URL=file:./dev.db              # SQLite Database file path
WARERA_API_KEY=wae_fc85...              # WarEra API Key
WARERA_API_BASE_URL=https://api2.warera.io/trpc/
NODE_ENV=development
LOG_LEVEL=info
```

---

## Production Deployment (Render + Supabase PostgreSQL)

**Correction:** this section previously said to deploy as a Background Worker "since this bot does not bind to an HTTP port" — that is no longer accurate (and may never have been fully accurate). `src/index.ts` unconditionally calls `startHealthServer()`, which binds an HTTP server to `0.0.0.0:$PORT` with `/`, `/health`, and `/ping` endpoints (see `src/server.ts`). That only makes sense — and only gets used — on a Render **Web Service**, since Background Workers don't route external traffic to any port at all.

### 1. Database Setup (Supabase)
1. Create a new Supabase project.
2. Get your connection string (ensure you use the transaction connection pooler port `6543` and `?pgbouncer=true`).

### 2. Deployment on Render
1. Push this repository to GitHub.
2. In Render, create a new **Web Service** (bound to the port `startHealthServer()` opens — Render auto-detects `$PORT`).
3. Connect your GitHub repository.
4. Configure the following settings:
   * **Build Command**: `npm install && npx prisma generate && npm run build`
   * **Start Command**: `npx prisma db push --accept-data-loss && npm run start`
5. Configure the following Environment Variables in the Render dashboard:
   * `DATABASE_URL`: Your Supabase connection string.
   * `DISCORD_TOKEN`: Your Discord Bot token.
   * `DISCORD_CLIENT_ID`: Your Application Client ID.
   * `WARERA_API_KEY`: Your WarEra API Key.
   * `WARERA_API_BASE_URL`: `https://api2.warera.io/trpc/`
   * `NODE_ENV`: `production`

### 3. Startup Flow
During deployment, Render will build the TypeScript files. When the worker starts, `npx prisma db push` automatically synchronizes the PostgreSQL schema in Supabase before starting the bot, then the health HTTP server and the Discord client both come up.

### 4. Is UptimeRobot actually useful here?
**Yes — and it's effectively required on Render's free tier.** A free-tier Render Web Service spins down after ~15 minutes with no incoming HTTP requests, regardless of whether the Discord gateway connection inside it is still "active." Spinning down kills the whole process, including the Discord connection, and the next Discord interaction would otherwise have to wait through a slow cold-start. An UptimeRobot monitor hitting `/health` (or `/` or `/ping`) roughly every 5 minutes — well under the 15-minute idle threshold — keeps the service perpetually warm and the bot continuously connected. If you upgrade off the free tier, UptimeRobot becomes unnecessary (paid Render services don't spin down), but it's harmless to leave running either way.

---

## Command Reference (Slash Commands)

### Configuration Commands (Administrators)
* `/config citizen-role @Role` — Role given to members belonging to Egypt country.
* `/config officer-role @Role` — Role that grants MoD Officer privileges.
* `/config president-role @Role`, `/config vice-president-role @Role`, `/config congress-role @Role` — Cabinet mapping roles.
* `/config war-role @Role`, `/config economy-role @Role`, `/config hybrid-role @Role` — Specialization roles.
* `/config party-id <partyId>` — Sets the **WarEra Political Party ID** this Discord server represents. Required before any party roles will be assigned.
* `/config party-president-role @Role`, `/config party-treasurer-role @Role`, `/config party-council-role @Role`, `/config party-member-role @Role` — Political Party role mapping. See [Political Party System](#political-party-system).
* `/mu-role add <muId> @Role` — Maps a WarEra MU to a Discord role (verifies existence via API first).
* `/mu-role remove <muId>` — Removes the MU mapping.
* `/mu-role list` — Lists configured MU roles.
* `/level-role add <minimumLevel> @Role` — Maps minimum level threshold to a role.
* `/level-role remove <minimumLevel>` — Removes level mapping.
* `/level-role list` — Lists configured levels.

### MoD Recruitment Commands (Officers & Administrators)
* `/recruitment start <title> <minimumLevel>` — Starts a level-restricted campaign. Deactivates existing active campaigns.
* `/recruitment stop` — Stops the active mobilization campaign.
* `/recruitment status` — Displays overview stats (eligible, converted, remaining).
* `/recruitment exempt <user>` — Prevents a player from receiving daily mobilization reminders.
* `/recruitment unexempt <user>` — Removes reminder exemption from a player.
* `/recruitment report` — Displays detailed conversion statistics including a breakdown of converted/eligible players grouped by their Military Unit (MU).

### MoD Operations Commands (Officers & Administrators)
* `/operation create <title> <message> <targetType> (muId) (minimumLevel)` — Creates and dispatches direct message alerts to matching players. Target types include: `war`, `economy`, `hybrid`, `level`, `mu`, and `all`.
* `/operation list` — Lists logged operations in the server along with their IDs.
* `/operation status <operationId>` — Displays statistics (dispatched count, Available/Unavailable RSVP button clicks count, and response rate).

### Readiness Dashboard (Officers & Administrators)
* `/readiness` — Displays detailed Egypt military readiness metrics.

### User Commands (All Users)
* `/verify <username>` — Links Discord ID to a WarEra profile. Displays a select menu if multiple player results are found.
* `/profile` — Displays a detailed player profile embed card. If this guild has a Party ID configured, also shows the player's Political Party and position.
* `/sync-me` — Forces a role refresh for yourself, including Political Party roles.

---

## Political Party System

This bot can automatically synchronize **Political Party** Discord roles (President, Treasurer, Council, Member) for a single WarEra political party — the one this Discord server represents.

**WarEra is always the source of truth.** No party position is ever stored in this bot's database; every `/sync`, `/sync-me`, and `/sync-all` re-fetches the configured party fresh from the WarEra API (`party.getById`) and derives the player's position from that party's own `leader`, `treasurer`, `councilMembers`, and `members` fields.

### Setup

1. Find your party's WarEra ID (visible in the party's page URL on warera.io, or via the WarEra API/search).
2. Run `/config party-id <your-party-id>` once, in your Discord server.
3. Create (or pick existing) Discord roles for President, Treasurer, Council, and Member, then map them:
   ```
   /config party-president-role @Party President
   /config party-treasurer-role @Party Treasurer
   /config party-council-role  @Party Council
   /config party-member-role   @Party Member
   ```
4. Members run `/verify` (or an admin runs `/forceverify`) to link their Discord ↔ WarEra account, then `/sync-me` (or wait for the scheduled sync job / `/sync-all`).

### Assignment rules

| WarEra position (within the configured party) | Discord roles assigned |
|---|---|
| Party leader (`party.leader`) | Party President **+** Party Member |
| Party treasurer (`party.treasurer`) | Party Treasurer **+** Party Member |
| In `party.councilMembers` | Party Council **+** Party Member |
| In `party.members` (no other position) | Party Member only |
| Not in `party.members`, or in a different party | No party roles (any previously-held party roles are removed) |

Only the party ID configured via `/config party-id` is ever checked — being a member of *some other* WarEra party never grants any role on this server.

### Resilience

If the WarEra `party.getById` request fails (network error, timeout, API outage) during a sync cycle, the bot **does not touch that member's existing party roles at all** — a failed lookup is never treated as "not in the party." This is logged as `Party sync: WarEra Party API unavailable this cycle...`. The next successful sync will re-evaluate normally.

### Interaction with other roles

Political Party roles are fully independent of, and coexist with, Country roles (President/VP/Congress), MU roles, Level roles, and Specialization roles — a player can hold e.g. **Country President + Party President + Party Member + War Specialist** simultaneously. Party roles are integrated into `RoleSyncService.syncMember()` as first-class managed roles (not a separate/bypassing system), so `/sync`, `/sync-me`, `/sync-all`, and the scheduled background sync job all keep them up to date the same way as every other managed role.

### API endpoint used

* `party.getById` — `{ partyId: string }` → `{ _id, name, leader, treasurer, councilMembers: string[], members: string[], ... }`

This endpoint's shape was verified against the community-maintained WarEraProjects API client documentation (which independently documents `leader`/`treasurer`/`councilMembers`/`members` on the Party entity), cross-checked against the `rulingParty` (Country) and `partyIds` (search) fields already present in this codebase's own generated WarEra types. It was not possible to make a live confirmation call to `api2.warera.io` from the environment this feature was built in — **before relying on this in production, run `/config party-id` with a real party ID and `/sync-me` once, and check the bot logs for `Party sync: member detected as party ...` to confirm the live response matches.** If WarEra's actual field names differ, only `determinePartyPosition()` in `src/services/roleSync.service.ts` needs updating.
