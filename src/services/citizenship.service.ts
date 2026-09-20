export type CitizenStatus = 'citizen' | 'not_citizen' | 'not_applicable';

/**
 * Determines whether a linked WarEra profile counts as a "citizen" of the
 * guild currently being synced — driven entirely by that guild's own
 * configuration, never by any hardcoded country.
 *
 * 'not_applicable' means this guild hasn't opted into automatic citizenship
 * checking at all (citizenshipCheckEnabled is false, or no countryId is
 * configured) — callers must treat this as "skip the check", not as
 * "not a citizen", so guilds that never enable this feature see zero
 * behavior change.
 */
export function resolveCitizenStatus(
  profileCountryId: string | undefined,
  guildConfig: { citizenshipCheckEnabled: boolean; countryId: string | null }
): CitizenStatus {
  if (!guildConfig.citizenshipCheckEnabled || !guildConfig.countryId) {
    return 'not_applicable';
  }
  return profileCountryId === guildConfig.countryId ? 'citizen' : 'not_citizen';
}
