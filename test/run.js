const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  for (const variant of ['light', 'dark-zones']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 2 });
    page.on('console', (m) => console.log('console:', m.text()));
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    const seen = [];
    await page.route('**/api/hassio_ingress/**', async (route) => {
      const url = new URL(route.request().url());
      const cookie = (await route.request().allHeaders()).cookie || '';
      seen.push(url.pathname + ' cookie=' + /ingress_session=SESSION123/.test(cookie));
      const p = url.pathname.replace('/api/hassio_ingress/TOKEN', '');
      let body = {};
      if (p === '/api/rooms') body = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-room.json'), 'utf8'));
      else if (p === '/api/device-mappings/dev1') body = { mapping: { mappings: { target1X: 'sensor.kitchen_everything_presence_lite_target_1_x', target1Y: 'sensor.kitchen_everything_presence_lite_target_1_y' }, entityUnits: {} } };
      else if (p === '/api/custom-assets/furniture') body = { furniture: [{ id: 'custom-ab12cd34', label: 'Bin', color: '#607d8b', shape: 'circle' }] };
      else if (p === '/api/custom-assets/floors') body = { floors: [] };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(`http://127.0.0.1:8765/test/harness.html#${variant}`);
    await page.waitForSelector('everything-presence-floorplan-card');
    await page.waitForFunction(() => document.querySelector('everything-presence-floorplan-card').shadowRoot.querySelectorAll('.target').length === 2, null, { timeout: 5000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/card-${variant}.png`, clip: { x: 0, y: 0, width: 500, height: 640 } });
    // Move people and drop one
    await page.evaluate(() => { card.hass = makeHass([[ -200, 2600, true ],[0,0,false]]); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { card.hass = makeHass([[ 400, 3400, true ],[0,0,false]]); });
    await page.waitForTimeout(900);
    const info = await page.evaluate(() => {
      const sr = card.shadowRoot;
      return { targets: [...sr.querySelectorAll('.target')].map(g => g.style.transform), status: sr.querySelector('.status').textContent, msg: sr.querySelector('.message').textContent, trails: sr.querySelectorAll('.trails polyline').length };
    });
    console.log(variant, JSON.stringify(info), seen.join(' | '));
    await page.screenshot({ path: `${out}/card-${variant}-moved.png`, clip: { x: 0, y: 0, width: 500, height: 640 } });
    await page.close();
  }
  await browser.close();
})();
