import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { WindowControls } from './components/WindowControls'
import { applyAppearance, loadAppearance } from './lib/appearance'
import './styles.css'
import 'katex/dist/katex.min.css'

// index.html sets the attributes early; this also syncs the Electron window
// chrome before the first React paint.
applyAppearance(loadAppearance())

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
    <WindowControls />
  </StrictMode>,
)
