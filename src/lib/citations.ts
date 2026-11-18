// DeepSeek writes search citations inline as `[reference:N]`, where N indexes
// the message's reference list (0-based). The web front-end turns each one into
// a small superscript chip that links to the cited page; do the same here so
// the marker is clickable instead of raw bracket text.

type HastText = { type: 'text'; value: string }
type HastElement = {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}
type HastNode = HastText | HastElement | { type: string; [key: string]: unknown }

export type CitationReference = {
  url?: string | null
  title?: string | null
  site?: string | null
  snippet?: string | null
}

const CITATION = /\[reference:(\d+)\]/g

function element(tagName: string, className: string, text: string): HastElement {
  return {
    type: 'element',
    tagName,
    properties: { className: [className] },
    children: [{ type: 'text', value: text }],
  }
}

function previewCard(target: CitationReference): HastElement {
  const url = String(target.url || '')
  let host = ''
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    /* keep the raw url below */
  }
  const shownUrl = url.replace(/^https?:\/\//, '')
  const title = String(target.title || '').trim()
  const snippet = String(target.snippet || '').trim()
  const children: HastNode[] = []
  if (target.site || host) children.push(element('span', 'md-cite-site', target.site || host))
  children.push(element('span', 'md-cite-title', title || shownUrl))
  children.push(element('span', 'md-cite-url', shownUrl))
  if (snippet) children.push(element('span', 'md-cite-snippet', snippet))
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['md-cite-card'], ariaHidden: 'true' },
    children,
  }
}

function citationNode(index: number, references: CitationReference[]): HastElement {
  const target = references[index]
  const label = String(index + 1)
  const children: HastNode[] = []
  if (target?.url) {
    children.push({
      type: 'element',
      tagName: 'a',
      properties: {
        href: target.url,
        target: '_blank',
        rel: 'noreferrer noopener',
        ariaLabel: `打开来源 ${label}：${target.title || target.url}`,
      },
      children: [{ type: 'text', value: label }],
    })
    children.push(previewCard(target))
  } else {
    children.push({ type: 'text', value: label })
  }
  return {
    type: 'element',
    tagName: 'sup',
    properties: {
      className: ['md-cite'],
      dataRef: String(index),
      dataLinked: target?.url ? 'true' : 'false',
    },
    children,
  }
}

function splitText(value: string, references: CitationReference[]): HastNode[] {
  const pieces: HastNode[] = []
  let last = 0
  CITATION.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CITATION.exec(value))) {
    if (match.index > last) pieces.push({ type: 'text', value: value.slice(last, match.index) })
    pieces.push(citationNode(Number(match[1]), references))
    last = match.index + match[0].length
  }
  if (!pieces.length) return [{ type: 'text', value }]
  if (last < value.length) pieces.push({ type: 'text', value: value.slice(last) })
  return pieces
}

function walk(node: HastElement, buried: boolean, references: CitationReference[]) {
  const children = node.children
  if (!Array.isArray(children)) return
  // Citations inside code blocks / inline code are shown as-is.
  const skip = buried || node.tagName === 'code' || node.tagName === 'pre'
  const next: HastNode[] = []
  for (const child of children) {
    if (
      !skip &&
      child.type === 'text' &&
      typeof (child as HastText).value === 'string' &&
      (child as HastText).value.includes('[reference:')
    ) {
      next.push(...splitText((child as HastText).value, references))
      continue
    }
    if (child.type === 'element') walk(child as HastElement, skip, references)
    next.push(child)
  }
  node.children = next
}

/**
 * rehype plugin: `[reference:N]` → `<sup class="md-cite"><a href="…">N+1</a></sup>`
 * when the message has a URL for that index. Without the reference list (old
 * messages imported before references were stored) the chip stays plain.
 */
export function rehypeCitations({ references = [] }: { references?: CitationReference[] } = {}) {
  return (tree: HastNode) => {
    walk(tree as HastElement, false, references)
  }
}
