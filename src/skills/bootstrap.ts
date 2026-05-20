import { loadAllSkills } from './load-skills-dir'
import { setSkills } from './registry'

export interface SkillsBootstrapResult {
  skillCount: number
  conditionalCount: number
  warnings: string[]
}

export async function bootstrapSkills(cwd: string): Promise<SkillsBootstrapResult> {
  const { skills, warnings } = await loadAllSkills(cwd)
  setSkills(skills)

  const conditionalCount = skills.filter((skill) => {
    return skill.frontmatter.paths && skill.frontmatter.paths.length > 0
  }).length
  const visibleCount = skills.filter((skill) => {
    return !skill.frontmatter.disableModelInvocation && !skill.frontmatter.paths?.length
  }).length

  return {
    skillCount: visibleCount,
    conditionalCount,
    warnings
  }
}
