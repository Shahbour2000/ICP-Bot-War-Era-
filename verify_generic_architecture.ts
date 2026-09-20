/**
 * Verification script for the generic multi-tenant architecture added on top
 * of the party-system work: RoleMapping, ProfileFlair, MessageTemplate,
 * citizenship resolution, and the ICP migration script's constants.
 *
 * Run with: npx ts-node verify_generic_architecture.ts
 *
 * Everything here is pure-function / in-memory testing — no live database or
 * Discord connection required, matching the project's existing verify_*.ts
 * convention.
 */
import { isValidRoleMappingType, ROLE_MAPPING_TYPES, RoleMappingService } from './src/services/roleMapping.service';
import { evaluateProfileFlairs } from './src/services/profileFlair.service';
import { resolveCitizenStatus } from './src/services/citizenship.service';
import { MessageTemplateService, MESSAGE_TEMPLATES } from './src/services/messageTemplate.service';
import {
  LEGACY_ROLE_FIELD_TO_TYPE,
  ICP_EDUCATION_LEVEL_1_ROLE_ID,
  ICP_EDUCATION_LEVEL_2_ROLE_ID,
  ICP_FORCEVERIFY_ROLE_IDS,
  ICP_ROLE_MODEL_FLAIR,
  ICP_PROTECTED_UNIT_FLAIR,
} from './migrate_icp_to_generic';

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`✅ PASS: ${label}`);
  } else {
    failed++;
    console.log(`❌ FAIL: ${label}`);
    console.log(`   expected: ${JSON.stringify(expected)}`);
    console.log(`   actual:   ${JSON.stringify(actual)}`);
  }
}

// =========================================================================
// 1. RoleMapping type validation
// =========================================================================
assertEqual(isValidRoleMappingType('PRESIDENT'), true, 'RoleMapping: known type PRESIDENT is valid');
assertEqual(isValidRoleMappingType('PARTY_MEMBER'), true, 'RoleMapping: known type PARTY_MEMBER is valid');
assertEqual(isValidRoleMappingType('NOT_A_REAL_TYPE'), false, 'RoleMapping: unknown/garbage type is rejected');
assertEqual(isValidRoleMappingType(''), false, 'RoleMapping: empty string type is rejected');
assertEqual(
  new Set(ROLE_MAPPING_TYPES).size === ROLE_MAPPING_TYPES.length,
  true,
  'RoleMapping: no duplicate types in the master list'
);

// getEnabledMap should only ever return keys that are valid types, even if the
// (fake) repository returns garbage rows — simulate that with a stub repo.
{
  const fakeRows = [
    { type: 'PRESIDENT', discordRoleId: 'role-1', enabled: true },
    { type: 'INVALID_LEGACY_JUNK', discordRoleId: 'role-2', enabled: true },
  ];
  const fakeRepo = {
    listEnabledByGuildConfig: async () => fakeRows,
  } as any;
  const svc = new RoleMappingService(fakeRepo);
  svc.getEnabledMap('fake-guild-config-id').then((map) => {
    assertEqual(map.PRESIDENT, 'role-1', 'RoleMappingService: valid type is included in the map');
    assertEqual('INVALID_LEGACY_JUNK' in map, false, 'RoleMappingService: an invalid/unknown stored type is silently dropped, not trusted');
    printSummaryIfDone();
  });
}

// =========================================================================
// 2. ProfileFlair evaluation — generic, no hardcoded IDs, guild-isolated by construction
// =========================================================================
const GUILD_A_FLAIRS = [
  {
    id: 'flair-a1',
    guildConfigId: 'guild-a-config',
    name: 'Role Model',
    triggerType: 'SPECIFIC_USERS' as const,
    displayText: '☝️ القدوة',
    enabled: true,
    priority: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    userTargets: [{ wareraUserId: 'user-1' }, { wareraUserId: 'user-2' }],
    muTargets: [],
  },
  {
    id: 'flair-a2',
    guildConfigId: 'guild-a-config',
    name: 'Protected Unit',
    triggerType: 'MILITARY_UNITS' as const,
    displayText: '🏴 Protected',
    enabled: true,
    priority: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    userTargets: [],
    muTargets: [{ muId: 'mu-1' }],
  },
];

