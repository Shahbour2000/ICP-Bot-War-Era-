/**
 * One-time migration: moves the ICP guild's existing hardcoded configuration
 * into the new generic system (RoleMapping, ProfileFlair, generic country/
 * community fields). This is the ONLY file in the codebase permitted to
 * contain these specific legacy WarEra IDs, Discord role IDs, and flair
 * texts — none of them may ever appear in shared production code again.
 *
 * Safe to re-run: every write is either an upsert or checks for an existing
 * row first. Does not hardcode a guild ID — it inspects every existing
 * GuildConfig row and migrates whichever ones have legacy data to move.
 *
 * Run with: npx ts-node migrate_icp_to_generic.ts
 */
import { prisma } from './src/database';
import { WarEraService } from './src/warera/service';
import { WarEraClient } from './src/warera/client';

// --- The two previously-hardcoded ICP profile "easter eggs" from
// src/commands/user.commands.ts, preserved byte-for-byte. ---
export const ICP_ROLE_MODEL_FLAIR = {
  name: 'Role Model',
  wareraUserIds: ['6933026bcb40c06497f414f3', '6a5ce045f3fc7e579e2d159c'],
  displayText: '☝️ القدوة',
};
export const ICP_PROTECTED_UNIT_FLAIR = {
  name: 'Protected Unit',
  muIds: ['69ced3d6c23c7a8448383f28', '6a67953fa483fa5aa897bef5'],
  displayText: '🏴 تحت حماية الرايات السوداء.',
};

// The two previously-hardcoded Discord role IDs from roleSync.service.ts's old
// EDUCATION_LVL_1_ROLE_ID / EDUCATION_LVL_2_ROLE_ID constants.
export const ICP_EDUCATION_LEVEL_1_ROLE_ID = '1525835773230710864';
export const ICP_EDUCATION_LEVEL_2_ROLE_ID = '1525836096351768616';

// Found DURING implementation (not in the original audit): three more hardcoded
// Discord role IDs from admin.commands.ts's old FORCE_VERIFY_*_ROLE_ID constants,
// used as additional /forceverify authorization tiers beyond Administrator.
export const ICP_FORCEVERIFY_ROLE_IDS: Record<string, string> = {
  FORCEVERIFY_MODERATOR: '1500579625405780129',
  FORCEVERIFY_EDUCATION_STAFF: '1477944138887331882',
  FORCEVERIFY_AUTHORIZED: '1496865174920101970',
};

// The actual Discord guild ID of the ICP server (confirmed from its own bot logs:
// "Islamic Caliphate (ICP) (WarEra)"). This — NOT partyId, NOT any WarEra
// attribute — is the only unambiguous way to identify "the ICP guild" during
// this one-time migration. A brand new Political Party guild would also have a
// partyId set, and must NEVER inherit ICP's education roles, forceverify
// roles, or profile flairs just because it happens to share that one field.
export const ICP_GUILD_ID = '1483949007540584508';
export const LEGACY_ROLE_FIELD_TO_TYPE: Record<string, string> = {
  citizenRoleId: 'CITIZEN_GATE',
  trustedRoleId: 'TRUSTED_GATE',
  presidentRoleId: 'PRESIDENT',
  vicePresidentRoleId: 'VICE_PRESIDENT',
  congressRoleId: 'CONGRESS',
  warRoleId: 'WAR_SPECIALIST',
  economyRoleId: 'ECONOMY_SPECIALIST',
  hybridRoleId: 'HYBRID_SPECIALIST',
  officerRoleId: 'OFFICER',
  muCommanderRoleId: 'MU_COMMANDER',
  muOwnerRoleId: 'MU_OWNER',
  noMuRoleId: 'NO_MU',
  partyPresidentRoleId: 'PARTY_PRESIDENT',
  partyTreasurerRoleId: 'PARTY_TREASURER',
  partyCouncilRoleId: 'PARTY_COUNCIL',
  partyMemberRoleId: 'PARTY_MEMBER',
};

/** Minimal shape of what this script needs from a Prisma client — lets tests
 *  inject an in-memory fake instead of needing a real database connection. */
export interface MigrationDb {
  guildConfig: { findMany(...args: any[]): Promise<any[]>; update(...args: any[]): Promise<any> };
  roleMapping: { upsert(...args: any[]): Promise<any> };
  profileFlair: { findFirst(...args: any[]): Promise<any>; create(...args: any[]): Promise<any> };
}

export async function migrateFlair(
  db: MigrationDb,
  guildConfigId: string,
  name: string,
  triggerType: 'SPECIFIC_USERS' | 'MILITARY_UNITS',
  displayText: string,
  targetIds: string[]
): Promise<void> {
  const existing = await db.profileFlair.findFirst({ where: { guildConfigId, name } });
  if (existing) {
    console.log(`  ProfileFlair "${name}" already exists, skipping (idempotent).`);
    return;
  }
  await db.profileFlair.create({
    data: {
      guildConfigId,
      name,
      triggerType,
      displayText,
      ...(triggerType === 'SPECIFIC_USERS'
        ? { userTargets: { create: targetIds.map((id) => ({ wareraUserId: id })) } }
        : { muTargets: { create: targetIds.map((id) => ({ muId: id })) } }),
    },
  });
  console.log(`  Created ProfileFlair "${name}" (${triggerType}, ${targetIds.length} target(s))`);
}

