/**
 * Staging test for migrate_icp_to_generic.ts — runs the REAL main() function
 * (not a re-implementation of its logic) against an in-memory fake database
 * seeded with two guilds: the actual ICP guild, and a second, unrelated
 * Political Party guild that also happens to have a partyId set (the exact
 * scenario that used to cause incorrect migration before this fix).
 *
 * Run with: npx ts-node verify_migration_staging.ts
 */
import { main, MigrationDb, ICP_GUILD_ID, ICP_EDUCATION_LEVEL_1_ROLE_ID } from './migrate_icp_to_generic';

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`✅ PASS: ${label}`);
  } else {
    failed++;
    console.log(`❌ FAIL: ${label}`);
  }
}

// --- In-memory fake database -------------------------------------------
interface FakeGuildConfig {
  id: string;
  guildId: string;
  communityType: string;
  countryId: string | null;
  countryName: string | null;
  partyId: string | null;
  citizenRoleId: string | null;
  presidentRoleId: string | null;
  warRoleId: string | null;
  partyMemberRoleId: string | null;
  [key: string]: any;
}

const guildConfigs: FakeGuildConfig[] = [
  {
    // The real ICP guild
    id: 'config-icp',
    guildId: ICP_GUILD_ID,
    communityType: 'CUSTOM',
    countryId: null,
    countryName: null,
    partyId: 'icp-party-id-123',
    citizenRoleId: 'icp-citizen-role',
    presidentRoleId: 'icp-president-role',
    warRoleId: 'icp-war-role',
    partyMemberRoleId: 'icp-party-member-role',
  },
  {
    // A completely different, unrelated Political Party guild — deliberately
    // ALSO has a partyId set (this is exactly the case that used to be
    // misidentified as "ICP" before the fix, since the old logic gated on
    // partyId presence rather than the actual guild ID).
    id: 'config-other-party',
    guildId: '999999999999999999',
    communityType: 'CUSTOM',
    countryId: null,
    countryName: null,
    partyId: 'some-other-partys-id-456',
    citizenRoleId: 'other-citizen-role',
    presidentRoleId: null,
    warRoleId: 'other-war-role',
    partyMemberRoleId: 'other-party-member-role',
  },
];

const roleMappings: { guildConfigId: string; type: string; discordRoleId: string; enabled: boolean }[] = [];
const profileFlairs: { guildConfigId: string; name: string; triggerType: string; displayText: string; targets: string[] }[] = [];

const fakeDb: MigrationDb = {
  guildConfig: {
    findMany: async () => guildConfigs.map((c) => ({ ...c })),
    update: async ({ where, data }: any) => {
      const cfg = guildConfigs.find((c) => c.id === where.id);
      if (cfg) Object.assign(cfg, data);
      return cfg;
    },
  },
  roleMapping: {
    upsert: async ({ where, update, create }: any) => {
      const key = where.guildConfigId_type;
      const existing = roleMappings.find((r) => r.guildConfigId === key.guildConfigId && r.type === key.type);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row = { ...create };
      roleMappings.push(row);
      return row;
    },
  },
  profileFlair: {
    findFirst: async ({ where }: any) => profileFlairs.find((f) => f.guildConfigId === where.guildConfigId && f.name === where.name) || null,
    create: async ({ data }: any) => {
      const row = {
        guildConfigId: data.guildConfigId,
        name: data.name,
        triggerType: data.triggerType,
        displayText: data.displayText,
        targets: (data.userTargets?.create || data.muTargets?.create || []).map((t: any) => t.wareraUserId || t.muId),
      };
      profileFlairs.push(row);
      return row;
    },
  },
};

const fakeWareraService = {
  getCountryId: async (name: string) => {
    if (name.toLowerCase() === 'egypt') return 'fake-egypt-country-id';
    throw new Error(`Unknown country: ${name}`);
  },
} as any;

