import { chromium } from 'playwright-core';

class BrowserManager {
  constructor() {
    this.browser = null;
    this.sessions = new Map();
  }

  async start() {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--no-first-run',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    console.log('Browser launched');
  }

  async getSession(userId) {
    if (this.sessions.has(userId)) return this.sessions.get(userId);

    const proxyOpts = process.env.OXY_HOST ? {
      proxy: {
        server: `http://${process.env.OXY_HOST}:${process.env.OXY_PORT}`,
        username: process.env.OXY_USERNAME,
        password: process.env.OXY_PASSWORD,
      },
    } : {};

    const context = await this.browser.newContext({
      ...proxyOpts,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1366, height: 768 },
    });

    // Stealth: hide headless detection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();

    // Block heavy resources for speed
    await context.route(
      /\.(png|jpg|jpeg|gif|svg|woff2?|ttf|eot|mp4|mp3|webm|ico)$/i,
      (route) => route.abort()
    );

    const session = { context, page };
    this.sessions.set(userId, session);
    return session;
  }

  async destroy(userId) {
    const s = this.sessions.get(userId);
    if (s) {
      await s.context.close();
      this.sessions.delete(userId);
    }
  }
}

export default BrowserManager;
