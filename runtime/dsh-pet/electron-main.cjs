// Reuse the upstream Electron application while isolating its Chromium profile
// from a separately installed DSH pet or standalone application.
const { app } = require('electron')
const { dirname, join } = require('node:path')
const root = dirname(require.resolve('dsh-pet/package.json'))
app.setPath('userData', join(process.env.DSH_HOME, 'dsh-pet', 'electron-profile'))
require(join(root, 'runtime', 'electron-helper', 'main.js'))