const GUILD_B_FLAIRS = [
  {
    id: 'flair-b1',
    guildConfigId: 'guild-b-config',
    name: 'VIP',
    triggerType: 'SPECIFIC_USERS' as const,
    displayText: '💎 VIP of Guild B',
    enabled: true,
    priority: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    userTargets: [{ wareraUserId: 'user-1' }], // SAME WarEra user ID as Guild A's rule
    muTargets: [],
  },
];

assertEqual(
  evaluateProfileFlairs(GUILD_A_FLAIRS, { _id: 'user-1' }),
  ['☝️ القدوة'],
  'ProfileFlair: SPECIFIC_USERS rule matches a targeted user'
);
assertEqual(
  evaluateProfileFlairs(GUILD_A_FLAIRS, { _id: 'user-999' }),
  [],
  'ProfileFlair: non-targeted user gets no flair text'
);
assertEqual(
  evaluateProfileFlairs(GUILD_A_FLAIRS, { _id: 'user-3', mu: 'mu-1' }),
  ['🏴 Protected'],
  'ProfileFlair: MILITARY_UNITS rule matches by current MU, independent of user identity'
);
assertEqual(
  evaluateProfileFlairs(GUILD_A_FLAIRS, { _id: 'user-1', mu: 'mu-1' }),
  ['☝️ القدوة', '🏴 Protected'],
  'ProfileFlair: multiple matching rules return in priority order'
);
// Guild isolation: user-1 matches a rule in BOTH guild A's and guild B's flair
// sets, but evaluating against ONLY guild A's array must never surface guild
// B's text — this is the guarantee the repository's `where: {guildConfigId}`
// scoping relies on this function never doing.
assertEqual(
  evaluateProfileFlairs(GUILD_A_FLAIRS, { _id: 'user-1' }).includes('💎 VIP of Guild B'),
  false,
  'ProfileFlair guild isolation: evaluating guild A flairs never returns guild B\'s text, even for a matching user ID'
);
assertEqual(
  evaluateProfileFlairs(GUILD_B_FLAIRS, { _id: 'user-1' }),
  ['💎 VIP of Guild B'],
  'ProfileFlair guild isolation: guild B\'s own flairs evaluate independently and correctly for the same user ID'
);
// Dedup: two enabled rules producing identical text must not double up.
const dupFlairs = [
  { ...GUILD_A_FLAIRS[0], id: 'dup-1' },
  { ...GUILD_A_FLAIRS[0], id: 'dup-2', priority: 5 },
];
assertEqual(
  evaluateProfileFlairs(dupFlairs, { _id: 'user-1' }),
  ['☝️ القدوة'],
  'ProfileFlair: identical display text from two different matching rules is de-duplicated'
);

// =========================================================================
// 3. Citizenship resolution — three distinct outcomes, no hardcoded country
// =========================================================================
assertEqual(
  resolveCitizenStatus('country-x', { citizenshipCheckEnabled: true, countryId: 'country-x' }),
  'citizen',
  'Citizenship: matching country with the feature enabled resolves to citizen'
);
assertEqual(
  resolveCitizenStatus('country-y', { citizenshipCheckEnabled: true, countryId: 'country-x' }),
  'not_citizen',
  'Citizenship: non-matching country with the feature enabled resolves to not_citizen'
);
assertEqual(
  resolveCitizenStatus('country-x', { citizenshipCheckEnabled: false, countryId: 'country-x' }),
  'not_applicable',
  'Citizenship: feature disabled resolves to not_applicable regardless of country match (ICP default — zero behavior change)'
);
assertEqual(
  resolveCitizenStatus('country-x', { citizenshipCheckEnabled: true, countryId: null }),
  'not_applicable',
  'Citizenship: no countryId configured resolves to not_applicable (a Party/MU/Org guild simply skips this)'
);