// =========================================================================
// Run the REAL migration function once
// =========================================================================
async function run(): Promise<void> {
  await main(fakeDb, fakeWareraService);

  const icp = guildConfigs.find((c) => c.id === 'config-icp')!;
  const other = guildConfigs.find((c) => c.id === 'config-other-party')!;

  // --- ICP guild migrates correctly ---
  assert('ICP guild: countryId resolved to Egypt', icp.countryId === 'fake-egypt-country-id');
  assert('ICP guild: countryName set to Egypt', icp.countryName === 'Egypt');
  assert('ICP guild: communityType defaulted to COUNTRY_GOVERNMENT', icp.communityType === 'COUNTRY_GOVERNMENT');

  // --- Other guild remains unchanged (the critical fix being tested) ---
  assert('Other guild: countryId left untouched (still null)', other.countryId === null);
  assert('Other guild: countryName left untouched (still null)', other.countryName === null);
  assert('Other guild: communityType left untouched (still CUSTOM)', other.communityType === 'CUSTOM');

  // --- Old role settings remain intact on both (never deleted/mutated) ---
  assert('ICP guild: old citizenRoleId column untouched', icp.citizenRoleId === 'icp-citizen-role');
  assert('Other guild: old citizenRoleId column untouched', other.citizenRoleId === 'other-citizen-role');

  // --- RoleMappings created correctly for BOTH guilds, from their OWN data ---
  const icpMappings = roleMappings.filter((r) => r.guildConfigId === 'config-icp');
  const otherMappings = roleMappings.filter((r) => r.guildConfigId === 'config-other-party');

  assert(
    'ICP RoleMapping: CITIZEN_GATE created with ICP\'s own role ID',
    icpMappings.some((r) => r.type === 'CITIZEN_GATE' && r.discordRoleId === 'icp-citizen-role')
  );
  assert(
    'Other guild RoleMapping: CITIZEN_GATE created with ITS OWN role ID (not ICP\'s)',
    otherMappings.some((r) => r.type === 'CITIZEN_GATE' && r.discordRoleId === 'other-citizen-role')
  );
  assert(
    'Other guild RoleMapping: PRESIDENT is NOT created (was null on this guild)',
    !otherMappings.some((r) => r.type === 'PRESIDENT')
  );

  // --- The critical isolation check: education/forceverify roles ONLY for ICP ---
  assert(
    'ICP RoleMapping: EDUCATION_LEVEL_1 created with the original hardcoded ID',
    icpMappings.some((r) => r.type === 'EDUCATION_LEVEL_1' && r.discordRoleId === ICP_EDUCATION_LEVEL_1_ROLE_ID)
  );
  assert(
    'Other guild RoleMapping: EDUCATION_LEVEL_1 was NEVER created (guild-isolated, not identified by partyId)',
    !otherMappings.some((r) => r.type === 'EDUCATION_LEVEL_1')
  );
  assert(
    'Other guild RoleMapping: no FORCEVERIFY_* types leaked in either',
    !otherMappings.some((r) => r.type.startsWith('FORCEVERIFY_'))
  );

  // --- ICP Profile Flairs created correctly; other guild gets ZERO ---
  const icpFlairs = profileFlairs.filter((f) => f.guildConfigId === 'config-icp');
  const otherFlairs = profileFlairs.filter((f) => f.guildConfigId === 'config-other-party');

  assert('ICP ProfileFlair: exactly 2 flairs created', icpFlairs.length === 2);
  assert(
    'ICP ProfileFlair: "Role Model" has both original WarEra user IDs',
    icpFlairs.find((f) => f.name === 'Role Model')?.targets.length === 2
  );
  assert(
    'ICP ProfileFlair: "Protected Unit" has both original MU IDs',
    icpFlairs.find((f) => f.name === 'Protected Unit')?.targets.length === 2
  );
  assert(
    'Other guild ProfileFlair: ZERO flairs created (never inherits ICP\'s easter eggs)',
    otherFlairs.length === 0
  );

  // =========================================================================
  // Run it a SECOND time against the same (now-migrated) state — idempotency
  // =========================================================================
  const roleMappingCountBefore = roleMappings.length;
  const flairCountBefore = profileFlairs.length;

  await main(fakeDb, fakeWareraService);

  assert('Idempotency: running migration twice creates NO duplicate RoleMapping rows', roleMappings.length === roleMappingCountBefore);
  assert('Idempotency: running migration twice creates NO duplicate ProfileFlair rows', profileFlairs.length === flairCountBefore);
  assert(
    'Idempotency: ICP guild config values unchanged on second run',
    icp.countryId === 'fake-egypt-country-id' && icp.communityType === 'COUNTRY_GOVERNMENT'
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Staging migration test crashed:', err);
  process.exit(1);
});
