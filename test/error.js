const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto('http://127.0.0.1:8765/test/harness.html#light');
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  const r = await page.evaluate(async () => {
    const c = document.createElement('everything-presence-floorplan-card');
    c.setConfig({ type: 'x', room: 'Nope' });
    document.body.appendChild(c);
    const h = makeHass([]);
    h.callWS = async () => { throw new Error('Unauthorized'); };
    c.hass = h;
    await new Promise((r) => setTimeout(r, 300));
    const e = document.createElement('everything-presence-floorplan-card-editor');
    e.setConfig({ room: 'Kitchen' }); e.hass = makeHass([]);
    document.body.appendChild(e);
    await new Promise((r) => setTimeout(r, 300));
    return [c.shadowRoot.querySelector('.message').textContent, document.querySelector('everything-presence-floorplan-card-editor').textContent];
  });
  console.log(r);
  await browser.close();
})();
