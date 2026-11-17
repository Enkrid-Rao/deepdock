// DeepSeek writes search citations inline as `[reference:0]`, `[reference:1]`…
// The web front-end turns them into small superscript chips. Left alone they
// show up as literal bracket text in the answer, so rewrite the text nodes into
// a `sup.md-cite` element before rendering.

type HastText = { type: 'text'; value: string }
type HastElement = {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}
type HastNode = HastText | HastElement | { type: string; [key: string]: unknown }

const CITATION = /\[reference:(\d+)\]/g

function splitText(value: string): HastNode[] {
  const pieces: HastNode[] = []
  let last = 0
  CITATION.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CITATION.exec(value))) {
    if (match.index > last) pieces.push({ type: 'text', value: value.slice(last, match.index) })
    pieces.push({
      type: 'element',
      tagName: 'sup',
      properties: {
        className: ['md-cite'],
        dataRef: match[1],
        title: `参考来源 ${match[1]}`,
      },
      children: [{ type: 'text', value: match[1] }],
    })
    last = match.index + match[0].length
  }
  if (!pieces.length) return [{ type: 'text', value }]
  if (last < value.length) pieces.push({ type: 'text', value: value.slice(last) })
  return pieces
}

function walk(node: HastElement, buried: boolean) {
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
      next.push(...splitText((child as HastText).value))
      continue
    }
    if (child.type === 'element') walk(child as HastElement, skip)
    next.push(child)
  }
  node.children = next
}

/** rehype plugin: `[reference:N]` → `<sup class="md-cite">N</sup>` */
export function rehypeCitations() {
  return (tree: HastNode) => {
    walk(tree as HastElement, false)
  }
}
