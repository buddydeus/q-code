import type { Skill } from './types'

const dynamicSkills = new Map<string, Skill>()
const conditionalSkills = new Map<string, Skill>()
let initialized = false

export function setSkills(skills: Skill[]): void {
  dynamicSkills.clear()
  conditionalSkills.clear()

  for (const skill of skills) {
    if (skill.frontmatter.paths && skill.frontmatter.paths.length > 0) {
      conditionalSkills.set(skill.name, skill)
    } else {
      dynamicSkills.set(skill.name, skill)
    }
  }

  initialized = true
}

export function isSkillsInitialized(): boolean {
  return initialized
}

export function getModelVisibleSkills(): Skill[] {
  return [...dynamicSkills.values()].filter((skill) => {
    return !skill.frontmatter.disableModelInvocation
  })
}

export function getAllUserInvocableSkills(): Skill[] {
  return [...dynamicSkills.values(), ...conditionalSkills.values()]
}

export function findSkill(name: string): Skill | undefined {
  return dynamicSkills.get(name) ?? conditionalSkills.get(name)
}

export function activateConditionalSkill(name: string): boolean {
  const skill = conditionalSkills.get(name)
  if (!skill) return false

  conditionalSkills.delete(name)
  dynamicSkills.set(name, skill)
  return true
}

export function listConditionalSkills(): Skill[] {
  return [...conditionalSkills.values()]
}

export function clearSkills(): void {
  dynamicSkills.clear()
  conditionalSkills.clear()
  initialized = false
}
