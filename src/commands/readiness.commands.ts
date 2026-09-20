import { ChatInputCommandInteraction, EmbedBuilder, GuildMember, PermissionFlagsBits } from 'discord.js';
import { ReadinessService } from '../services/readiness.service';
import { MessageTemplateService } from '../services/messageTemplate.service';
import { GuildConfigRepository } from '../repositories/guildConfig.repository';
import { RoleMappingService } from '../services/roleMapping.service';
import { logger } from '../utils/logger';

export class ReadinessCommands {
  constructor(
    private readonly readinessService: ReadinessService,
    private readonly guildConfigRepo: GuildConfigRepository,
    private readonly messageTemplateService: MessageTemplateService,
    private readonly roleMappingService: RoleMappingService
  ) {}

  /**
   * Helper to check if member is admin or has configured officer role
   */
  private async isOfficerOrAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
    const member = interaction.member as GuildMember;
    if (!member) return false;

    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
      return true;
    }

    const config = await this.guildConfigRepo.getByGuildId(interaction.guildId || '');
    if (!config) return false;

    // Prefer the new RoleMapping (OFFICER); fall back to the old officerRoleId column
    // during the compatibility window in case a guild's data hasn't been migrated yet.
    const roleMap = await this.roleMappingService.getEnabledMap(config.id);
    const officerRoleId = roleMap.OFFICER || config.officerRoleId;
    if (officerRoleId) {
      return member.roles.cache.has(officerRoleId);
    }

    return false;
  }

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;

    if (!guildId) {
      await interaction.reply({ content: '❌ This command must be run inside a guild.', ephemeral: true });
      return;
    }

    // Check Permissions
    const isAuthorized = await this.isOfficerOrAdmin(interaction);
    if (!isAuthorized) {
      await interaction.reply({
        content: '❌ You do not have permission to view the Military Readiness Report.',
        ephemeral: true,
      });
      return;
    }

    logger.info({ guildId, userId: interaction.user.id }, 'Generating readiness report command');
    await interaction.deferReply();

    try {
      const report = await this.readinessService.generateReadinessReport(interaction.guild!);
      const config = await this.guildConfigRepo.getByGuildId(guildId);
      const title = config
        ? await this.messageTemplateService.render(config.id, 'readiness_title', {
            communityName: config.communityName || interaction.guild!.name,
          })
        : `🇪🇬 ${interaction.guild!.name} Ministry of Defense | Military Readiness Report`;

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor((config?.accentColor as `#${string}`) || '#D00000')
        .addFields(
          {
            name: '👥 Personnel Overview',
            value: `• **Verified Players:** \`${report.verifiedPlayers}\`\n• **War Specialists (Active Military):** \`${report.warSpecialists}\`\n• **Economy Specialists:** \`${report.economySpecialists}\`\n• **Hybrid Players:** \`${report.hybridPlayers}\``,
            inline: false,
          },
          {
            name: '📈 Level Thresholds',
            value: `• **Level 50+:** \`${report.level50Plus}\`\n• **Level 100+:** \`${report.level100Plus}\``,
            inline: false,
          }
        )
        .setTimestamp()
        .setFooter({ text: 'WarEra Roles Bot' });

      // Add Active Recruitment Campaign if present
      if (report.activeCampaignTitle) {
        const campaignProgressText = report.campaignProgress
          ? `• **Eligible Players:** \`${report.campaignProgress.eligible}\`\n• **Converted:** \`${report.campaignProgress.converted}\` (${report.campaignProgress.conversionRate.toFixed(1)}%)\n• **Remaining:** \`${report.campaignProgress.remaining}\``
          : 'Progress stats unavailable.';

        embed.addFields({
          name: `📢 Active Mobilization: "${report.activeCampaignTitle}" (Level ${report.activeCampaignMinLevel}+)`,
          value: campaignProgressText,
          inline: false,
        });
      } else {
        embed.addFields({
          name: '📢 Active Mobilization Campaign',
          value: '*No active recruitment campaign.*',
          inline: false,
        });
      }

      // Add Operation Stats
      const opStats = report.operationStats;
      if (opStats.totalOperations > 0) {
        embed.addFields({
          name: '🚨 Operations & Directives Statistics',
          value: `• **Total Operations Launched:** \`${opStats.totalOperations}\`\n• **Direct DMs Dispatched:** \`${opStats.totalSent}\` DMs\n• **Responses Logged:** \`${opStats.totalAvailable + opStats.totalUnavailable}\` (\`✅ ${opStats.totalAvailable}\` / \`❌ ${opStats.totalUnavailable}\`)\n• **Average Response Rate:** \`${opStats.avgResponseRate.toFixed(1)}%\``,
          inline: false,
        });
      } else {
        embed.addFields({
          name: '🚨 Operations & Directives Statistics',
          value: '*No operations logged yet.*',
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error({ error: (err as Error).message, guildId }, 'Failed to generate readiness report command');
      await interaction.editReply({
        content: `❌ Failed to generate military readiness report: ${(err as Error).message}`,
      });
    }
  }
}
