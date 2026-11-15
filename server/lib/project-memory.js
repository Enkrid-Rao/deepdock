// Turn project memory files into one prompt prefix for the first message of a
// conversation. The prefix is only sent upstream — the UI shows a reference
// chip instead of pasting the Markdown into the composer.

export const PROJECT_MEMORY_LIMIT = 24_000

/**
 * @param {import('./store.js').Store} store
 * @param {string|null} projectId
 * @returns {Promise<{ text: string, refs: { projectId: string, name: string, chars: number, file: string }[] } | null>}
 */
export async function buildProjectMemoryPrompt(store, projectId) {
  if (!projectId) return null
  const chain = await store.resolveProjectMemory(projectId)
  if (!chain.length) return null

  const blocks = []
  const refs = []
  let used = 0

  for (const entry of chain) {
    const content = entry.content.trim()
    if (!content) continue
    if (used >= PROJECT_MEMORY_LIMIT) break

    let text = content
    const remaining = PROJECT_MEMORY_LIMIT - used
    if (text.length > remaining) {
      if (remaining < 200) break
      text = `${text.slice(0, remaining)}\n\n（项目记忆过长，已截断）`
    }

    blocks.push(`## 项目：${entry.project.name}\n${text}`)
    refs.push({
      projectId: entry.project.id,
      name: entry.project.name,
      chars: entry.chars,
      file: entry.file,
    })
    used += text.length
  }

  if (!blocks.length) return null

  const intro =
    '以下内容是我在 DeepDock 中为这段对话所属项目设置的「项目记忆」。请把它当作对话的长期背景与约定；如果它与本次提问冲突，以本次提问为准。'

  return {
    text: `${intro}\n\n${blocks.join('\n\n---\n\n')}\n\n---\n\n`,
    refs,
  }
}
