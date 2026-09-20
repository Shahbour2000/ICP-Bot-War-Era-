import { Guild, GuildMember, PermissionFlagsBits } from 'discord.js';
import { UserLink } from '@prisma/client';
import { GuildConfigRepository } from '../repositories/guildConfig.repository';
import { MuRoleRepository } from '../repositories/muRole.repository';
import { LevelRoleRepository } from '../repositories/levelRole.repository';
import { UserLinkRepository } from '../repositories/userLink.repository';
import { WarEraService } from '../warera/service';
import { logger } from '../utils/logger';
import { prisma } from '../database';
import { syncMemberNickname } from './nicknameSync.service';
import { PartyGetByIdResponse } from '../types/Responses';
import { RoleMappingService } from './roleMapping.service';
import { MessageTemplateService } from './messageTemplate.service';
import { resolveCitizenStatus } from './citizenship.service';

/**
 * A player's position within a specific WarEra political party, as derived
 * directly from that party's own `leader` / `treasurer` / `councilMembers` /
 * `members` fields. WarEra remains the sole source of truth for this value —
 * it is never persisted locally.
 */
export type PartyPosition = 'president' | 'treasurer' | 'council' | 'member' | 'none';

/** The subset of a role map relevant to political party role assignment. */
export interface PartyRoleConfig {
  partyPresidentRoleId?: string | null;
  partyTreasurerRoleId?: string | null;
  partyCouncilRoleId?: string | null;
  partyMemberRoleId?: string | null;
}

/**
 * Determines a WarEra user's position within a given party using only the
 * party's own roster fields. Exported (and kept pure/side-effect free) so it
 * can be unit tested without mocking Discord.js or the database.
 */
export function determinePartyPosition(
  party: Pick<PartyGetByIdResponse, 'leader' | 'treasurer' | 'councilMembers' | 'members'>,
  wareraUserId: string
): PartyPosition {
  if (party.leader && party.leader === wareraUserId) return 'president';
  if (party.treasurer && party.treasurer === wareraUserId) return 'treasurer';
  if (Array.isArray(party.councilMembers) && party.councilMembers.includes(wareraUserId)) {
    return 'council';
  }
  if (Array.isArray(party.members) && party.members.includes(wareraUserId)) return 'member';
  return 'none';
}

/**
 * Resolves the exact set of configured Discord role IDs that should be
 * assigned for a given party position. Party President / Treasurer / Council
 * ALWAYS also receive the Party Member role; 'none' resolves to no roles at
 * all (all party roles get removed by the normal managed-role diffing).
 */
export function resolvePartyTargetRoleIds(position: PartyPosition, config: PartyRoleConfig): string[] {
  const roles: string[] = [];
  if (position === 'president' && config.partyPresidentRoleId) roles.push(config.partyPresidentRoleId);
  if (position === 'treasurer' && config.partyTreasurerRoleId) roles.push(config.partyTreasurerRoleId);
  if (position === 'council' && config.partyCouncilRoleId) roles.push(config.partyCouncilRoleId);
  if (position !== 'none' && config.partyMemberRoleId) roles.push(config.partyMemberRoleId);
  return roles;
}

export class RoleSyncService {
  constructor(
    private readonly guildConfigRepo: GuildConfigRepository,
    private readonly muRoleRepo: MuRoleRepository,
    private readonly levelRoleRepo: LevelRoleRepository,
    private readonly userLinkRepo: UserLinkRepository,
    private readonly wareraService: WarEraService,
    private readonly roleMappingService: RoleMappingService,
    private readonly messageTemplateService: MessageTemplateService
  ) {}

