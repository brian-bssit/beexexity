/**
 * Static role mapping — Tahap 1: the 22-skill taxonomy collapsed to a single
 * deterministic 'fallback' role. Role is injected into the inference system
 * prompt.
 *
 * @see docs/design-notes/routing-enhance.md
 */

import { SkillType } from '../types/routing.types.js';

export const SKILL_TO_ROLE: Record<SkillType, string> = {
  fallback: 'General Purpose Assistant',
};

/**
 * Returns the static role for a given skill.
 * Falls back to 'General Knowledge Assistant' for unknown skills.
 */
export function getRoleForSkill(skill: SkillType): string {
  return SKILL_TO_ROLE[skill] ?? 'General Knowledge Assistant';
}
