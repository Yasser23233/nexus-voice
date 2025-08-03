/*
 * Simple load test using Puppeteer.
 *
 * This script spawns a headless browser session for each predefined
 * username and has them join the room concurrently. It can be used
 * to measure signalling performance and identify concurrency issues.
 * Ensure that the server is running locally before invoking this
 * script. Adjust the TEST_URL environment variable to point to a
 * remote instance if necessary.
 */

const puppeteer = require('puppeteer');

const names = [
  'Andromeda',
  'Aurora',
  'Cosmos',
  'Luna',
  'Nebula',
  'Nova',
  'Orion',
  'Pulsar',
  'Zenith'
];

async function runLoadTest() {
  const url = process.env.TEST_URL || `http://localhost:${process.env.PORT || 3000}`;
  const browser = await puppeteer.launch({ headless: true });
  const pages = [];
  try {
    for (const name of names) {
      const page = await browser.newPage();
      pages.push(page);
      await page.goto(url, { waitUntil: 'networkidle2' });
      // Wait for the list to render
      await page.waitForSelector('#name-list li');
      // Click the corresponding name
      await page.evaluate((n) => {
        const items = Array.from(document.querySelectorAll('#name-list li'));
        const target = items.find((li) => li.textContent.trim() === n);
        if (target) target.click();
      }, name);
      // Wait for room to load
      await page.waitForSelector('#peer-list');
      console.log(`Spawned client for ${name}`);
    }
    // Allow some time for peers to establish connections
    await new Promise((resolve) => setTimeout(resolve, 10000));
  } catch (err) {
    console.error('Error during load test:', err);
  } finally {
    await browser.close();
  }
}

runLoadTest();