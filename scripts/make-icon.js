#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const ICONSET = path.join(ROOT, 'assets', 'icon.iconset');
const ICNS = path.join(ROOT, 'assets', 'icon.icns');
const PNG = path.join(ROOT, 'assets', 'icon.png');
const TMP_DIR = path.join(ROOT, 'assets', '_tmp');

const svgData = fs.readFileSync(SVG, 'utf8');
const sizes = [16, 32, 64, 128, 256, 512, 1024];

if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR);

const html = `<html><body style="margin:0;padding:0;background:transparent">
<img id="img" style="width:1024px;height:1024px" src="data:image/svg+xml;base64,${Buffer.from(svgData).toString('base64')}" />
<canvas id="c"></canvas>
<script>
const { ipcRenderer } = require('electron');
const img = document.getElementById('img');
const canvas = document.getElementById('c');
img.onload = () => {
  const sizes = ${JSON.stringify(sizes)};
  const results = {};
  for (const s of sizes) {
    canvas.width = s;
    canvas.height = s;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(img, 0, 0, s, s);
    results[s] = canvas.toDataURL('image/png').split(',')[1];
  }
  ipcRenderer.send('icons-ready', results);
};
</script></body></html>`;

const htmlPath = path.join(TMP_DIR, 'render.html');
fs.writeFileSync(htmlPath, html);

const electronScript = `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100, height: 1100, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  ipcMain.on('icons-ready', (_e, data) => {
    fs.writeFileSync(${JSON.stringify(path.join(TMP_DIR, 'data.json'))}, JSON.stringify(data));
    app.quit();
  });

  await win.loadFile(${JSON.stringify(htmlPath)});

  // Fallback timeout
  setTimeout(() => { console.error('Timeout'); app.exit(1); }, 10000);
});
`;

const scriptPath = path.join(TMP_DIR, 'electron-render.js');
fs.writeFileSync(scriptPath, electronScript);

console.log('Rendering SVG via Electron...');
execSync(`npx electron ${scriptPath}`, { cwd: ROOT, stdio: 'inherit', timeout: 15000 });

const data = JSON.parse(fs.readFileSync(path.join(TMP_DIR, 'data.json'), 'utf8'));

// Write 1024px PNG
fs.writeFileSync(PNG, Buffer.from(data['1024'], 'base64'));
console.log(`Wrote ${PNG}`);

// Build .iconset
if (fs.existsSync(ICONSET)) fs.rmSync(ICONSET, { recursive: true });
fs.mkdirSync(ICONSET);

const iconsetSizes = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

for (const [size, name] of iconsetSizes) {
  fs.writeFileSync(path.join(ICONSET, name), Buffer.from(data[String(size)], 'base64'));
}

console.log('Converting to .icns...');
execSync(`iconutil -c icns "${ICONSET}" -o "${ICNS}"`);
console.log(`Wrote ${ICNS}`);

// Cleanup
fs.rmSync(TMP_DIR, { recursive: true });
fs.rmSync(ICONSET, { recursive: true });

console.log('Done!');
