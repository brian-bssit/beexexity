/**
 * Static role mapping for all 19 skills.
 * Replaces LLM-generated role selection with deterministic, domain-appropriate roles.
 * Role is injected into the inference system prompt, not the refinement output.
 *
 * @see docs/design-notes/routing-enhance.md — FR-3
 */

import { SkillType } from '../types/routing.types.js';

export const SKILL_TO_ROLE: Record<SkillType, string> = {
  // Generation
  business_writing: 'Business & Professional Communication Specialist',
  creative_writing: 'Creative Writer & Storyteller',
  brainstorming: 'Innovation & Ideation Facilitator',
  prompt_optimizer: 'Prompt Strategy & Optimization Consultant',

  // Transformation
  summarization: 'Information Synthesis Specialist',
  translation: 'Professional Multilingual Translator',
  data_transformation: 'Data Format & Schema Conversion Specialist',
  editing: 'Editorial Review & Proofreading Expert',

  // Interaction
  roleplay: 'Character Roleplay Actor',
  logic_math: 'Mathematics & Logic Problem Solver',
  planning_strategy: 'Strategic Planning & Business Consultant',
  document_analysis: 'Document Intelligence & Research Analyst',

  // Enterprise
  requirement_generation: 'Senior Business & Requirements Analyst',
  compliance_pre_assessment: 'Senior Compliance & Regulatory Auditor',
  risk_analyst: 'Risk Assessment & Mitigation Specialist',
  process_optimization: 'Business Process Improvement Consultant',

  // Engineering
  code: 'Principal Software Engineer',
  log_troubleshooting: 'DevOps & Site Reliability Engineer',
  data_analysis: 'Data Insights & Statistical Analyst',
  cloud_security: 'Cloud Security Engineer',
  credit_analyst: 'Ahli Kredit dan Keuangan',
  meeting_summary: 'Executive Meeting Analyst & Summarizer',
  it_specialist: 'Spesialis Teknologi Informasi',

  // Fallback (explicit, not "general")
  fallback: 'General Purpose Assistant',
};

/**
 * Returns the static role for a given skill.
 * Falls back to 'General Knowledge Assistant' for unknown skills.
 */
export function getRoleForSkill(skill: SkillType): string {
  return SKILL_TO_ROLE[skill] ?? 'General Knowledge Assistant';
}
