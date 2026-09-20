const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

/**
 * True if the given Discord permission bitfield (decimal string, as returned
 * by /users/@me/guilds) includes Administrator or Manage Server. This is the
 * ONLY thing that grants dashboard access to a guild — never the mere fact
 * that the user is a member of it.
 */
export function hasManageAccess(permissions: string | undefined): boolean {
  if (!permissions) return false;
  try {
    const bits = BigInt(permissions);
    return (bits & ADMINISTRATOR) === ADMINISTRATOR || (bits & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}