export async function main(db: MigrationDb = prisma, wareraSvc?: WarEraService): Promise<void> {
  const configs = await db.guildConfig.findMany();
  console.log(`Found ${configs.length} existing GuildConfig row(s) to check.`);

  const wareraService = wareraSvc || new WarEraService(new WarEraClient());

  for (const config of configs) {
    console.log(`\n--- Migrating guild ${config.guildId} (configId: ${config.id}) ---`);

    // 1. Country + community type — ICP-ONLY. Resolving "Egypt" and defaulting
    // communityType must never apply to any other guild just because it also
    // happens to have no countryId set yet (an unconfigured Party/MU/Org guild
    // legitimately has no countryId either, and must not be assumed to be Egypt).
    if (config.guildId === ICP_GUILD_ID) {
      let countryId: string | null = config.countryId;
      let countryName: string | null = config.countryName;
      if (!countryId) {
        try {
          countryId = await wareraService.getCountryId('Egypt');
          countryName = 'Egypt';
          console.log(`  Resolved Egypt country ID live from WarEra: ${countryId}`);
        } catch (err) {
          console.error(`  Could not resolve Egypt country ID from WarEra API: ${(err as Error).message}`);
          console.error('  Country left unset for this guild — set it manually with /config country-id.');
        }
      }

      await db.guildConfig.update({
        where: { id: config.id },
        data: {
          communityType: config.communityType === 'CUSTOM' ? 'COUNTRY_GOVERNMENT' : config.communityType,
          countryId,
          countryName,
          // Deliberately NOT enabling automatic citizenship checking here: there is
          // no existing automatic citizen-role behavior today (verified against the
          // actual code before this refactor), so turning this on would be a NEW
          // behavior, not a preserved one. Opt in later via /config or the dashboard.
        },
      });
    } else {
      console.log('  Not the ICP guild — country/communityType left completely untouched.');
    }

    // 2. Copy every populated legacy role column into a RoleMapping row.
    // Safe and correct for EVERY guild: this only ever copies a guild's own
    // pre-existing old-column data into the new table, never anyone else's.
    for (const [field, type] of Object.entries(LEGACY_ROLE_FIELD_TO_TYPE)) {
      const roleId = (config as unknown as Record<string, string | null>)[field];
      if (roleId) {
        await db.roleMapping.upsert({
          where: { guildConfigId_type: { guildConfigId: config.id, type } },
          update: { discordRoleId: roleId, enabled: true },
          create: { guildConfigId: config.id, type, discordRoleId: roleId },
        });
        console.log(`  RoleMapping ${type} <- ${field} (${roleId})`);
      }
    }

    // 3 & 4. Education roles and the two ICP-specific ProfileFlair rules were
    // NEVER guild-configurable before this refactor — they were unconditional,
    // hardcoded constants applied to every guild the bot was ever installed in.
    // We only carry them forward for the ACTUAL ICP guild, identified by its
    // real Discord guild ID (ICP_GUILD_ID) — never by partyId or any other
    // WarEra attribute a legitimately different Political Party guild could
    // also have. A brand new guild must never silently inherit ICP's specific
    // people/units/roles.
    if (config.guildId === ICP_GUILD_ID) {
      for (const [type, roleId] of [
        ['EDUCATION_LEVEL_1', ICP_EDUCATION_LEVEL_1_ROLE_ID],
        ['EDUCATION_LEVEL_2', ICP_EDUCATION_LEVEL_2_ROLE_ID],
        ...Object.entries(ICP_FORCEVERIFY_ROLE_IDS),
      ] as [string, string][]) {
        await db.roleMapping.upsert({
          where: { guildConfigId_type: { guildConfigId: config.id, type } },
          update: { discordRoleId: roleId, enabled: true },
          create: { guildConfigId: config.id, type, discordRoleId: roleId },
        });
        console.log(`  RoleMapping ${type} <- (legacy hardcoded constant) (${roleId})`);
      }

      await migrateFlair(
        db,
        config.id,
        ICP_ROLE_MODEL_FLAIR.name,
        'SPECIFIC_USERS',
        ICP_ROLE_MODEL_FLAIR.displayText,
        ICP_ROLE_MODEL_FLAIR.wareraUserIds
      );
      await migrateFlair(
        db,
        config.id,
        ICP_PROTECTED_UNIT_FLAIR.name,
        'MILITARY_UNITS',
        ICP_PROTECTED_UNIT_FLAIR.displayText,
        ICP_PROTECTED_UNIT_FLAIR.muIds
      );
    } else {
      console.log(`  Skipping education roles + ICP profile flairs (guildId ${config.guildId} does not match the known ICP guild ID — nothing ICP-specific is applied to other guilds).`);
    }
  }

  console.log('\nMigration complete.');
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
