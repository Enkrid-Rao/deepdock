// Appearance model: theme mode, separate light/dark palettes, an accent colour,
// and a few small details (serif headings, paper grain, motion).
//
// Kept in one module so the first paint (index.html), the React app and the
// Electron window chrome all agree on the same values.

export type AppearanceMode = 'light' | 'dark' | 'system'
export type LightPalette = 'paper' | 'porcelain' | 'mist' | 'sage'
export type DarkPalette = 'noir' | 'ember' | 'slate' | 'forest'
export type AccentKey =
  | 'emerald'
  | 'ocean'
  | 'deepsea'
  | 'violet'
  | 'amber'
  | 'rose'
  | 'cyan'
export type MotionPref = 'full' | 'reduced'

export type Appearance = {
  mode: AppearanceMode
  lightPalette: LightPalette
  darkPalette: DarkPalette
  accent: AccentKey
  serif: boolean
  grain: boolean
  motion: MotionPref
  /** Custom UI font family (null = the web-matching default stack). */
  uiFont: string | null
  /** Custom code font family (null = JetBrains Mono first). */
  codeFont: string | null
}

export const APPEARANCE_KEY = 'deepdock:appearance'
const LEGACY_THEME_KEY = 'deepdock:theme'

export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'system',
  lightPalette: 'paper',
  darkPalette: 'noir',
  accent: 'emerald',
  serif: true,
  grain: true,
  motion: 'full',
  uiFont: null,
  codeFont: null,
}

/**
 * Font stacks. The UI default mirrors chat.deepseek.com: Inter first, then the
 * platform sans (with CJK fallbacks); code defaults to JetBrains Mono, which is
 * what the web front-end ships for code blocks.
 */
export const UI_FONT_FALLBACK =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
export const CODE_FONT_FALLBACK = 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace'
export const UI_FONT_DEFAULT = `Inter, ${UI_FONT_FALLBACK}`
export const CODE_FONT_DEFAULT = `"JetBrains Mono", ${CODE_FONT_FALLBACK}`

export type FontPreset = { key: string; name: string; hint: string; stack: string }

export const UI_FONT_PRESETS: FontPreset[] = [
  { key: 'web', name: '网页同款', hint: 'Inter + 系统字体', stack: UI_FONT_DEFAULT },
  {
    key: 'system',
    name: '系统默认',
    hint: '跟随操作系统的界面字体',
    stack: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif',
  },
  {
    key: 'inter',
    name: '只用 Inter',
    hint: '网页字体，中文回落系统',
    stack: 'Inter, "Segoe UI", "Microsoft YaHei UI", sans-serif',
  },
]

export const CODE_FONT_PRESETS: FontPreset[] = [
  { key: 'jetbrains', name: 'JetBrains Mono', hint: '网页端代码字体', stack: CODE_FONT_DEFAULT },
  { key: 'consolas', name: 'Consolas', hint: 'Windows 自带', stack: 'Consolas, "Courier New", monospace' },
  {
    key: 'cascadia',
    name: 'Cascadia Code',
    hint: 'Windows Terminal 字体',
    stack: '"Cascadia Code", Consolas, monospace',
  },
]