  /**
   * Syncs roles for a single linked member in a specific guild
   */
  async syncMember(guild: Guild, memberParam: GuildMember, userLink: UserLink): Promise<void> {
    const logCtx = { guildId: guild.id, userId: memberParam.id, wareraUserId: userLink.wareraUserId };
    logger.info(logCtx, `Starting role sync for member ${memberParam.user.tag}`);

    try {
      // 0. Force-fetch the latest member object from Discord API to bypass caching issues
      let member = memberParam;
      try {
        member = await guild.members.fetch({ user: memberParam.id, force: true });
      } catch (fetchErr) {
        logger.warn(
          logCtx,
          `Failed to force-fetch latest member from Discord API, relying on cached member: ${(fetchErr as Error).message}`
        );
      }
      // 1. Get configurations
      const config = await this.guildConfigRepo.getByGuildId(guild.id);
      if (!config) {
        logger.warn(logCtx, 'No GuildConfig found for this guild, skipping role sync');
        return;
      }

      const muRoles = await this.muRoleRepo.listByGuild(guild.id);
      const levelRoles = await this.levelRoleRepo.listByGuild(guild.id);
      // Single source of truth for "which Discord role = which WarEra role type, in THIS
      // guild" — the old fixed GuildConfig columns (presidentRoleId, etc.) are no longer
      // read here at all; see RoleMappingService for the full type list.
      const roleMap = await this.roleMappingService.getEnabledMap(config.id);

      // 2. Fetch latest profile
      const profile = await this.wareraService.getUserProfile(userLink.wareraUserId);

      // Synchronize Discord nickname to match WarEra username
      await syncMemberNickname(guild, member, profile.username);

      // 3. Update username in DB if changed
      if (profile.username !== userLink.wareraUsername) {
        logger.info(
          { ...logCtx, oldUsername: userLink.wareraUsername, newUsername: profile.username },
          'Updating WarEra username in database'
        );
        await this.userLinkRepo.upsertUserLink(
          userLink.discordId,
          userLink.wareraUserId,
          profile.username
        );
      }

      // 4. Determine all managed roles first
      const managedRoleIds = new Set<string>();
      const targetRoleIds = new Set<string>();

      // Country roles (government positions) — only meaningful if this guild has a
      // configured countryId; not gated to any specific country.
      [roleMap.PRESIDENT, roleMap.VICE_PRESIDENT, roleMap.CONGRESS].forEach((id) => {
        if (id) managedRoleIds.add(id);
      });

      // MU roles
      muRoles.forEach(r => managedRoleIds.add(r.discordRoleId));

      // Level roles
      levelRoles.forEach(r => managedRoleIds.add(r.discordRoleId));

      // Specialization roles
      [roleMap.WAR_SPECIALIST, roleMap.ECONOMY_SPECIALIST, roleMap.HYBRID_SPECIALIST].forEach((id) => {
        if (id) managedRoleIds.add(id);
      });

      // MU Leadership & No MU roles
      [roleMap.MU_COMMANDER, roleMap.MU_OWNER, roleMap.NO_MU].forEach((id) => {
        if (id) managedRoleIds.add(id);
      });

      // Education roles — now fully optional/configurable; only managed at all if this
      // guild has actually mapped at least one of them (previously these were two
      // hardcoded, always-on Discord role IDs regardless of guild).
      if (roleMap.EDUCATION_LEVEL_1) managedRoleIds.add(roleMap.EDUCATION_LEVEL_1);
      if (roleMap.EDUCATION_LEVEL_2) managedRoleIds.add(roleMap.EDUCATION_LEVEL_2);

      // Verified-citizen role — only managed at all if this guild has opted into
      // automatic citizenship checking (see resolveCitizenStatus below).
      if (config.citizenshipCheckEnabled && roleMap.VERIFIED_CITIZEN) {
        managedRoleIds.add(roleMap.VERIFIED_CITIZEN);
      }

      // Check Citizen Gate & Trusted Gate role status (both act as trust/verification
      // checks). These roles are assigned manually by server staff — the bot NEVER
      // assigns or removes them itself. If the member lacks both, synchronization for
      // every OTHER managed role stops entirely. (Distinct from VERIFIED_CITIZEN above,
      // which the bot DOES assign automatically based on WarEra country membership —
      // these are deliberately two separate concepts, see citizenship.service.ts.)
      const hasCitizenGate = roleMap.CITIZEN_GATE ? member.roles.cache.has(roleMap.CITIZEN_GATE) : true;
      const hasTrustedGate = roleMap.TRUSTED_GATE ? member.roles.cache.has(roleMap.TRUSTED_GATE) : true;
      const isTrusted = hasCitizenGate || hasTrustedGate;

      if (!isTrusted) {
        logger.info(logCtx, `Member ${member.user.tag} lacks the citizen or trusted gate role. All managed roles will be removed.`);
      } else {
        // --- Country Roles (Government) ---
        // Driven entirely by this guild's own configured countryId — no assumption
        // about which country that is. If this guild hasn't configured one, government
        // roles are simply never computed (equivalent to "not applicable").
        if (config.countryId) {
          try {
            const gov = await this.wareraService.getGovernment(config.countryId);
            if (profile._id === gov.president && roleMap.PRESIDENT) {
              targetRoleIds.add(roleMap.PRESIDENT);
            }
            if (profile._id === gov.vicePresident && roleMap.VICE_PRESIDENT) {
              targetRoleIds.add(roleMap.VICE_PRESIDENT);
            }
            if (gov.congressMembers && gov.congressMembers.includes(profile._id) && roleMap.CONGRESS) {
              targetRoleIds.add(roleMap.CONGRESS);
            }
          } catch (govError) {
            logger.error(
              { ...logCtx, error: (govError as Error).message },
              'Failed to fetch government details during role sync'
            );
          }

          // --- Verified Citizen (automatic) ---
          // Distinct from the manual CITIZEN_GATE/TRUSTED_GATE roles above: this one IS
          // assigned/removed automatically by the bot, purely based on whether the
          // player's own profile.country matches this guild's configured countryId.
          const citizenStatus = resolveCitizenStatus(profile.country, config);
          if (citizenStatus === 'citizen' && roleMap.VERIFIED_CITIZEN) {
            targetRoleIds.add(roleMap.VERIFIED_CITIZEN);
          }
          // 'not_citizen' -> deliberately add nothing, so the role falls out of the
          // add/remove diff naturally. 'not_applicable' can't happen inside this
          // `if (config.countryId)` branch since resolveCitizenStatus requires it.
        }

        // --- MU Roles (Active Membership) ---
        if (profile.mu) {
          const muMapping = muRoles.find(m => m.muId === profile.mu);
          if (muMapping) {
            targetRoleIds.add(muMapping.discordRoleId);
          }
        }

        // --- MU Roles (Ownership) ---
        // Additionally assign Discord roles for every MU the player owns.
        // Uses Set (targetRoleIds) for natural deduplication if active MU == owned MU.
        let isAnyMuOwner = false;
        try {
          const ownedMus = await this.wareraService.getOwnedMus(profile._id);
          if (ownedMus.length > 0) {
            isAnyMuOwner = true;
            logger.info(
              { ...logCtx, ownedMuCount: ownedMus.length, ownedMuNames: ownedMus.map(mu => mu.name) },
              `Player owns ${ownedMus.length} MU(s)`
            );
            for (const ownedMu of ownedMus) {
              const muMapping = muRoles.find(m => m.muId === ownedMu._id);
              if (muMapping) {
                targetRoleIds.add(muMapping.discordRoleId);
              }
            }
          }
        } catch (ownedMuErr) {
          logger.error(
            { ...logCtx, error: (ownedMuErr as Error).message },
            'Failed to fetch owned MUs, continuing with active MU only'
          );
        }

        // --- Level Roles ---
        const userLevel = profile.leveling?.level || 0;
        const matchingLevelRoles = levelRoles.filter(lr => userLevel >= lr.minimumLevel);
        if (matchingLevelRoles.length > 0) {
          const highestMatching = matchingLevelRoles.reduce((max, current) => 
            current.minimumLevel > max.minimumLevel ? current : max
          );
          targetRoleIds.add(highestMatching.discordRoleId);
        }

        // --- Specialization Roles ---
        const skills = profile.skills || {};
        
        const warScore =
          (skills.attack?.level || 0) +
          (skills.precision?.level || 0) +
          (skills.criticalChance?.level || 0) +
          (skills.criticalDamages?.level || 0) +
          (skills.armor?.level || 0) +
          (skills.dodge?.level || 0) +
          (skills.lootChance?.level || 0);

        const economyScore =
          (skills.production?.level || 0) +
          (skills.management?.level || 0) +
          (skills.entrepreneurship?.level || 0) +
          (skills.companies?.level || 0);

        let targetSpecRoleId: string | null = null;
        if (warScore >= economyScore * 1.5) {
          targetSpecRoleId = roleMap.WAR_SPECIALIST || null;
        } else if (economyScore >= warScore * 1.5) {
          targetSpecRoleId = roleMap.ECONOMY_SPECIALIST || null;
        } else {
          targetSpecRoleId = roleMap.HYBRID_SPECIALIST || null;
        }

        if (targetSpecRoleId) {
          targetRoleIds.add(targetSpecRoleId);
        }

        // --- MU Leadership & No MU Roles ---
        
        // 1. Global Ownership Check
        // If the player owns ANY Military Unit, they receive both the Owner and Commander roles.
        if (isAnyMuOwner) {
          if (roleMap.MU_OWNER) targetRoleIds.add(roleMap.MU_OWNER);
          if (roleMap.MU_COMMANDER) targetRoleIds.add(roleMap.MU_COMMANDER);
        }

        // 2. Active MU Check (for non-owners who might be Commanders in their active MU)
        if (profile.mu) {
          try {
            const muDetails = await this.wareraService.getMu(profile.mu);
            const isCommander = muDetails.roles?.commanders?.includes(profile._id) || false;

            if (isCommander && roleMap.MU_COMMANDER) {
              targetRoleIds.add(roleMap.MU_COMMANDER);
            }
          } catch (muErr) {
            logger.error(
              { ...logCtx, muId: profile.mu, error: (muErr as Error).message },
              'Failed to fetch MU details for commander check during role sync'
            );
          }
        } else {
          // If they are not actively in ANY Military Unit
          if (roleMap.NO_MU) {
            targetRoleIds.add(roleMap.NO_MU);
          }
        }

        // --- Education Roles (Mutually Exclusive, fully optional) ---
        // Rule: A player qualifies for Education LVL 2 ONLY if:
        // - WarEra level >= 15
        // - At least 4 separate companies
        // - At least 4 of those companies are Level 4 or higher (automatedEngine >= 4)
        // If they qualify for Education LVL 2 -> assign Education LVL 2 ONLY (LVL 1 removed).
        // Otherwise -> assign Education LVL 1 ONLY (LVL 2 removed).
        // If this guild hasn't mapped either role, this entire block is a no-op (neither
        // ID exists to add to targetRoleIds).
        let qualifiesEducationLvl2 = false;

        if ((roleMap.EDUCATION_LEVEL_1 || roleMap.EDUCATION_LEVEL_2) && userLevel >= 15) {
          try {
            const companies = await this.wareraService.getUserCompanies(profile._id);
            if (companies.length >= 4) {
              const level4OrHigherCount = companies.filter((c) => {
                const engineLevel = c.activeUpgradeLevels?.automatedEngine || 0;
                const companyLevel = (c as any).level || 0;
                return Math.max(engineLevel, companyLevel) >= 4;
              }).length;

              if (level4OrHigherCount >= 4) {
                qualifiesEducationLvl2 = true;
                logger.info(
                  { ...logCtx, totalCompanies: companies.length, level4OrHigherCount },
                  'Player qualifies for Education LVL 2'
                );
              }
            }
          } catch (eduErr) {
            logger.error(
              { ...logCtx, error: (eduErr as Error).message },
              'Failed to evaluate Education LVL 2 requirements'
            );
          }
        }

        if (qualifiesEducationLvl2 && roleMap.EDUCATION_LEVEL_2) {
          targetRoleIds.add(roleMap.EDUCATION_LEVEL_2);
        } else if (!qualifiesEducationLvl2 && roleMap.EDUCATION_LEVEL_1) {
          targetRoleIds.add(roleMap.EDUCATION_LEVEL_1);
        }

        // Recruitment Completion Detection: transition to War Specialist
        if (roleMap.WAR_SPECIALIST) {
          const previouslyWasNotWar = !member.roles.cache.has(roleMap.WAR_SPECIALIST);
          const nowIsWar = targetSpecRoleId === roleMap.WAR_SPECIALIST;

          if (previouslyWasNotWar && nowIsWar) {
            try {
              const activeCampaign = await prisma.recruitmentCampaign.findFirst({
                where: { guildId: guild.id, active: true },
              });
              if (activeCampaign) {
                const dmText = await this.messageTemplateService.render(config.id, 'recruitment_completion_dm', {
                  communityName: config.communityName || guild.name,
                });
                await member.send({ content: dmText }).catch(() => null);
                logger.info({ userId: member.id }, 'Recruitment completion DM sent successfully');
              }
            } catch (campaignErr) {
              logger.error({ error: (campaignErr as Error).message }, 'Failed during recruitment completion check');
            }
          }
        }

        // --- Political Party Roles ---
        // WarEra is the source of truth for party membership/position; nothing about a
        // player's party is ever stored locally. This guild's configured party (if any)
        // is fetched fresh on every sync, and the player's position within it is derived
        // directly from that party's own leader/treasurer/councilMembers/members fields.
        const partyMappingConfig: PartyRoleConfig = {
          partyPresidentRoleId: roleMap.PARTY_PRESIDENT,
          partyTreasurerRoleId: roleMap.PARTY_TREASURER,
          partyCouncilRoleId: roleMap.PARTY_COUNCIL,
          partyMemberRoleId: roleMap.PARTY_MEMBER,
        };
        const partyRoleIdsConfigured = Object.values(partyMappingConfig).some((id) => !!id);

        if (!config.partyId) {
          if (partyRoleIdsConfigured) {
            logger.debug(
              logCtx,
              'Party roles are configured for this guild but no Party ID is configured (/config party-id) — skipping party sync'
            );
          }
        } else if (!partyRoleIdsConfigured) {
          logger.debug(
            { ...logCtx, partyId: config.partyId },
            'Party ID is configured for this guild but no party roles are configured — skipping party sync'
          );
        } else {
          try {
            const party = await this.wareraService.getParty(config.partyId);

            // The party fetch succeeded, so we now have a definitive answer. Only from
            // this point on do party roles become part of the managed set for this cycle —
            // if the fetch throws below, none of this runs and existing party roles on the
            // member are left completely untouched.
            Object.values(partyMappingConfig).forEach((id) => {
              if (id) managedRoleIds.add(id);
            });

            const position = determinePartyPosition(party, profile._id);
            const partyTargetRoles = resolvePartyTargetRoleIds(position, partyMappingConfig);
            partyTargetRoles.forEach((id) => targetRoleIds.add(id));

            if (position === 'none') {
              logger.info(
                { ...logCtx, partyId: config.partyId, partyName: party.name },
                'Party sync: member does not belong to the configured party, party roles will be removed if present'
              );
            } else {
              logger.info(
                { ...logCtx, partyId: config.partyId, partyName: party.name, position },
                `Party sync: member detected as party ${position}`
              );
            }
          } catch (partyErr) {
            // Distinguish "confirmed not in party" from "we don't know" — a failed
            // request must NEVER cause existing party roles to be blindly removed.
            logger.error(
              { ...logCtx, partyId: config.partyId, error: (partyErr as Error).message },
              'Party sync: WarEra Party API unavailable this cycle, existing party roles will be preserved untouched'
            );
          }
        }
      }

      // 5. Clean up missing roles from Discord cache
      // If a role doesn't exist in the guild, we should not attempt to manage it.
      for (const roleId of managedRoleIds) {
        if (!guild.roles.cache.has(roleId)) {
          managedRoleIds.delete(roleId);
          targetRoleIds.delete(roleId);
          logger.warn({ ...logCtx, roleId }, 'Role is configured but does not exist in the Discord guild');
        }
      }

      // 6. Calculate adds and removes
      const currentRoles = member.roles.cache;
      const rolesToAdd = Array.from(targetRoleIds).filter(id => !currentRoles.has(id));
      const rolesToRemove = Array.from(managedRoleIds).filter(id => currentRoles.has(id) && !targetRoleIds.has(id));

      // Get bot user details and roles for diagnostics
      const me = guild.members.me || await guild.members.fetch({ user: guild.client.user.id, force: true }).catch(() => null);
      const botHighestRole = me?.roles.highest;
      const memberHighestRole = member.roles.highest;

      // 7. Apply role additions
      for (const roleId of rolesToAdd) {
        const targetRole = guild.roles.cache.get(roleId);
        const detailCtx = {
          ...logCtx,
          roleId,
          roleName: targetRole?.name || 'Unknown',
          rolePosition: targetRole?.position ?? -1,
          botHighestRoleName: botHighestRole?.name || 'Unknown',
          botHighestRolePosition: botHighestRole?.position ?? -1,
          memberHighestRoleName: memberHighestRole?.name || 'Unknown',
          memberHighestRolePosition: memberHighestRole?.position ?? -1,
        };

        if (!me) {
          logger.error(detailCtx, 'Failed to assign role: Bot member object not found in guild cache');
          continue;
        }

        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
          logger.error(detailCtx, 'Failed to assign role: Bot lacks ManageRoles permission in this guild');
          continue;
        }

        if (targetRole && botHighestRole && targetRole.position >= botHighestRole.position) {
          logger.error(
            detailCtx,
            `Failed to assign role '${targetRole.name}': Role position is equal to or higher than the bot's highest role '${botHighestRole.name}' in the hierarchy`
          );
          continue;
        }

        if (botHighestRole && memberHighestRole && memberHighestRole.position >= botHighestRole.position) {
          logger.error(
            detailCtx,
            `Failed to assign role '${targetRole?.name || 'Unknown'}': Member highest role '${memberHighestRole.name}' is equal to or higher than the bot's highest role '${botHighestRole.name}' in the hierarchy`
          );
          continue;
        }

        try {
          await member.roles.add(roleId);
          logger.info({ ...logCtx, roleId, roleName: targetRole?.name || 'Unknown' }, 'Successfully assigned role to user');
        } catch (addErr) {
          logger.error(
            { ...detailCtx, error: (addErr as Error).message },
            'Failed to assign role (missing permissions or role hierarchy issues)'
          );
        }
      }

      // 8. Apply role removals
      for (const roleId of rolesToRemove) {
        const targetRole = guild.roles.cache.get(roleId);
        const detailCtx = {
          ...logCtx,
          roleId,
          roleName: targetRole?.name || 'Unknown',
          rolePosition: targetRole?.position ?? -1,
          botHighestRoleName: botHighestRole?.name || 'Unknown',
          botHighestRolePosition: botHighestRole?.position ?? -1,
          memberHighestRoleName: memberHighestRole?.name || 'Unknown',
          memberHighestRolePosition: memberHighestRole?.position ?? -1,
        };

        if (!me) {
          logger.error(detailCtx, 'Failed to remove role: Bot member object not found in guild cache');
          continue;
        }

        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
          logger.error(detailCtx, 'Failed to remove role: Bot lacks ManageRoles permission in this guild');
          continue;
        }

        if (targetRole && botHighestRole && targetRole.position >= botHighestRole.position) {
          logger.error(
            detailCtx,
            `Failed to remove role '${targetRole.name}': Role position is equal to or higher than the bot's highest role '${botHighestRole.name}' in the hierarchy`
          );
          continue;
        }

        if (botHighestRole && memberHighestRole && memberHighestRole.position >= botHighestRole.position) {
          logger.error(
            detailCtx,
            `Failed to remove role '${targetRole?.name || 'Unknown'}': Member highest role '${memberHighestRole.name}' is equal to or higher than the bot's highest role '${botHighestRole.name}' in the hierarchy`
          );
          continue;
        }

        try {
          await member.roles.remove(roleId);
          logger.info({ ...logCtx, roleId, roleName: targetRole?.name || 'Unknown' }, 'Successfully removed role from user');
        } catch (removeErr) {
          logger.error(
            { ...detailCtx, error: (removeErr as Error).message },
            'Failed to remove role (missing permissions or role hierarchy issues)'
          );
        }
      }

      // 9. Update last sync time
      await prisma.userLink.update({
        where: { id: userLink.id },
        data: { updatedAt: new Date() },
      }).catch(() => null);

      logger.info(
        { ...logCtx, added: rolesToAdd.length, removed: rolesToRemove.length },
        `Role sync finished successfully for ${member.user.tag}`
      );
    } catch (error) {
      logger.error({ ...logCtx, error: (error as Error).message }, 'Failed role sync workflow for member');
      throw error;
    }
  }

  /**
   * Syncs roles for a single user across all mutual guilds
   */
  async syncUserAcrossGuilds(userLink: UserLink, guilds: Guild[]): Promise<void> {
    for (const guild of guilds) {
      try {
        const member = await guild.members.fetch({ user: userLink.discordId, force: true }).catch(() => null);
        if (member) {
          await this.syncMember(guild, member, userLink);
        }
      } catch (error) {
        logger.error(
          { guildId: guild.id, discordId: userLink.discordId, error: (error as Error).message },
          'Failed to sync user in guild'
        );
      }
    }
  }
}
