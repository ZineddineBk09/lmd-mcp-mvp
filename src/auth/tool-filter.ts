import type { UserPrivilege } from './types.js';
import { TOOL_PERMISSION_MAP } from './permission-map.js';

/**
 * Check if a user has the required privilege for a tool.
 * Returns `true` if the tool is accessible, `false` if blocked.
 */
export function hasToolPermission(toolName: string, privileges: UserPrivilege[]): boolean {
  const requirement = TOOL_PERMISSION_MAP[toolName];

  // Tool not in the map at all -> default-deny
  if (requirement === undefined) return false;

  // null means available to any authenticated user
  if (requirement === null) return true;

  const privilege = privileges.find((p) => p.alias === requirement.alias);

  if (!privilege) return false;

  return privilege.status[requirement.action] === true;
}

/**
 * Filter a list of tool definitions to only those the user has permission for.
 * This is the first line of defense: the LLM never sees tools the user can't use.
 */
export function filterToolsByPermissions<T extends { name: string }>(tools: T[], privileges: UserPrivilege[]): T[] {
  return tools.filter((tool) => hasToolPermission(tool.name, privileges));
}

/**
 * Get the list of missing permissions for a tool.
 * Returns null if the user has all required permissions.
 */
export function getMissingPermission(toolName: string, privileges: UserPrivilege[]): { toolName: string; required: string; message: string } | null {
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
