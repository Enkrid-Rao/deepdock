import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Download,
  FolderInput,
  Info,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  RotateCcw,
  Sun,
  Type,
} from 'lucide-react'
import type { UpdateState } from '../lib/types'
import {
  ACCENTS,
  CODE_FONT_DEFAULT,
  CODE_FONT_PRESETS,
  DARK_PALETTES,
  DEFAULT_APPEARANCE,
  LIGHT_PALETTES,
  UI_FONT_DEFAULT,
  UI_FONT_PRESETS,
  resolveTheme,
  sanitizeFontFamily,
  type Appearance,
  type AppearanceMode,
  type FontPreset,
  type PalettePreview,
} from '../lib/appearance'

type Section = 'appearance' | 'fonts' | 'app'

type DesktopInfo = {
  version?: string
  electron?: string
  dataDir?: string
  portable?: boolean
}

type DesktopBridge = {
  info?: () => Promise<DesktopInfo>
  openExternal?: (url: string) => Promise<void>
}

const RELEASES_URL = 'https://github.com/Enkrid-Rao/deepdock/releases/latest'

function currentBridge(): DesktopBridge | undefined {
  return (window as unknown as { deepdockDesktop?: DesktopBridge }).deepdockDesktop
}

const MODES: { key: AppearanceMode; label: string; icon: typeof Sun }[] = [
  { key: 'light', label: '浅色', icon: Sun },
  { key: 'dark', label: '深色', icon: Moon },
  { key: 'system', label: '跟随系统', icon: Monitor },
]

const SECTIONS: { key: Section; label: string; hint: string; icon: typeof Palette }[] = [
  { key: 'appearance', label: '外观', hint: '主题、配色与细节', icon: Palette },
  { key: 'fonts', label: '字体', hint: '界面与代码字体', icon: Type },
  { key: 'app', label: '应用', hint: '版本、更新与数据', icon: Info },
]

function updateText(update: UpdateState | null): string {
  if (!update || update.status === 'idle') return '启动时会自动检查更新'
  switch (update.status) {
    case 'checking':
      return '正在检查更新…'
    case 'current':
      return `已经是最新版本（v${update.current || update.version}）`
    case 'available':
      return `发现新版本 v${update.version}（当前 v${update.current}）`
    case 'downloading':
      return `正在下载 v${update.version}… ${update.percent}%`
    case 'downloaded':
      return `新版本 v${update.version} 已下载，重启即可安装`
    case 'error':
      return `检查更新失败：${update.message}`
    case 'dev':
      return '开发模式下不检查更新'
    case 'portable':
      return '当前为绿色版（免安装）'
    default:
      return '启动时会自动检查更新'
  }
}

function PaletteCard({
  palette,
  active,
  onSelect,
}: {
  palette: PalettePreview
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className="palette-card"
      data-active={active}
      onClick={onSelect}
      title={`${palette.name} — ${palette.hint}`}
    >
      <span className="palette-preview" style={{ background: palette.bg, borderColor: palette.line }}>
        <span className="pp-side" style={{ background: palette.panel, borderColor: palette.line }}>
          <i style={{ background: palette.accent }} />
          <i style={{ background: palette.line }} />
          <i style={{ background: palette.line }} />
        </span>
        <span className="pp-main">
          <i className="pp-card" style={{ background: palette.surface, borderColor: palette.line }} />
          <i className="pp-line" style={{ background: palette.ink }} />
          <i className="pp-line short" style={{ background: palette.line }} />
        </span>
      </span>
      <span className="palette-name">
        {palette.name}
        <em>{palette.hint}</em>
      </span>
    </button>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint: string
}) {
  return (
    <button type="button" className="toggle-row" data-on={checked} onClick={() => onChange(!checked)}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        <span className="toggle-hint">{hint}</span>
      </span>
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
    </button>
  )
}

function Card({
  title,
  hint,
  children,
  extra,
}: {
  title: string
  hint?: string
  children: React.ReactNode
  extra?: React.ReactNode
}) {
  return (
    <section className="settings-card">
      <header className="settings-card-head">
        <div>
          <h3>{title}</h3>
          {hint ? <p>{hint}</p> : null}
        </div>
        {extra}
      </header>
      {children}
    </section>
  )
}