/** Keep user input from breaking out of the CSS custom property. */
export function sanitizeFontFamily(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const clean = input.replace(/[;{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)
  return clean || null
}

export type PalettePreview = {
  key: string
  name: string
  hint: string
  bg: string
  panel: string
  surface: string
  ink: string
  line: string
  accent: string
}

export const LIGHT_PALETTES: PalettePreview[] = [
  {
    key: 'paper',
    name: '暖纸',
    hint: '米白纸面，墨绿点缀',
    bg: '#f5f2ea',
    panel: '#faf8f2',
    surface: '#fffdf8',
    ink: '#14130e',
    line: '#e2dccd',
    accent: '#0e5c4d',
  },
  {
    key: 'porcelain',
    name: '瓷白',
    hint: '干净中性的亮面',
    bg: '#f4f5f7',
    panel: '#f9fafb',
    surface: '#ffffff',
    ink: '#12141a',
    line: '#e2e6ec',
    accent: '#0e5c4d',
  },
  {
    key: 'mist',
    name: '雾蓝',
    hint: '偏冷的浅灰蓝',
    bg: '#eef3f8',
    panel: '#f6f9fc',
    surface: '#fdfeff',
    ink: '#10161f',
    line: '#dbe4ee',
    accent: '#0e5c4d',
  },
  {
    key: 'sage',
    name: '淡绿',
    hint: '带一点草本的绿',
    bg: '#f1f4ee',
    panel: '#f7f9f4',
    surface: '#fcfdf9',
    ink: '#141a12',
    line: '#dde4d6',
    accent: '#0e5c4d',
  },
]

export const DARK_PALETTES: PalettePreview[] = [
  {
    key: 'noir',
    name: '现代黑',
    hint: '对齐 DeepSeek 网页端的深色',
    bg: '#151517',
    panel: '#1b1b1c',
    surface: '#232324',
    ink: '#f9fafb',
    line: '#2f3032',
    accent: '#57e0bd',
  },
  {
    key: 'ember',
    name: '暖夜',
    hint: '黑里透一点暖棕',
    bg: '#11100d',
    panel: '#1b1915',
    surface: '#23211b',
    ink: '#f0ebe0',
    line: '#35312a',
    accent: '#e0c078',
  },
  {
    key: 'slate',
    name: '石墨蓝',
    hint: '深蓝灰，冷静克制',
    bg: '#0a0e13',
    panel: '#141c25',
    surface: '#1b242e',
    ink: '#eaf1f9',
    line: '#2d3b4a',
    accent: '#6fb4f2',
  },
  {
    key: 'forest',
    name: '森林黑',
    hint: '墨绿底，夜色森林',
    bg: '#0a0f0b',
    panel: '#141c15',
    surface: '#1b251c',
    ink: '#ebf2e9',
    line: '#2c3b2f',
    accent: '#7fd6a5',
  },
]

export const ACCENTS: { key: AccentKey; name: string; light: string; dark: string }[] = [
  { key: 'emerald', name: '翡翠', light: '#0e5c4d', dark: '#57e0bd' },
  { key: 'ocean', name: '海蓝', light: '#1d5fa8', dark: '#7db8f0' },
  { key: 'deepsea', name: '深坞蓝', light: '#3964fe', dark: '#5686fe' },
  { key: 'cyan', name: '青', light: '#0b6b78', dark: '#5fd6e4' },
  { key: 'violet', name: '紫罗兰', light: '#6d3bbf', dark: '#b79cf5' },
  { key: 'amber', name: '琥珀', light: '#9a5b00', dark: '#f0bc63' },
  { key: 'rose', name: '玫瑰', light: '#a83050', dark: '#f28aa4' },
]

export function resolveTheme(appearance: Appearance): 'light' | 'dark' {
  if (appearance.mode === 'light') return 'light'
  if (appearance.mode === 'dark') return 'dark'
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function paletteBackground(appearance: Appearance, dark = resolveTheme(appearance) === 'dark'): string {
  if (dark) {
    return DARK_PALETTES.find((palette) => palette.key === appearance.darkPalette)?.bg || '#08090b'
  }
  return LIGHT_PALETTES.find((palette) => palette.key === appearance.lightPalette)?.bg || '#f5f2ea'
}

/** Foreground colour for the OS-drawn window buttons (Windows title bar overlay). */
export function paletteInk(appearance: Appearance, dark = resolveTheme(appearance) === 'dark'): string {
  if (dark) {
    return DARK_PALETTES.find((palette) => palette.key === appearance.darkPalette)?.ink || '#f9fafb'
  }
  return LIGHT_PALETTES.find((palette) => palette.key === appearance.lightPalette)?.ink || '#14130e'
}

export function normalizeAppearance(input: unknown): Appearance {
  const value = (input && typeof input === 'object' ? input : {}) as Partial<Appearance>
  const mode: AppearanceMode =
    value.mode === 'light' || value.mode === 'dark' || value.mode === 'system'
      ? value.mode
      : DEFAULT_APPEARANCE.mode
  const lightPalette = LIGHT_PALETTES.some((palette) => palette.key === value.lightPalette)
    ? (value.lightPalette as LightPalette)
    : DEFAULT_APPEARANCE.lightPalette
  const darkPalette = DARK_PALETTES.some((palette) => palette.key === value.darkPalette)
    ? (value.darkPalette as DarkPalette)
    : DEFAULT_APPEARANCE.darkPalette
  const accent = ACCENTS.some((item) => item.key === value.accent)
    ? (value.accent as AccentKey)
    : DEFAULT_APPEARANCE.accent
  return {
    mode,
    lightPalette,
    darkPalette,
    accent,
    serif: value.serif !== false,
    grain: value.grain !== false,
    motion: value.motion === 'reduced' ? 'reduced' : 'full',
    uiFont: sanitizeFontFamily(value.uiFont),
    codeFont: sanitizeFontFamily(value.codeFont),
  }
}

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return normalizeAppearance(parsed)
    }
    const legacy = localStorage.getItem(LEGACY_THEME_KEY)
    if (legacy === 'light' || legacy === 'dark') {
      return normalizeAppearance({ ...DEFAULT_APPEARANCE, mode: legacy })
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_APPEARANCE
}

export function saveAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance))
    localStorage.setItem(LEGACY_THEME_KEY, resolveTheme(appearance))
  } catch {
    /* ignore */
  }
}

type DesktopThemeBridge = {
  setAppearance?: (payload: { dark: boolean; background: string; ink?: string }) => void
}

/** Write the current appearance to the document (and the Electron window). */
export function applyAppearance(appearance: Appearance): { dark: boolean; background: string } {
  const dark = resolveTheme(appearance) === 'dark'
  const background = paletteBackground(appearance, dark)
  const ink = paletteInk(appearance, dark)
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.dataset.lightPalette = appearance.lightPalette
  root.dataset.darkPalette = appearance.darkPalette
  root.dataset.accent = appearance.accent
  root.dataset.serif = appearance.serif ? 'on' : 'off'
  root.dataset.grain = appearance.grain ? 'on' : 'off'
  root.dataset.motion = appearance.motion
  root.style.colorScheme = dark ? 'dark' : 'light'

  const uiFont = sanitizeFontFamily(appearance.uiFont)
  const codeFont = sanitizeFontFamily(appearance.codeFont)
  if (uiFont) root.style.setProperty('--font-ui', `${uiFont}, ${UI_FONT_FALLBACK}`)
  else root.style.removeProperty('--font-ui')
  if (codeFont) root.style.setProperty('--font-mono', `${codeFont}, ${CODE_FONT_FALLBACK}`)
  else root.style.removeProperty('--font-mono')

  const bridge = (window as unknown as { deepdockDesktop?: DesktopThemeBridge }).deepdockDesktop
  try {
    bridge?.setAppearance?.({ dark, background, ink })
  } catch {
    /* ignore */
  }
  return { dark, background }
}


