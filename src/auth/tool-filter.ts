import type { UserPrivilege } from './types.js';
import { TOOL_PERMISSION_MAP } from './permission-map.js';

const ADMIN_ROLE = 'admin';

/**
 * Check if a user has the required privilege for a tool.
 * Admin role bypasses all privilege checks.
 * Returns `true` if the tool is accessible, `false` if blocked.
 */
export function hasToolPermission(toolName: string, privileges: UserPrivilege[], role?: string): boolean {
  if (role === ADMIN_ROLE) return true;

  const requirement = TOOL_PERMISSION_MAP[toolName];

  if (requirement === undefined) return false;
  if (requirement === null) return true;

  const privilege = privileges.find((p) => p.alias === requirement.alias);
  if (!privilege) return false;

  return privilege.status[requirement.action] === true;
}

/**
 * Filter a list of tool definitions to only those the user has permission for.
 * Admin role gets all tools unfiltered.
 */
export function filterToolsByPermissions<T extends { name: string }>(tools: T[], privileges: UserPrivilege[], role?: string): T[] {
  if (role === ADMIN_ROLE) return tools;
  return tools.filter((tool) => hasToolPermission(tool.name, privileges, role));
}

/**
 * Get the missing permission for a tool. Returns null if the user has access.
 * Admin role always returns null (full access).
 */
export function getMissingPermission(toolName: string, privileges: UserPrivilege[], role?: string): { toolName: string; required: string; message: string } | null {
  if (role === ADMIN_ROLE) return null;

  const requirement = TOOL_PERMISSION_MAP[toolName];

  if (requirement === undefined) {
    return {
      toolName,
      required: 'unmapped',
      message: `Tool "${toolName}" is not configured for permission checks.`,
    };
  }

  if (requirement === null) return null;

  const privilege = privileges.find((p) => p.alias === requirement.alias);

  if (!privilege || !privilege.status[requirement.action]) {
    return {
      toolName,
      required: `${requirement.alias}:${requirement.action}`,
      message: `You don't have permission to use "${toolName}". Required: ${requirement.alias} (${requirement.action}).`,
    };
  }

  return null;
}
