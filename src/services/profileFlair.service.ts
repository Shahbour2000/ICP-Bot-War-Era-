import { ProfileFlairRepository, ProfileFlairWithTargets } from '../repositories/profileFlair.repository';

/**
 * Determines which flair rules match a given WarEra profile, in priority
 * order, with duplicate identical display text collapsed. Pure and
 * side-effect free — no hardcoded WarEra IDs, MU IDs, or text of any kind;
 * every fact this function needs comes from the `flairs` argument, which is
 * already scoped to one guild by the caller.
 */
export function evaluateProfileFlairs(
  flairs: ProfileFlairWithTargets[],
  profile: { _id: string; mu?: string }
): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const flair of flairs) {
    let matched = false;
    if (flair.triggerType === 'SPECIFIC_USERS') {
      matched = flair.userTargets.some((t) => t.wareraUserId === profile._id);
    } else if (flair.triggerType === 'MILITARY_UNITS') {
      matched = !!profile.mu && flair.muTargets.some((t) => t.muId === profile.mu);
    }

    if (matched && !seen.has(flair.displayText)) {
      seen.add(flair.displayText);
      results.push(flair.displayText);
    }
  }

  return results;
}

export class ProfileFlairService {
  constructor(private readonly repository: ProfileFlairRepository) {}

  async getMatchingFlairText(guildConfigId: string, profile: { _id: string; mu?: string }): Promise<string[]> {
    const flairs = await this.repository.listEnabledByGuildConfig(guildConfigId);
    return evaluateProfileFlairs(flairs, profile);
  }
}
