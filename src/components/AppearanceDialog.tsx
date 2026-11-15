import { Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import { Dialog } from './ui'
import {
  ACCENTS,
  DARK_PALETTES,
  DEFAULT_APPEARANCE,
  LIGHT_PALETTES,
  resolveTheme,
  type Appearance,
  type AppearanceMode,
  type PalettePreview,
} from '../lib/appearance'

const MODES: { key: AppearanceMode; label: string; icon: typeof Sun }[] = [
  { key: 'light', label: '浅色', icon: Sun },
  { key: 'dark', label: '深色', icon: Moon },
  { key: 'system', label: '跟随系统', icon: Monitor },
]

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
      <span
        className="palette-preview"
        style={{ background: palette.bg, borderColor: palette.line }}
      >
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

export function AppearanceDialog({
  open,
  appearance,
  onChange,
  onClose,
}: {
  open: boolean
  appearance: Appearance
  onChange: (next: Appearance) => void
  onClose: () => void
}) {
  const dark = resolveTheme(appearance) === 'dark'
  const update = (patch: Partial<Appearance>) => onChange({ ...appearance, ...patch })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={780}
      className="dialog-appearance"
      title="外观"
      description="主题、配色与细节都会立刻生效，并记住在这台电脑上。"
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange({ ...DEFAULT_APPEARANCE })}
          >
            <RotateCcw size={13} /> 恢复默认
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary" style={{ width: 'auto' }} onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      <div className="appearance-body">
        <div className="appearance-cols">
          <div className="appearance-col">
            <section className="appearance-section">
              <div className="appearance-head">
                <span>外观模式</span>
                <em>现在显示的是{dark ? '深色' : '浅色'}</em>
              </div>
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
            </section>

            <section className="appearance-section">
              <div className="appearance-head">
                <span>细节</span>
              </div>
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
            </section>
          </div>

          <div className="appearance-col">
            <section className="appearance-section">
              <div className="appearance-head">
                <span>浅色风格</span>
                <em>切换浅色时使用的底色</em>
              </div>
              <div className="palette-grid">
                {LIGHT_PALETTES.map((palette) => (
                  <PaletteCard
                    key={palette.key}
                    palette={palette}
                    active={appearance.lightPalette === palette.key}
                    onSelect={() => update({ lightPalette: palette.key as Appearance['lightPalette'] })}
                  />
                ))}
              </div>
            </section>

            <section className="appearance-section">
              <div className="appearance-head">
                <span>深色风格</span>
                <em>现代黑会保留更明显的前后层次</em>
              </div>
              <div className="palette-grid">
                {DARK_PALETTES.map((palette) => (
                  <PaletteCard
                    key={palette.key}
                    palette={palette}
                    active={appearance.darkPalette === palette.key}
                    onSelect={() => update({ darkPalette: palette.key as Appearance['darkPalette'] })}
                  />
                ))}
              </div>
            </section>

            <section className="appearance-section">
              <div className="appearance-head">
                <span>强调色</span>
                <em>链接、按钮与高亮</em>
              </div>
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
            </section>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