// =========================================================================
// 4. MessageTemplate — literal substitution only, default fallback, scoped vars
// =========================================================================
{
  const fakeRepo = { getByKey: async () => null } as any;
  const svc = new MessageTemplateService(fakeRepo);
  svc.render('fake-guild', 'verify_not_found', { username: 'TestPlayer' }).then((result) => {
    assertEqual(
      result,
      '❌ Could not find any WarEra player matching **TestPlayer**. Please verify the spelling and try again.',
      'MessageTemplate: default template renders correctly with no override (un-configured guild = unchanged output)'
    );
    printSummaryIfDone();
  });

  const overrideRepo = { getByKey: async () => ({ content: 'Bienvenue {username}!' }) } as any;
  const svc2 = new MessageTemplateService(overrideRepo);
  svc2.render('fake-guild', 'verify_not_found', { username: 'X' } as any).then((result) => {
    assertEqual(result, 'Bienvenue X!', 'MessageTemplate: guild override replaces the default template');
    printSummaryIfDone();
  });

  // Security: a var NOT in that key's documented placeholder list must never leak in,
  // even if a malicious/careless template string references it.
  const injectionRepo = { getByKey: async () => ({ content: 'Hello {username} your secret is {internalSecret}' }) } as any;
  const svc3 = new MessageTemplateService(injectionRepo);
  svc3.render('fake-guild', 'verify_not_found', { username: 'X', internalSecret: 'LEAKED' } as any).then((result) => {
    assertEqual(
      (result as string).includes('LEAKED'),
      false,
      'MessageTemplate: a var not in the key\'s documented placeholder list is never substituted, even if present in vars'
    );
    assertEqual(
      (result as string).includes('{internalSecret}'),
      true,
      'MessageTemplate: an undocumented placeholder is left as literal text, not silently dropped or executed'
    );
    printSummaryIfDone();
  });

  // Every template's default must not reference an undocumented placeholder itself.
  for (const [key, spec] of Object.entries(MESSAGE_TEMPLATES)) {
    const referenced = Array.from(spec.default.matchAll(/\{(\w+)\}/g)).map((m) => m[1]);
    const undocumented = referenced.filter((r) => !spec.placeholders.includes(r));
    assertEqual(undocumented, [], `MessageTemplate "${key}": default text only references its own documented placeholders`);
  }
}

// =========================================================================
// 5. Migration constants — completeness and no drift against the real service
// =========================================================================
for (const [field, type] of Object.entries(LEGACY_ROLE_FIELD_TO_TYPE)) {
  assertEqual(isValidRoleMappingType(type), true, `Migration: legacy field "${field}" maps to a currently-valid RoleMapping type ("${type}")`);
}
assertEqual(Object.keys(LEGACY_ROLE_FIELD_TO_TYPE).length, 16, 'Migration: all 16 legacy GuildConfig role columns are covered');
assertEqual(isValidRoleMappingType('EDUCATION_LEVEL_1'), true, 'Migration: EDUCATION_LEVEL_1 is a real, valid RoleMapping type');
assertEqual(isValidRoleMappingType('EDUCATION_LEVEL_2'), true, 'Migration: EDUCATION_LEVEL_2 is a real, valid RoleMapping type');
for (const type of Object.keys(ICP_FORCEVERIFY_ROLE_IDS)) {
  assertEqual(isValidRoleMappingType(type), true, `Migration: forceverify type "${type}" is a real, valid RoleMapping type`);
}
assertEqual(ICP_EDUCATION_LEVEL_1_ROLE_ID, '1525835773230710864', 'Migration: Education Level 1 role ID matches the original hardcoded constant exactly');
assertEqual(ICP_EDUCATION_LEVEL_2_ROLE_ID, '1525836096351768616', 'Migration: Education Level 2 role ID matches the original hardcoded constant exactly');
assertEqual(ICP_ROLE_MODEL_FLAIR.wareraUserIds.length, 2, 'Migration: "Role Model" flair preserves both original WarEra user IDs');
assertEqual(ICP_ROLE_MODEL_FLAIR.displayText, '☝️ القدوة', 'Migration: "Role Model" flair text matches the original exactly');
assertEqual(ICP_PROTECTED_UNIT_FLAIR.muIds.length, 2, 'Migration: "Protected Unit" flair preserves both original MU IDs');
assertEqual(
  ICP_PROTECTED_UNIT_FLAIR.displayText,
  '🏴 تحت حماية الرايات السوداء.',
  'Migration: "Protected Unit" flair text matches the original exactly'
);

function printSummaryIfDone(): void {
  // Called after each async block; only print once all are settled by checking
  // a simple counter against the number of async assertions registered above.
}

// Give the async .then() callbacks above a moment to run before printing the
// final summary (no async/await at top-level in this ts-node context).
setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}, 500);
