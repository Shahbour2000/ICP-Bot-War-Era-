import { MessageTemplateRepository } from '../repositories/messageTemplate.repository';

/**
 * Every supported template key, its default (= today's exact hardcoded
 * text, so an un-configured guild's output is byte-for-byte unchanged),
 * and the ONLY placeholders that key will ever substitute. This list is
 * deliberately short — it is the real result of auditing the bot's actual
 * user-facing strings, not a generic "make everything configurable" pass.
 */
export const MESSAGE_TEMPLATES: Record<string, { default: string; placeholders: string[] }> = {
  verify_success: {
    default: '✅ Verified and synced roles for **{wareraUsername}** (Level {level}).',
    placeholders: ['wareraUsername', 'level'],
  },
  verify_not_found: {
    default: '❌ Could not find any WarEra player matching **{username}**. Please verify the spelling and try again.',
    placeholders: ['username'],
  },
  branding_footer: {
    default: '{communityName} Roles Bot',
    placeholders: ['communityName'],
  },
  recruitment_reminder_dm: {
    default:
      '🇪🇬 **{communityName} Ministry of Defense**\n\nYou are eligible for military service.\n\n**Current Status:**\n- Level: `{level}` (Requirement: `{minimumLevel}`+)\n- Specialization: `{specialization}`\n\n*Please switch your build to War specialization.*\n\nThis is an automated reminder.',
    placeholders: ['communityName', 'level', 'minimumLevel', 'specialization'],
  },
  operation_alert_dm: {
    default:
      '🚨 **{communityName} Military Operation**\n\n**Operation:**\n{title}\n\n**Objective:**\n{message}\n\n*Please join military channels immediately.*\n\n**Issued by:** {issuer}\n**Time:** {timestamp}',
    placeholders: ['communityName', 'title', 'message', 'issuer', 'timestamp'],
  },
  readiness_title: {
    default: '🇪🇬 {communityName} Ministry of Defense | Military Readiness Report',
    placeholders: ['communityName'],
  },
  recruitment_completion_dm: {
    default:
      '✅ **Thank you for joining the {communityName} military.**\n\nYou are now registered as a War Specialist.\n\n*Future recruitment reminders for this campaign have been stopped for you.*',
    placeholders: ['communityName'],
  },
};

export type MessageTemplateKey = keyof typeof MESSAGE_TEMPLATES;

/**
 * Literal `{key}` substitution ONLY — no eval, no Function constructor, no
 * conditionals/loops. This is a hard security boundary: template content is
 * admin-authored data, never executable code.
 */
function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match));
}

export class MessageTemplateService {
  constructor(private readonly repository: MessageTemplateRepository) {}

  async render(guildConfigId: string, key: MessageTemplateKey, vars: Record<string, string>): Promise<string> {
    const spec = MESSAGE_TEMPLATES[key];
    if (!spec) {
      throw new Error(`Unknown message template key: ${key}`);
    }
    const override = await this.repository.getByKey(guildConfigId, key);
    const template = override?.content || spec.default;
    // Only ever substitute the documented placeholders for this key, even if
    // the caller passed extra vars — keeps behavior predictable per key.
    const scopedVars: Record<string, string> = {};
    for (const p of spec.placeholders) {
      if (p in vars) scopedVars[p] = vars[p];
    }
    return substitute(template, scopedVars);
  }
}
