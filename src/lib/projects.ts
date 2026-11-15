import type { Project } from './types'

export type MemoryPreview = {
  projectId: string
  name: string
  chars: number
}

export function projectById(projects: Project[], id: string | null | undefined): Project | null {
  if (!id) return null
  return projects.find((project) => project.id === id) || null
}

/** Root → leaf. Missing parents and cycles are tolerated. */
export function projectLineage(projects: Project[], projectId: string | null | undefined): Project[] {
  const byId = new Map(projects.map((project) => [project.id, project]))
  const chain: Project[] = []
  const seen = new Set<string>()
  let current = projectId ? byId.get(projectId) : null
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    chain.push(current)
    current = current.parentId ? byId.get(current.parentId) || null : null
  }
  return chain.reverse()
}

export function projectPath(projects: Project[], projectId: string | null | undefined): string {
  return projectLineage(projects, projectId)
    .map((project) => project.name)
    .join(' / ')
}

export function projectDepth(projects: Project[], projectId: string | null | undefined): number {
  return Math.max(0, projectLineage(projects, projectId).length - 1)
}

export function descendantIds(projects: Project[], projectId: string): Set<string> {
  const children = new Map<string | null, Project[]>()
  for (const project of projects) {
    const key = project.parentId || null
    const list = children.get(key)
    if (list) list.push(project)
    else children.set(key, [project])
  }
  const out = new Set<string>()
  const stack = [projectId]
  while (stack.length) {
    const id = stack.pop() as string
    for (const child of children.get(id) || []) {
      if (out.has(child.id)) continue
      out.add(child.id)
      stack.push(child.id)
    }
  }
  return out
}

/**
 * Memory files that will be referenced by the first message in this project.
 * Mirrors the server rule: own project always applies; ancestors only when
 * their `includeSubprojects` is on.
 */
export function resolveMemoryRefs(
  projects: Project[],
  projectId: string | null | undefined,
): MemoryPreview[] {
  const lineage = projectLineage(projects, projectId)
  if (!lineage.length) return []
  const refs: MemoryPreview[] = []
  lineage.forEach((project, index) => {
    const isSelf = index === lineage.length - 1
    if (!project.memoryEnabled || project.memoryChars <= 0) return
    if (!isSelf && !project.includeSubprojects) return
    refs.push({ projectId: project.id, name: project.name, chars: project.memoryChars })
  })
  return refs
}

export type ProjectOption = { id: string; label: string; depth: number }

/** Flattened tree order, used by the "parent project" select. */
export function projectOptions(projects: Project[], excludeId?: string | null): ProjectOption[] {
  const excluded = new Set<string>()
  if (excludeId) {
    excluded.add(excludeId)
    for (const id of descendantIds(projects, excludeId)) excluded.add(id)
  }
  const children = new Map<string | null, Project[]>()
  for (const project of projects) {
    const key = project.parentId || null
    const list = children.get(key)
    if (list) list.push(project)
    else children.set(key, [project])
  }
  const out: ProjectOption[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const project of children.get(parentId) || []) {
      if (excluded.has(project.id)) continue
      out.push({ id: project.id, label: project.name, depth })
      walk(project.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export function formatChars(chars: number): string {
  if (chars >= 10_000) return `${Math.round(chars / 1000)}k 字`
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k 字`
  return `${chars} 字`
}
