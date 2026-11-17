// DeepSeek search citations.
//
// A RESPONSE fragment carries `references: [{ id, type }]`; each entry points at
// a tool fragment: `TOOL_OPEN` (an opened page with `result.url`) or
// `TOOL_SEARCH` (a search result list, where `urls` picks the cited one).
// The inline `[reference:N]` markers in the answer index into that array, so
// keeping the array order gives us the link for every marker.

const CONTENT_TYPES = new Set(['RESPONSE', 'TEXT', 'ANSWER'])

function normalizeResult(result) {
  if (!result || typeof result !== 'object') return null
  const url = typeof result.url === 'string' ? result.url : ''
  if (!url) return null
  return {
    url,
    title: typeof result.title === 'string' ? result.title : '',
    site: typeof result.site_name === 'string' ? result.site_name : '',
    snippet: typeof result.snippet === 'string' ? result.snippet : '',
  }
}

function sameUrl(a, b) {
  const clean = (value) => String(value || '').split('#')[0].replace(/\/$/, '').toLowerCase()
  return Boolean(a && b) && clean(a) === clean(b)
}

function resolveReference(reference, index) {
  const entry = index.get(`${String(reference?.type || '').toUpperCase()}:${reference?.id}`)
  if (Array.isArray(entry)) {
    const urls = Array.isArray(reference.urls) ? reference.urls : []
    const cited = entry.find((item) => urls.some((url) => sameUrl(url, item.url)))
    return cited || entry.find((item) => item.url) || null
  }
  return entry || null
}

/**
 * Extract the ordered citation list from a message's fragments.
 * @returns {{index:number,id:any,type:string,url:string|null,title:string,site:string,snippet:string}[]}
 */
export function collectReferences(fragments) {
  const list = Array.isArray(fragments) ? fragments : []
  const byId = new Map()

  for (const fragment of list) {
    if (!fragment) continue
    const type = String(fragment.type || '').toUpperCase()
    if (type === 'TOOL_OPEN') {
      const result = normalizeResult(fragment.result)
      if (result) byId.set(`TOOL_OPEN:${fragment.id}`, result)
    } else if (type === 'TOOL_SEARCH') {
      const results = (Array.isArray(fragment.results) ? fragment.results : [])
        .map(normalizeResult)
        .filter(Boolean)
      byId.set(`TOOL_SEARCH:${fragment.id}`, results)
    }
  }

  const references = []
  for (const fragment of list) {
    if (!fragment) continue
    if (!CONTENT_TYPES.has(String(fragment.type || '').toUpperCase())) continue
    for (const reference of Array.isArray(fragment.references) ? fragment.references : []) {
      const target = resolveReference(reference, byId)
      references.push({
        index: references.length,
        id: reference?.id ?? null,
        type: String(reference?.type || ''),
        url: target?.url || null,
        title: target?.title || '',
        site: target?.site || '',
        snippet: target?.snippet || '',
      })
    }
  }
  return references
}
