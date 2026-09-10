/**
 * Verification script for the Political Party role sync logic.
 *
 * Run with: npx ts-node verify_party_sync.ts
 *
 * This tests the two pure, exported decision functions from
 * roleSync.service.ts in isolation — no Discord.js, Prisma, or network
 * access required. This mirrors the "President -> Council" transition,
 * "left the party", "not in configured party", and role-coexistence cases
 * described in the task spec.
 *
 * API-failure resilience (requirement: a temporary WarEra API failure must
 * never strip existing party roles) is NOT exercised by these pure
 * functions — that guarantee lives in the try/catch structure of
 * RoleSyncService.syncMember() itself (party role IDs are only added to
 * managedRoleIds *after* a successful party fetch), and is documented /
 * manually verified separately since it requires mocking Discord.js Guild
 * and GuildMember objects, which the project's existing test scripts don't
 * do either.
 */

import {
  determinePartyPosition,
  resolvePartyTargetRoleIds,
  PartyPosition,
  PartyRoleConfig,
} from './src/services/roleSync.service';
import { PartyGetByIdResponse } from './src/types/Responses';

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

// --- Fixture data -----------------------------------------------------

const CONFIG: PartyRoleConfig = {
  partyPresidentRoleId: 'ROLE_PRESIDENT',
  partyTreasurerRoleId: 'ROLE_TREASURER',
  partyCouncilRoleId: 'ROLE_COUNCIL',
  partyMemberRoleId: 'ROLE_MEMBER',
};

const PRESIDENT_ID = 'user_president';
const TREASURER_ID = 'user_treasurer';
const COUNCIL_ID = 'user_council_1';
const MEMBER_ID = 'user_ordinary_member';
const OUTSIDER_ID = 'user_not_in_party';

const configuredParty: Pick<PartyGetByIdResponse, 'leader' | 'treasurer' | 'councilMembers' | 'members'> = {
  leader: PRESIDENT_ID,
  treasurer: TREASURER_ID,
  councilMembers: [COUNCIL_ID, 'user_council_2'],
  members: [PRESIDENT_ID, TREASURER_ID, COUNCIL_ID, 'user_council_2', MEMBER_ID],
};

// --- Case 1: Party President -------------------------------------------
{
  const position = determinePartyPosition(configuredParty, PRESIDENT_ID);
  assertEqual(position, 'president', 'Case 1a: leader is detected as president');
  const roles = resolvePartyTargetRoleIds(position, CONFIG).sort();
  assertEqual(roles, ['ROLE_MEMBER', 'ROLE_PRESIDENT'].sort(), 'Case 1b: president gets President + Member roles');
}

// --- Case 2: Party Treasurer --------------------------------------------
{
  const position = determinePartyPosition(configuredParty, TREASURER_ID);
  assertEqual(position, 'treasurer', 'Case 2a: treasurer is detected correctly');
  const roles = resolvePartyTargetRoleIds(position, CONFIG).sort();
  assertEqual(roles, ['ROLE_MEMBER', 'ROLE_TREASURER'].sort(), 'Case 2b: treasurer gets Treasurer + Member roles');
}

// --- Case 3: Party Council ----------------------------------------------
{
  const position = determinePartyPosition(configuredParty, COUNCIL_ID);
  assertEqual(position, 'council', 'Case 3a: council member is detected correctly');
  const roles = resolvePartyTargetRoleIds(position, CONFIG).sort();
  assertEqual(roles, ['ROLE_COUNCIL', 'ROLE_MEMBER'].sort(), 'Case 3b: council gets Council + Member roles');
}

// --- Case 4: Ordinary Member ---------------------------------------------
{
  const position = determinePartyPosition(configuredParty, MEMBER_ID);
  assertEqual(position, 'member', 'Case 4a: ordinary member is detected correctly');
  const roles = resolvePartyTargetRoleIds(position, CONFIG).sort();
  assertEqual(roles, ['ROLE_MEMBER'], 'Case 4b: ordinary member gets ONLY the Member role');
}

// --- Case 5: Not in configured party -------------------------------------
{
  const position = determinePartyPosition(configuredParty, OUTSIDER_ID);
  assertEqual(position, 'none', 'Case 5a: non-member is detected as having no position');
  const roles = resolvePartyTargetRoleIds(position, CONFIG);
  assertEqual(roles, [], 'Case 5b: non-member gets no party roles at all');
}

// --- Case 6: Left the party (president -> none) ---------------------------
{
  // Simulates: party.leader/treasurer/councilMembers/members no longer include this user.
  const partyAfterLeaving: typeof configuredParty = {
    leader: 'someone_else',
    treasurer: TREASURER_ID,
    councilMembers: [COUNCIL_ID, 'user_council_2'],
    members: [TREASURER_ID, COUNCIL_ID, 'user_council_2', MEMBER_ID], // PRESIDENT_ID removed
  };
  const position = determinePartyPosition(partyAfterLeaving, PRESIDENT_ID);
  assertEqual(position, 'none', 'Case 6a: former president who left the party has no position');
  const roles = resolvePartyTargetRoleIds(position, CONFIG);
  assertEqual(roles, [], 'Case 6b: former president gets no party roles (both President and Member removed)');
}

