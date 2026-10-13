import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { DesktopStartup } from './DesktopStartup.js'
import './styles.css'
import './workspace.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesktopStartup><App /></DesktopStartup>
  </React.StrictMode>,
)
