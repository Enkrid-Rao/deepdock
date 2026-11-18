// DeepSeek writes LaTeX the way its own web front-end does: `\(inline\)` for
// inline math and `\[display\]` for display math. remark-math only understands
// `$...$` / `$$...$$`, and CommonMark swallows the backslash of `\(` while
// parsing, so the delimiters are rewritten to dollars *before* the markdown is
// parsed. Fenced code blocks and inline code spans are left untouched.

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
    // Keep the newline that follows this line so nothing is glued together
    // when the segments are concatenated again.
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

function isLineStart(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i]
    if (ch === '\n') return true
    if (ch !== ' ' && ch !== '\t') return false
  }
  return true
}

function isLineEnd(text: string, index: number): boolean {
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') return true
    if (ch !== ' ' && ch !== '\t') return false
  }
  return true
}

const trim = (value: string) => value.replace(/^\s+|\s+$/g, '')

function convertPlain(text: string): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text

  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== '\\' || i + 1 >= text.length) {
      out += ch
      i += 1
      continue
    }

    const next = text[i + 1]
    if (next === '\\') {
      // Escaped backslash: keep the pair as-is so `\\(` never becomes math.
      out += '\\\\'
      i += 2
      continue
    }

    const closer = next === '(' ? '\\)' : next === '[' ? '\\]' : null
    if (!closer) {
      out += ch
      i += 1
      continue
    }

    const close = findClose(text, i + 2, closer)
    if (close >= 0) {
      const raw = text.slice(i + 2, close)
      if (next === '(') {
        const body = trim(raw)
        if (body) {
          out += `$${body}$`
          i = close + 2
          continue
        }
      } else if (isLineStart(text, i) && isLineEnd(text, close + 2)) {
        // Display math on its own line(s): keep the original line breaks and
        // indentation, so block math inside a list item stays in that item
        // instead of being moved to column 0 (which breaks the $$ fence).
        const body = trim(raw)
        if (body) {
          out += raw.includes('\n') ? `$$${raw}$$` : `$${body}$`
          i = close + 2
          continue
        }
      } else {
        // Display delimiters used mid-sentence still deserve a real formula.
        const body = trim(raw)
        if (body) {
          out += `$${body}$`
          i = close + 2
          continue
        }
      }
    }

    out += ch
    i += 1
  }

  return out
}

/**
 * Rewrite `\(...\)` / `\[...\]` into `$...$` / `$$...$$`, skipping code.
 * The input is returned unchanged when it contains no LaTeX delimiters.
 */
export function normalizeMathDelimiters(source: string): string {
  if (!source.includes('\\(') && !source.includes('\\[')) return source

  let out = ''
  for (const block of splitFenced(source)) {
    if (block.code) {
      out += block.text
      continue
    }
    for (const part of splitInlineCode(block.text)) {
      out += part.code ? part.text : convertPlain(part.text)
    }
  }
  return out
}
