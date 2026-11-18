// DeepSeek writes LaTeX the way its own web front-end does: `\(inline\)` for
// inline math and `\[display\]` for display math. remark-math only understands
// `$...$` / `$$...$$`, and block-level math is fragile inside lists/tables
// (indentation decides whether it is math or a code block).
//
// So instead of rewriting delimiters, every math expression is replaced with a
// private inline-code token before Markdown parsing; the renderer turns those
// tokens into KaTeX output. Inline code survives tables, lists, blockquotes and
// emphasis unchanged, so the math can never be swallowed by a list/code block.
// Fenced code blocks and inline code spans are left untouched.

export type MathFormula = { tex: string; display: boolean }
export type PreparedMath = { text: string; formulas: MathFormula[] }

const TOKEN = /^@@DDMATH(\d+)@@$/

/** Index of the math formula behind an inline-code token, or null. */
export function mathTokenIndex(value: string): number | null {
  const match = TOKEN.exec(value.trim())
  return match ? Number(match[1]) : null
}

type Segment = { code: boolean; text: string }

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** Split a document into fenced-code and normal segments (line fences only). */
function splitFenced(source: string): Segment[] {
  const lines = source.split('\n')
  const segments: Segment[] = []
  let fence: { char: string; length: number } | null = null
  let buffer = ''
  let code = false

  const flush = () => {
    if (!buffer) return
    segments.push({ code, text: buffer })
    buffer = ''
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const chunk = i < lines.length - 1 ? `${line}\n` : line

    if (fence) {
      buffer += chunk
      const closing = FENCE_CLOSE.exec(line)
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) {
        flush()
        fence = null
        code = false
      }
      continue
    }

    const opening = FENCE_OPEN.exec(line)
    if (opening) {
      flush()
      code = true
      fence = { char: opening[1][0], length: opening[1].length }
      buffer = chunk
      continue
    }

    buffer += chunk
  }

  flush()
  return segments
}

/** Index of the closing backtick run with exactly `run` backticks, or -1. */
function findClosingRun(text: string, from: number, run: number): number {
  let i = from
  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1
      continue
    }
    let length = 1
    while (text[i + length] === '`') length += 1
    if (length === run) return i
    i += length
  }
  return -1
}

/** Split a normal segment into inline-code and plain-text pieces. */
function splitInlineCode(text: string): Segment[] {
  const segments: Segment[] = []
  let plainStart = 0
  let i = 0

  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1
      continue
    }
    let run = 1
    while (text[i + run] === '`') run += 1
    const close = findClosingRun(text, i + run, run)
    if (close < 0) {
      i += run
      continue
    }
    if (i > plainStart) segments.push({ code: false, text: text.slice(plainStart, i) })
    segments.push({ code: true, text: text.slice(i, close + run) })
    i = close + run
    plainStart = i
  }

  if (plainStart < text.length) segments.push({ code: false, text: text.slice(plainStart) })
  return segments
}

/** Find `marker` (e.g. `\)`) that is not itself escaped by a backslash. */
function findClose(text: string, from: number, marker: string): number {
  let i = text.indexOf(marker, from)
  while (i !== -1) {
    let slashes = 0
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j -= 1) slashes += 1
    if (slashes % 2 === 0) return i
    i = text.indexOf(marker, i + 1)
  }
  return -1
}

function convertPlain(text: string, formulas: MathFormula[]): string {
  if (!text.includes('\\(') && !text.includes('\\[') && !text.includes('$$')) return text

  let out = ''
  let i = 0
  const token = (formula: MathFormula) => {
    const index = formulas.length
    formulas.push(formula)
    return `\`@@DDMATH${index}@@\``
  }

  while (i < text.length) {
    const ch = text[i]

    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]
      if (next === '\\') {
        out += '\\\\'
        i += 2
        continue
      }
      if (next === '(' || next === '[') {
        const close = findClose(text, i + 2, next === '(' ? '\\)' : '\\]')
        if (close >= 0) {
          const body = text.slice(i + 2, close).trim()
          if (body) {
            out += token({ tex: body, display: next === '[' })
            i = close + 2
            continue
          }
        }
      }
      out += ch
      i += 1
      continue
    }

    if (ch === '$' && text[i + 1] === '$') {
      const close = text.indexOf('$$', i + 2)
      if (close >= 0) {
        const body = text.slice(i + 2, close).trim()
        if (body) {
          out += token({ tex: body, display: true })
          i = close + 2
          continue
        }
      }
      out += '$$'
      i += 2
      continue
    }

    out += ch
    i += 1
  }

  return out
}

/**
 * Replace `\(...\)`, `\[...\]` and `$$...$$` with inline-code tokens and keep
 * the TeX in `formulas`. Code fences / inline code are not touched.
 */
export function prepareMath(source: string): PreparedMath {
  if (!source.includes('\\(') && !source.includes('\\[') && !source.includes('$$')) {
    return { text: source, formulas: [] }
  }

  const formulas: MathFormula[] = []
  let out = ''
  for (const block of splitFenced(source)) {
    if (block.code) {
      out += block.text
      continue
    }
    for (const part of splitInlineCode(block.text)) {
      out += part.code ? part.text : convertPlain(part.text, formulas)
    }
  }
  return { text: out, formulas }
}
