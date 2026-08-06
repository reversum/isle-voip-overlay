import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import builder from 'electron-builder'
import pngToIco from 'png-to-ico'
import Jimp from 'jimp'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`[build-whitelabel] ${message}`)
  process.exit(1)
}

const serverHash = String(process.env.WL_SERVER_HASH ?? '').trim().toLowerCase()
if (!/^[0-9a-f]{40}$/.test(serverHash)) {
  fail('WL_SERVER_HASH must be a 40-character hex string.')
}

const rawName = String(process.env.WL_APP_NAME ?? '').trim()
const appName = rawName.replace(/[^\w .\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)
if (!appName) {
  fail('WL_APP_NAME is empty after sanitizing (allowed: letters, numbers, space . _ -).')
}

const serverLabel = String(process.env.WL_LABEL ?? appName).replace(/[^\w .\-]/g, '').trim().slice(0, 60)
const tier = ['premium', 'ultra'].includes(String(process.env.WL_TIER)) ? String(process.env.WL_TIER) : 'premium'

let iconSourcePng
let iconIcoDirect
if (process.env.WL_ICON_PNG) {
  const candidate = path.resolve(String(process.env.WL_ICON_PNG))
  if (!fs.existsSync(candidate)) fail('WL_ICON_PNG file not found.')
  iconSourcePng = candidate
} else if (process.env.WL_ICON) {
  const candidate = path.resolve(String(process.env.WL_ICON))
  if (!fs.existsSync(candidate) || !candidate.toLowerCase().endsWith('.ico')) {
    fail('WL_ICON must point to an existing .ico file.')
  }
  iconIcoDirect = candidate
}

const outputDir = path.resolve(String(process.env.WL_OUT ?? path.join(projectRoot, 'release-wl')))
const artifactName = String(process.env.WL_ARTIFACT ?? 'IsleVOIP-Setup.exe').replace(/[^\w.\-]/g, '') || 'IsleVOIP-Setup.exe'

if (!fs.existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
  fail('dist/index.html missing. Run "npm run build" first.')
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'))
const whitelabelPath = path.join(tmpDir, 'whitelabel.json')
fs.writeFileSync(
  whitelabelPath,
  JSON.stringify({ serverHash, serverLabel, tier, appName }, null, 2),
)

let iconPath = iconIcoDirect
if (iconSourcePng) {
  try {
    const image = await Jimp.read(iconSourcePng)
    image.cover(256, 256)
    const pngBuf = await image.getBufferAsync(Jimp.MIME_PNG)
    const icoBuf = await pngToIco(pngBuf)
    iconPath = path.join(tmpDir, 'icon.ico')
    fs.writeFileSync(iconPath, icoBuf)
  } catch (err) {
    fail(`icon conversion failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

if (!iconPath) {
  const defaultIco = path.join(projectRoot, 'build', 'icon.ico')
  if (fs.existsSync(defaultIco)) iconPath = defaultIco
}

const buildId = crypto.randomUUID().slice(0, 8)
console.log(`[build-whitelabel] ${buildId} name="${appName}" hash=${serverHash.slice(0, 8)}… out=${outputDir}`)

const feedUrl = process.env.WL_FEED_URL ? String(process.env.WL_FEED_URL) : undefined

const ebConfig = {
  appId: 'com.isle-voip.overlay',
  productName: appName,
  protocols: [{ name: 'IsleVOIP', schemes: ['isle-voip'] }],
  directories: { output: outputDir },
  files: ['dist/**', 'electron/**', 'package.json'],
  asarUnpack: ['**/node_modules/uiohook-napi/**', '**/node_modules/get-windows/**'],
  extraResources: [{ from: whitelabelPath, to: 'whitelabel.json' }],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], publisherName: 'IsleVOIP', ...(iconPath ? { icon: iconPath } : {}) },
  nsis: { oneClick: true, perMachine: false, artifactName },
  copyright: 'IsleVOIP',
  ...(feedUrl ? { publish: [{ provider: 'generic', url: feedUrl }] } : {}),
}
const ebConfigPath = path.join(tmpDir, 'electron-builder.json')
fs.writeFileSync(ebConfigPath, JSON.stringify(ebConfig))

try {
  const result = await builder.build({
    targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
    projectDir: projectRoot,
    publish: 'never',
    config: ebConfigPath,
  })
  const exe = result.find((f) => f.toLowerCase().endsWith('.exe'))
  console.log(`[build-whitelabel] DONE ${exe ?? result.join(', ')}`)
  process.stdout.write(`WL_RESULT=${exe ?? ''}\n`)
} catch (err) {
  fail(`electron-builder failed: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
  }
}