function FontOption({
  preset,
  active,
  sample,
  onSelect,
}: {
  preset: FontPreset
  active: boolean
  sample: string
  onSelect: () => void
}) {
  return (
    <button type="button" className="font-option" data-active={active} onClick={onSelect}>
      <span className="font-option-sample" style={{ fontFamily: preset.stack }}>
        {sample}
      </span>
      <span className="font-option-text">
        <strong>{preset.name}</strong>
        <em>{preset.hint}</em>
      </span>
      {active ? <Check size={14} className="font-option-check" /> : null}
    </button>
  )
}

function FontGroup({
  kind,
  appearance,
  onChange,
}: {
  kind: 'ui' | 'code'
  appearance: Appearance
  onChange: (next: Appearance) => void
}) {
  const presets = kind === 'ui' ? UI_FONT_PRESETS : CODE_FONT_PRESETS
  const fallback = kind === 'ui' ? UI_FONT_DEFAULT : CODE_FONT_DEFAULT
  const value = kind === 'ui' ? appearance.uiFont : appearance.codeFont
  const current = value || presets[0].stack
  const presetActive = (preset: FontPreset) =>
    preset.stack === current || (!value && preset.key === presets[0].key)
  // The text field is only for genuinely custom families; a selected preset
  // should not look like something the user typed.
  const customValue = value && !presets.some((preset) => preset.stack === value) ? value : ''

  const apply = (font: string | null) => {
    onChange(kind === 'ui' ? { ...appearance, uiFont: font } : { ...appearance, codeFont: font })
  }

  return (
    <div className="font-group">
      <div className="font-options">
        {presets.map((preset) => (
          <FontOption
            key={preset.key}
            preset={preset}
            active={presetActive(preset)}
            sample={kind === 'ui' ? 'Aa 深坞' : 'Aa → 42'}
            onSelect={() => apply(preset.key === presets[0].key ? null : preset.stack)}
          />
        ))}
      </div>
      <div className="font-custom" data-active={Boolean(customValue)}>
        <Type size={14} />
        <input
          value={customValue}
          placeholder={
            kind === 'ui'
              ? '自定义：系统里已安装的字体名，如 "霞鹜文楷"'
              : '自定义：系统里已安装的等宽字体，如 "Fira Code"'
          }
          spellCheck={false}
          onChange={(event) => apply(sanitizeFontFamily(event.target.value))}
        />
        {customValue || value ? (
          <button type="button" className="icon-btn" title="恢复默认" onClick={() => apply(null)}>
            <RotateCcw size={13} />
          </button>
        ) : null}
      </div>
      <p className="font-fallback">
        没用到的字体会回退到默认：<code>{fallback.split(',')[0]}</code>…
      </p>
    </div>
  )
}

