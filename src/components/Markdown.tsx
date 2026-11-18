import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import katex from 'katex'
// KaTeX ships mhchem as a plain contrib script (registers \ce support).
import 'katex/contrib/mhchem'
import { CopyButton } from './ui'
import { mathTokenIndex, prepareMath, type MathFormula } from '../lib/math'
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

function Link({ href, children, title }: { href?: string; children?: ReactNode; title?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" title={title}>
      {children}
    </a>
  )
}

/** Render one prepared formula with KaTeX; unsupported TeX degrades to a chip. */
function MathFormula({ formula }: { formula: MathFormula }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(formula.tex, {
        displayMode: formula.display,
        throwOnError: true,
        strict: false,
        trust: false,
      })
    } catch {
      return null
    }
  }, [formula])

  if (!html) {
    return (
      <code className="math-error" title={formula.tex.slice(0, 240)}>
        {formula.tex}
      </code>
    )
  }
  return (
    <span
      className={formula.display ? 'math-block' : 'math-inline'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

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
  // Math is swapped for inline-code tokens before Markdown parsing, so it
  // survives tables/lists/nested indentation; KaTeX renders those tokens.
  const prepared = useMemo(() => prepareMath(content), [content])

  const components = useMemo(
    () => ({
      pre: CodeBlock,
      a: Link,
      code: ({ className, children }: { className?: string; children?: ReactNode }) => {
        const index = mathTokenIndex(nodeText(children))
        const formula = index == null ? null : prepared.formulas[index]
        if (formula) return <MathFormula formula={formula} />
        return <code className={className}>{children}</code>
      },
    }),
    [prepared],
  )

  return (
    <div className={variant === 'user' ? 'prose prose-user' : 'prose'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeCitations, { references }],
          [rehypeHighlight, { detect: false, ignoreMissing: true }],
          [rehypeKatex, { throwOnError: false, strict: false }],
        ]}
        components={components as never}
      >
        {prepared.text}
      </ReactMarkdown>
    </div>
  )
})