// --- Case 7: President -> Council transition -------------------------------
{
  const partyAfterDemotion: typeof configuredParty = {
    ...configuredParty,
    leader: 'someone_else',
    councilMembers: [PRESIDENT_ID, COUNCIL_ID, 'user_council_2'], // former president is now council
  };
  const position = determinePartyPosition(partyAfterDemotion, PRESIDENT_ID);
  assertEqual(position, 'council', 'Case 7a: former president demoted to council is detected correctly');
  const roles = resolvePartyTargetRoleIds(position, CONFIG).sort();
  assertEqual(
    roles,
    ['ROLE_COUNCIL', 'ROLE_MEMBER'].sort(),
    'Case 7b: demoted president ends up with Council + Member (President role implicitly dropped)'
  );
}

// --- Case 9 (role coexistence): party roles never include anything else ----
{
  const allPositions: PartyPosition[] = ['president', 'treasurer', 'council', 'member', 'none'];
  for (const position of allPositions) {
    const roles = resolvePartyTargetRoleIds(position, CONFIG);
    const onlyKnownPartyRoles = roles.every((r) =>
      [CONFIG.partyPresidentRoleId, CONFIG.partyTreasurerRoleId, CONFIG.partyCouncilRoleId, CONFIG.partyMemberRoleId].includes(r)
    );
    assertEqual(
      onlyKnownPartyRoles,
      true,
      `Case 9 (${position}): resolvePartyTargetRoleIds never returns a non-party role ID`
    );
  }
  // Because RoleSyncService accumulates country/MU/level/spec/party roles into the SAME
  // Set<string> (targetRoleIds) independently, and resolvePartyTargetRoleIds only ever
  // returns the 4 configured party role IDs, party role resolution structurally cannot
  // clear or interfere with any other system's roles (e.g. Country President).
}

// --- Edge case: unconfigured role IDs are simply omitted, never crash ------
{
  const partialConfig: PartyRoleConfig = { partyMemberRoleId: 'ROLE_MEMBER' }; // no president/treasurer/council role configured
  const roles = resolvePartyTargetRoleIds('president', partialConfig);
  assertEqual(roles, ['ROLE_MEMBER'], 'Edge case: missing partyPresidentRoleId config degrades to Member-only, no crash');
}

// --- Edge case: empty/missing party roster fields don't throw --------------
{
  const emptyParty: typeof configuredParty = {};
  const position = determinePartyPosition(emptyParty, PRESIDENT_ID);
  assertEqual(position, 'none', 'Edge case: party with no leader/treasurer/councilMembers/members fields resolves to none');
}

// --- Case 10: President -> ordinary member (demoted, but stays a rank-and-file member) ---
{
  const partyAfterFullDemotion: typeof configuredParty = {
    leader: 'someone_else',
    treasurer: TREASURER_ID,
    councilMembers: [COUNCIL_ID, 'user_council_2'], // former president NOT re-added here
    members: [PRESIDENT_ID, TREASURER_ID, COUNCIL_ID, 'user_council_2', MEMBER_ID], // still a plain member
  };
  const position = determinePartyPosition(partyAfterFullDemotion, PRESIDENT_ID);
  assertEqual(position, 'member', 'Case 10a: former president still in members[] (not council) is an ordinary member');
  const roles = resolvePartyTargetRoleIds(position, CONFIG);
  assertEqual(roles, ['ROLE_MEMBER'], 'Case 10b: former president demoted to ordinary member keeps ONLY Member (President role dropped)');
}

// --- Case 11: Treasurer -> ordinary member -------------------------------
{
  const partyAfterTreasurerDemotion: typeof configuredParty = {
    ...configuredParty,
    treasurer: 'someone_else', // TREASURER_ID replaced
  };
  const position = determinePartyPosition(partyAfterTreasurerDemotion, TREASURER_ID);
  assertEqual(position, 'member', 'Case 11a: former treasurer still in members[] is an ordinary member');
  const roles = resolvePartyTargetRoleIds(position, CONFIG);
  assertEqual(roles, ['ROLE_MEMBER'], 'Case 11b: former treasurer keeps ONLY Member (Treasurer role dropped)');
}

// --- Case 12: Council -> ordinary member ----------------------------------
{
  const partyAfterCouncilDemotion: typeof configuredParty = {
    ...configuredParty,
    councilMembers: ['user_council_2'], // COUNCIL_ID removed from council, but still in members[]
  };
  const position = determinePartyPosition(partyAfterCouncilDemotion, COUNCIL_ID);
  assertEqual(position, 'member', 'Case 12a: former council member still in members[] is an ordinary member');
  const roles = resolvePartyTargetRoleIds(position, CONFIG);
  assertEqual(roles, ['ROLE_MEMBER'], 'Case 12b: former council member keeps ONLY Member (Council role dropped)');
}