export function SettingsPage({
  open,
  appearance,
  onChange,
  onClose,
  onCheckUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onOpenDataFolder,
  updateState = null,
}: {
  open: boolean
  appearance: Appearance
  onChange: (next: Appearance) => void
  onClose: () => void
  onCheckUpdates: () => void
  onDownloadUpdate: () => void
  onInstallUpdate: () => void
  onOpenDataFolder: () => void
  updateState?: UpdateState | null
}) {
  const [section, setSection] = useState<Section>('appearance')
  const [info, setInfo] = useState<DesktopInfo | null>(null)

  useEffect(() => {
    if (open) setSection('appearance')
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return undefined
    const bridge = (window as unknown as { deepdockDesktop?: DesktopBridge }).deepdockDesktop
    if (!bridge?.info) return undefined
    let alive = true
    bridge
      .info()
      .then((value) => alive && setInfo(value))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open])

  if (!open) return null

  const dark = resolveTheme(appearance) === 'dark'
  const update = (patch: Partial<Appearance>) => onChange({ ...appearance, ...patch })
  const activeSection = SECTIONS.find((item) => item.key === section) || SECTIONS[0]

  return (
    <div className="settings-page" role="dialog" aria-modal="true" aria-label="设置">
      <div className="settings-shell">
        <aside className="settings-rail">
          <div className="settings-rail-head">
            <button type="button" className="settings-back" title="返回对话（Esc）" onClick={onClose}>
              <ArrowLeft size={15} />
            </button>
            <span className="settings-rail-title">设置</span>
            <span className="settings-rail-version">{info?.version ? `v${info.version}` : 'DeepDock'}</span>
          </div>
          <nav className="settings-nav">
            {SECTIONS.map(({ key, label, hint, icon: Icon }) => (
              <button
                key={key}
                type="button"
                data-active={section === key}
                onClick={() => setSection(key)}
              >
                <Icon size={15} />
                <span className="settings-nav-text">
                  <span>{label}</span>
                  <em>{hint}</em>
                </span>
              </button>
            ))}
          </nav>
          <div className="settings-rail-foot">
            <span className="settings-rail-hint">Ctrl + , 打开设置 · Esc 返回</span>
          </div>
        </aside>

        <section className="settings-main">
          <header className="settings-head">
            <div>
              <h1>{activeSection.label}</h1>
              <p>{activeSection.hint}。所有改动立刻生效，并保存在这台电脑上。</p>
            </div>
          </header>

          <div className="settings-body">
            {section === 'appearance' ? (
              <>
                <div className="settings-grid">
                  <Card
                    title="外观模式"
                    hint="决定整个窗口的明暗，跟随系统会随 Windows 设置切换。"
                  >
                    <div className="segmented">
                      {MODES.map(({ key, label, icon: Icon }) => (
                        <button
                          key={key}
                          type="button"
                          data-active={appearance.mode === key}
                          onClick={() => update({ mode: key })}
                        >
                          <Icon size={14} /> {label}
                        </button>
                      ))}
                    </div>
                    <p className="settings-note">
                      现在显示的是{dark ? '深色' : '浅色'}
                      {appearance.mode === 'system' ? '（跟随系统）' : ''}。
                    </p>
                  </Card>

                  <Card title="强调色" hint="链接、选中的按钮和高亮都跟着它走。">
                    <div className="accent-row">
                      {ACCENTS.map((accent) => (
                        <button
                          key={accent.key}
                          type="button"
                          className="accent-swatch"
                          data-active={appearance.accent === accent.key}
                          title={accent.name}
                          onClick={() => update({ accent: accent.key })}
                        >
                          <span
                            className="accent-dot"
                            style={{ background: dark ? accent.dark : accent.light }}
                          />
                          {accent.name}
                        </button>
                      ))}
                    </div>
                  </Card>
                </div>

                <Card title="浅色风格" hint="只在浅色模式下生效。">
                  <div className="palette-grid">
                    {LIGHT_PALETTES.map((palette) => (
                      <PaletteCard
                        key={palette.key}
                        palette={palette}
                        active={appearance.lightPalette === palette.key}
                        onSelect={() =>
                          update({ lightPalette: palette.key as Appearance['lightPalette'] })
                        }
                      />
                    ))}
                  </div>
                </Card>

                <Card
                  title="深色风格"
                  hint="「现代黑」对齐 DeepSeek 网页端的深色配色（#151517 底 + 分层灰面）。"
                >
                  <div className="palette-grid">
                    {DARK_PALETTES.map((palette) => (
                      <PaletteCard
                        key={palette.key}
                        palette={palette}
                        active={appearance.darkPalette === palette.key}
                        onSelect={() =>
                          update({ darkPalette: palette.key as Appearance['darkPalette'] })
                        }
                      />
                    ))}
                  </div>
                </Card>

                <Card title="细节" hint="几个不影响功能的小开关。">
                  <div className="toggle-list">
                    <Toggle
                      label="衬线标题"
                      hint="品牌名与空状态大标题使用衬线体"
                      checked={appearance.serif}
                      onChange={(value) => update({ serif: value })}
                    />
                    <Toggle
                      label="纸张颗粒"
                      hint="给底色加一层很淡的噪点质感"
                      checked={appearance.grain}
                      onChange={(value) => update({ grain: value })}
                    />
                    <Toggle
                      label="减少动效"
                      hint="关闭过渡与入场动画，更安静"
                      checked={appearance.motion === 'reduced'}
                      onChange={(value) => update({ motion: value ? 'reduced' : 'full' })}
                    />
                  </div>
                </Card>
              </>
            ) : null}

            {section === 'fonts' ? (
              <>
                <Card
                  title="界面字体"
                  hint="默认与 DeepSeek 网页端一致：Inter 打头，中文回落到系统字体。"
                  extra={
                    appearance.uiFont ? (
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => update({ uiFont: null })}
                      >
                        <RotateCcw size={13} /> 恢复默认
                      </button>
                    ) : null
                  }
                >
                  <FontGroup kind="ui" appearance={appearance} onChange={onChange} />
                </Card>

                <Card
                  title="代码字体"
                  hint="代码块、行内代码与命令使用等宽字体，默认 JetBrains Mono。"
                  extra={
                    appearance.codeFont ? (
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => update({ codeFont: null })}
                      >
                        <RotateCcw size={13} /> 恢复默认
                      </button>
                    ) : null
                  }
                >
                  <FontGroup kind="code" appearance={appearance} onChange={onChange} />
                </Card>

                <Card title="预览" hint="下面这段文字和代码会立刻用上你选的字体。">
                  <div className="font-preview">
                    <p className="font-preview-title">深坞 DeepDock · 字体预览</p>
                    <p>
                      中文与 English 混排：把散落在 DeepSeek 里的对话收进项目，
                      下一次要找的时候，它就在原处。
                    </p>
                    <pre>
                      <code>{`const dock = (name) => \`hello, \${name}\`
// 0 → 1 的边界，逐个字符地对齐`}</code>
                    </pre>
                    <p className="font-preview-meta">
                      界面：<code>{appearance.uiFont || '网页同款'}</code> · 代码：
                      <code>{appearance.codeFont || 'JetBrains Mono'}</code>
                    </p>
                  </div>
                </Card>
              </>
            ) : null}

            {section === 'app' ? (
              <>
                <div className="settings-grid">
                  <Card title="版本" hint={info?.portable ? '当前绿色版（免安装）的信息。' : '当前安装的桌面版信息。'}>
                    <dl className="settings-facts">
                      <div>
                        <dt>DeepDock</dt>
                        <dd>{info?.version ? `v${info.version}` : '—'}</dd>
                      </div>
                      <div>
                        <dt>Electron</dt>
                        <dd>{info?.electron || '—'}</dd>
                      </div>
                      <div>
                        <dt>数据目录</dt>
                        <dd title={info?.dataDir}>{info?.dataDir || '—'}</dd>
                      </div>
                    </dl>
                    <p className="settings-note">
                      {info?.portable
                        ? '卸载：退出 DeepDock，直接删掉整个文件夹即可（数据在 DeepDock-data 里，会一起删除）。不写注册表，不在系统目录留东西。'
                        : '卸载：Windows 设置 → 应用 → 已安装的应用 → DeepDock，或开始菜单里的「卸载 DeepDock」。卸载时会询问是否一并删除本机数据，默认保留。'}
                    </p>
                  </Card>

                  <Card
                    title="更新"
                    hint={
                      info?.portable
                        ? '绿色版不自动更新：到 Releases 下载新的压缩包，解压时保留 DeepDock-data 即可。'
                        : '启动后自动检查 GitHub Releases；是否下载、是否安装都由你决定。'
                    }
                  >
                    <div className="settings-update" data-status={updateState?.status || 'idle'}>
                      <span className="settings-update-text">{updateText(updateState)}</span>
                      {updateState?.status === 'downloading' ? (
                        <div className="settings-progress">
                          <i style={{ width: `${Math.max(0, Math.min(100, updateState.percent))}%` }} />
                        </div>
                      ) : null}
                    </div>
                    <div className="settings-actions">
                      {updateState?.status === 'available' ? (
                        <button type="button" className="btn btn-primary" onClick={onDownloadUpdate}>
                          <Download size={14} /> 下载并安装 v{updateState.version}
                        </button>
                      ) : null}
                      {updateState?.status === 'downloaded' ? (
                        <button type="button" className="btn btn-primary" onClick={onInstallUpdate}>
                          <RefreshCw size={14} /> 重启并安装
                        </button>
                      ) : null}
                      {info?.portable ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => void currentBridge()?.openExternal?.(RELEASES_URL)}
                        >
                          <Download size={14} /> 打开发布页
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={onCheckUpdates}
                          disabled={updateState?.status === 'checking' || updateState?.status === 'downloading'}
                        >
                          <RefreshCw size={14} /> 检查更新
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost" onClick={onOpenDataFolder}>
                        <FolderInput size={14} /> 打开数据目录
                      </button>
                    </div>
                    <p className="settings-note">
                      {info?.portable
                        ? '数据就在程序目录的 DeepDock-data 里，升级或搬走时连同它一起带走；删掉整个文件夹就是卸载。'
                        : '自动更新走 GitHub，国内网络需要能访问 GitHub（可开启系统代理）。'}
                    </p>
                  </Card>
                </div>

                <Card title="恢复默认" hint="只重置外观与字体，不影响对话、项目或账号。">
                  <div className="settings-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => onChange({ ...DEFAULT_APPEARANCE })}
                    >
                      <RotateCcw size={13} /> 恢复默认外观与字体
                    </button>
                  </div>
                </Card>
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
