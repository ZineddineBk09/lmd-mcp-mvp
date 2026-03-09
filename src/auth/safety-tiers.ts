import type { SafetyTier } from './types.js';

/**
 * Safety tier classification for write tools.
 * - auto: execute immediately (low-risk)
 * - confirm: return preview first, execute only with confirmed=true
 * - always_confirm: same as confirm + server-side verification
 */
export const TOOL_SAFETY_TIER: Record<string, SafetyTier> = {
  accept_order: 'confirm',
  reject_order: 'always_confirm',
  cancel_order: 'always_confirm',
};

export const WRITE_TOOL_NAMES = new Set(['accept_order', 'reject_order', 'cancel_order']);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOL_NAMES.has(toolName);
}

export function getSafetyTier(toolName: string): SafetyTier {
  return TOOL_SAFETY_TIER[toolName] ?? 'auto';
}

export function requiresConfirmation(toolName: string): boolean {
  const tier = getSafetyTier(toolName);
  return tier === 'confirm' || tier === 'always_confirm';
}
