
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 1100, show: false, webPreferences: { offscreen: true } });
  await win.loadFile("/Users/nickcarfagno/dev/colima-gui/assets/_icon_render.html");
  // Wait for rendering
  await new Promise(r => setTimeout(r, 2000));
  const title = win.getTitle();
  fs.writeFileSync("/Users/nickcarfagno/dev/colima-gui/assets/_icon_data.json", title);
  app.quit();
});
