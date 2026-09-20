import { prisma } from '../database';
import { WarEraService } from '../warera/service';
import { RecruitmentService } from './recruitment.service';
import { RoleMappingService } from './roleMapping.service';
import { UserGetUserLiteResponse } from '../types/Responses';
import { logger } from '../utils/logger';
import { Guild } from 'discord.js';

export interface ReadinessReport {
  verifiedPlayers: number;
  warSpecialists: number;
  economySpecialists: number;
  hybridPlayers: number;
  level50Plus: number;
  level100Plus: number;
  activeCampaignTitle: string | null;
  activeCampaignMinLevel: number | null;
  campaignProgress: {
    eligible: number;
    converted: number;
    remaining: number;
    conversionRate: number;
  } | null;
  operationStats: {
    totalOperations: number;
    totalSent: number;
    totalAvailable: number;
    totalUnavailable: number;
    avgResponseRate: number;
  };
}

export class ReadinessService {
  constructor(
    private readonly wareraService: WarEraService,
    private readonly recruitmentService: RecruitmentService,
    private readonly roleMappingService: RoleMappingService
  ) {}

  /**
   * Generates the MoD Military Readiness Report for the guild
   */
  async generateReadinessReport(guild: Guild): Promise<ReadinessReport> {
    logger.info({ guildId: guild.id }, 'Generating military readiness report');

    const config = await prisma.guildConfig.findUnique({
      where: { guildId: guild.id },
    });

    if (!config?.countryId) {
      logger.warn({ guildId: guild.id }, 'Readiness report skipped: no countryId configured for this guild');
      // Fall through with everything at zero rather than throwing — a guild that hasn't
      // configured a country simply has an empty (not broken) readiness report.
    }
    const countryId = config?.countryId;
    const roleMap = config ? await this.roleMappingService.getEnabledMap(config.id) : {};
    const userLinks = await prisma.userLink.findMany();

    let verifiedPlayers = 0;
    let warSpecialists = 0;
    let economySpecialists = 0;
    let hybridPlayers = 0;
    let level50Plus = 0;
    let level100Plus = 0;

    // Fetch and evaluate profiles concurrently
    await Promise.all(
      userLinks.map(async (link) => {
        try {
          // Fetch Discord member in the guild
          const member = await guild.members.fetch({ user: link.discordId, force: true }).catch(() => null);
          if (!member) return;

          // Check citizen & trusted gate role requirements
          const hasCitizen = roleMap.CITIZEN_GATE ? member.roles.cache.has(roleMap.CITIZEN_GATE) : true;
          const hasTrusted = roleMap.TRUSTED_GATE ? member.roles.cache.has(roleMap.TRUSTED_GATE) : true;
          if (!hasCitizen || !hasTrusted) {
            return;
          }

          if (!countryId) return;

          const profile = await this.wareraService.getUserProfile(link.wareraUserId);
          const belongsToConfiguredCountry = profile.country === countryId;

          if (belongsToConfiguredCountry) {
            verifiedPlayers++;
            
            // Specialization
            const spec = this.recruitmentService.getSpecialization(profile);
            if (spec === 'war') {
              warSpecialists++;
            } else if (spec === 'economy') {
              economySpecialists++;
            } else {
              hybridPlayers++;
            }

            // Levels
            const level = profile.leveling?.level || 0;
            if (level >= 100) {
              level100Plus++;
              level50Plus++; // Naturally level 100 is also level 50+
            } else if (level >= 50) {
              level50Plus++;
            }
          }
        } catch (error) {
          logger.warn(
            { discordId: link.discordId, error: (error as Error).message },
            'Failed to fetch user profile for readiness report'
          );
        }
      })
    );

    // 2. Fetch active campaign details
    let activeCampaignTitle: string | null = null;
    let activeCampaignMinLevel: number | null = null;
    let campaignProgress: ReadinessReport['campaignProgress'] = null;

    try {
      const stats = await this.recruitmentService.getCampaignStats(guild);
      if (stats) {
        activeCampaignTitle = stats.campaign.title;
        activeCampaignMinLevel = stats.campaign.minimumLevel;
        campaignProgress = {
          eligible: stats.eligibleCount,
          converted: stats.convertedCount,
          remaining: stats.remainingCount,
          conversionRate: stats.eligibleCount > 0 ? (stats.convertedCount / stats.eligibleCount) * 100 : 0,
        };
      }
    } catch {
      // Ignored if no campaign active
    }

    // 3. Fetch operation stats
    const operations = await prisma.operation.findMany({
      where: { guildId: guild.id },
      include: { responses: true },
    });

    let totalSent = 0;
    let totalAvailable = 0;
    let totalUnavailable = 0;
    let ratesSum = 0;

    for (const op of operations) {
      totalSent += op.sentToCount;
      let opAvail = 0;
      let opUnavail = 0;

      for (const res of op.responses) {
        if (res.response === 'available') {
          totalAvailable++;
          opAvail++;
        } else if (res.response === 'unavailable') {
          totalUnavailable++;
          opUnavail++;
        }
      }

      const rate = op.sentToCount > 0 ? ((opAvail + opUnavail) / op.sentToCount) * 100 : 0;
      ratesSum += rate;
    }

    const avgResponseRate = operations.length > 0 ? ratesSum / operations.length : 0;

    return {
      verifiedPlayers,
      warSpecialists,
      economySpecialists,
      hybridPlayers,
      level50Plus,
      level100Plus,
      activeCampaignTitle,
      activeCampaignMinLevel,
      campaignProgress,
      operationStats: {
        totalOperations: operations.length,
        totalSent,
        totalAvailable,
        totalUnavailable,
        avgResponseRate,
      },
    };
  }
}