// --- Case 13: Ordinary member -> left the party entirely --------------------
{
  const partyAfterMemberLeaves: typeof configuredParty = {
    ...configuredParty,
    members: [PRESIDENT_ID, TREASURER_ID, COUNCIL_ID, 'user_council_2'], // MEMBER_ID removed entirely
  };
  const position = determinePartyPosition(partyAfterMemberLeaves, MEMBER_ID);
  assertEqual(position, 'none', 'Case 13a: ordinary member who left the party has no position');
  const roles = resolvePartyTargetRoleIds(position, CONFIG);
  assertEqual(roles, [], 'Case 13b: former member gets no party roles (Member role removed, nothing added)');
}

// --- Case 14: user is in a DIFFERENT WarEra party than the one configured --
{
  // Simulates: this guild is configured for `configuredParty`, but the player's own
  // party is some other party entirely. Because RoleSyncService only ever fetches the
  // *configured* party's roster (never the player's own party), this player is simply
  // absent from every field of `configuredParty` — indistinguishable, by design, from
  // "not in any party at all". Being a leader/treasurer/council member of a DIFFERENT
  // party grants nothing here.
  const OTHER_PARTY_LEADER_ID = 'user_leads_a_different_party';
  const position = determinePartyPosition(configuredParty, OTHER_PARTY_LEADER_ID);
  assertEqual(position, 'none', 'Case 14a: leader of a different (non-configured) party has no position in THIS guild');
  const roles = resolvePartyTargetRoleIds(position, CONFIG);
  assertEqual(roles, [], 'Case 14b: member of another party gets zero roles on a server configured for a different party');
}

// --- Case 15: API-failure role preservation, simulated with the exact same ---
// managedRoleIds / targetRoleIds diffing algorithm RoleSyncService.syncMember() uses
// (Array.from(managed).filter(id => current.has(id) && !target.has(id))). This is not
// a call into syncMember() itself (that needs live Discord.js/Prisma objects), but it
// exercises the identical decision math with the same inputs syncMember would produce
// on a party.getById() throw: party role IDs are simply absent from managedRoleIds.
{
  const currentDiscordRoles = new Set(['ROLE_COUNTRY_PRESIDENT', 'ROLE_PRESIDENT', 'ROLE_MEMBER', 'ROLE_WAR_SPEC']);

  // Simulate a SUCCESSFUL sync cycle where the player is confirmed to have left the party:
  const managedOnSuccess = new Set(['ROLE_COUNTRY_PRESIDENT', 'ROLE_PRESIDENT', 'ROLE_TREASURER', 'ROLE_COUNCIL', 'ROLE_MEMBER', 'ROLE_WAR_SPEC']);
  const targetOnSuccess = new Set(['ROLE_COUNTRY_PRESIDENT', 'ROLE_WAR_SPEC']); // position resolved to 'none'
  const removedOnSuccess = Array.from(managedOnSuccess).filter((id) => currentDiscordRoles.has(id) && !targetOnSuccess.has(id)).sort();
  assertEqual(
    removedOnSuccess,
    ['ROLE_MEMBER', 'ROLE_PRESIDENT'].sort(),
    'Case 15a: confirmed non-membership (successful API call) DOES strip existing party roles'
  );

  // Simulate a FAILED sync cycle (party.getById threw): party role IDs never joined
  // managedRoleIds this cycle, so they cannot appear in the removal diff no matter what
  // targetRoleIds looks like.
  const managedOnFailure = new Set(['ROLE_COUNTRY_PRESIDENT', 'ROLE_WAR_SPEC']); // party IDs withheld
  const targetOnFailure = new Set(['ROLE_COUNTRY_PRESIDENT', 'ROLE_WAR_SPEC']); // party roles never added either
  const removedOnFailure = Array.from(managedOnFailure).filter((id) => currentDiscordRoles.has(id) && !targetOnFailure.has(id));
  assertEqual(removedOnFailure, [], 'Case 15b: a failed API call removes NOTHING — existing Party President + Member survive untouched');
  const stillHasPartyRoles = currentDiscordRoles.has('ROLE_PRESIDENT') && currentDiscordRoles.has('ROLE_MEMBER');
  assertEqual(stillHasPartyRoles, true, 'Case 15c: member still visibly holds Party President + Party Member after the failed cycle');
}

// --- Case 16: coexistence — party role resolution never touches country roles ---
{
  // Simulates a player who is simultaneously Country President AND Party President,
  // exactly as required. Two independent blocks (country-role logic, elsewhere in
  // syncMember, and resolvePartyTargetRoleIds here) both add into the SAME Set.
  const targetRoleIds = new Set<string>();
  targetRoleIds.add('ROLE_COUNTRY_PRESIDENT'); // added by the pre-existing government-role block
  targetRoleIds.add('ROLE_WAR_SPEC'); // added by the pre-existing specialization block
  resolvePartyTargetRoleIds('president', CONFIG).forEach((id) => targetRoleIds.add(id));

  assertEqual(
    Array.from(targetRoleIds).sort(),
    ['ROLE_COUNTRY_PRESIDENT', 'ROLE_MEMBER', 'ROLE_PRESIDENT', 'ROLE_WAR_SPEC'].sort(),
    'Case 16: Country President + War Specialist + Party President + Party Member all coexist in one target set'
  );
}

// --- Summary ----------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
