import { RoleMappingRepository } from '../repositories/roleMapping.repository';

/**
 * The full set of role-mapping types this bot understands today, derived
 * directly from an audit of the previous per-guild GuildConfig columns plus
 * the two previously-hardcoded education role constants. Validated against
 * on every write — RoleMapping.type is a plain string in the DB specifically
 * so a new type can be added here without a schema migration, but that also
 * means nothing outside this list may ever be persisted.
 */
export const ROLE_MAPPING_TYPES = [
  'CITIZEN_GATE', // manual prerequisite gate (was citizenRoleId) — bot never assigns this itself
  'TRUSTED_GATE', // manual prerequisite gate (was trustedRoleId) — bot never assigns this itself
  'VERIFIED_CITIZEN', // NEW: automatic, granted when profile.country matches the guild's configured countryId
  'PRESIDENT',
  'VICE_PRESIDENT',
  'CONGRESS',
  'WAR_SPECIALIST',
  'ECONOMY_SPECIALIST',
  'HYBRID_SPECIALIST',
  'OFFICER',
  'MU_COMMANDER',
  'MU_OWNER',
  'NO_MU',
  'PARTY_PRESIDENT',
  'PARTY_TREASURER',
  'PARTY_COUNCIL',
  'PARTY_MEMBER',
  'EDUCATION_LEVEL_1',
  'EDUCATION_LEVEL_2',
  'FORCEVERIFY_MODERATOR', // additional authorization tier for /forceverify (was a hardcoded role ID)
  'FORCEVERIFY_EDUCATION_STAFF', // additional authorization tier for /forceverify (was a hardcoded role ID)
  'FORCEVERIFY_AUTHORIZED', // additional authorization tier for /forceverify (was a hardcoded role ID)
] as const;

export type RoleMappingType = (typeof ROLE_MAPPING_TYPES)[number];

export function isValidRoleMappingType(value: string): value is RoleMappingType {
  return (ROLE_MAPPING_TYPES as readonly string[]).includes(value);
}

export class RoleMappingService {
  constructor(private readonly repository: RoleMappingRepository) {}

  /** Returns a plain { type: discordRoleId } map of every enabled mapping for a guild. */
  async getEnabledMap(guildConfigId: string): Promise<Partial<Record<RoleMappingType, string>>> {
    const rows = await this.repository.listEnabledByGuildConfig(guildConfigId);
    const map: Partial<Record<RoleMappingType, string>> = {};
    for (const row of rows) {
      if (isValidRoleMappingType(row.type)) {
        map[row.type] = row.discordRoleId;
      }
    }
    return map;
  }

  async setMapping(guildConfigId: string, type: string, discordRoleId: string | null): Promise<void> {
    if (!isValidRoleMappingType(type)) {
      throw new Error(`Unknown role mapping type: ${type}`);
    }
    await this.repository.upsert(guildConfigId, type, discordRoleId);
  }
}
