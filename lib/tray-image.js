'use strict';

// Draws the menu bar contents into a template image so the rise / fall marks
// can be real icons rather than text glyphs. A hidden offscreen window does
// the drawing; if anything about it fails the caller falls back to plain text,
// so the menu bar is never left empty.

const { BrowserWindow, nativeImage } = require('electron');
const { BAR_HEIGHT, buildBarHtml } = require('./tray-canvas');

const SCALE = 2; // retina; the image is tagged so macOS halves it again
const PAINT_TIMEOUT_MS = 4000;
const MAX_WIDTH = 1200;

class TrayImageRenderer {
  constructor() {
    this.window = null;
  }

  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.window = new BrowserWindow({
      width: MAX_WIDTH,
      height: BAR_HEIGHT * SCALE,
      show: false,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      webPreferences: { offscreen: true },
    });
    return this.window;
  }

  // Resolves with a NativeImage, or null if drawing did not work out.
  async render(items, style) {
    if (!items.length) return null;
    try {
      const win = this.ensureWindow();
      const html = buildBarHtml(items, style, SCALE);
      await win.loadURL(
        'data:text/html;charset=utf-8,' + encodeURIComponent(html)
      );

      const width = Math.min(
        MAX_WIDTH,
        await win.webContents.executeJavaScript(
          'Math.ceil(document.getElementById("bar").getBoundingClientRect().width)'
        )
      );
      if (!Number.isFinite(width) || width <= 0) return null;

      const height = BAR_HEIGHT * SCALE;
      const painted = this.nextPaint(win, width, height);
      win.setContentSize(width, height);
      win.webContents.invalidate();

      const raw = await painted;
      // Round-tripping through PNG is what lets the scale factor be set, which
      // is what stops the image rendering at double size on a retina screen.
      const image = nativeImage.createFromBuffer(raw.toPNG(), {
        scaleFactor: SCALE,
      });
      if (image.isEmpty()) return null;
      image.setTemplateImage(true); // macOS recolours it for light and dark
      return image;
    } catch {
      return null;
    }
  }

  // Offscreen windows paint more than once — including at the old size right
  // after a resize — so wait for one that is actually the size we asked for.
  nextPaint(win, width, height) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        win.webContents.off('paint', onPaint);
        reject(new Error('offscreen render timed out'));
      }, PAINT_TIMEOUT_MS);

      const onPaint = (_event, _dirty, image) => {
        const size = image.getSize();
        if (size.width !== width || size.height !== height) return;
        clearTimeout(timer);
        win.webContents.off('paint', onPaint);
        resolve(image);
      };
      win.webContents.on('paint', onPaint);
    });
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { TrayImageRenderer, SCALE };
