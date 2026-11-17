import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { CopyButton } from './ui'
import { normalizeMathDelimiters } from '../lib/math'
import { rehypeCitations, type CitationReference } from '../lib/citations'

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  const props = (node as { props?: { children?: ReactNode } }).props
  if (props?.children) return nodeText(props.children)
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children
  const props = ((child as { props?: Record<string, unknown> })?.props || {}) as {
    className?: string
    children?: ReactNode
  }
  const className = props.className || ''
  const lang = /language-([\w+-]+)/.exec(className)?.[1] || 'text'
  const raw = nodeText(children).replace(/\n$/, '')

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="lang">{lang}</span>
        <CopyButton text={raw} className="action-btn copy" title="复制代码" />
      </div>
      <pre>
        <code className={className}>{props.children}</code>
      </pre>
    </div>
  )
}

const components = {
  pre: CodeBlock,
  a: ({ href, children, title }: { href?: string; children?: ReactNode; title?: string }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" title={title}>
      {children}
    </a>
  ),
} as never

export const Markdown = memo(function Markdown({
  content,
  variant = 'assistant',
  references,
}: {
  content: string
  /** `user` keeps the chat-bubble look while still rendering Markdown / math. */
  variant?: 'assistant' | 'user'
  /** Citation links for `[reference:N]` markers in this message. */
  references?: CitationReference[]
}) {
  // DeepSeek writes LaTeX as `\(...\)` / `\[...\]`; remark-math only knows `$`.
  const source = useMemo(() => normalizeMathDelimiters(content), [content])

  return (
    <div className={variant === 'user' ? 'prose prose-user' : 'prose'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeCitations, { references }],
          [rehypeHighlight, { detect: false, ignoreMissing: true }],
          [rehypeKatex, { throwOnError: false, strict: false }],
        ]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
})
