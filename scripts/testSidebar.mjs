export default async function run(page, ui) {
  const sections = [
    { id: 'account', title: 'Account' },
    { id: 'language', title: 'Language' },
    { id: 'data', title: 'Data' },
    { id: 'audio', title: 'Audio' },
    { id: 'playback', title: 'Playback' },
    { id: 'appearance', title: 'Appearance' },
    { id: 'reminders', title: 'Reminders' },
    { id: 'privacy', title: 'Privacy' },
    { id: 'about', title: 'About' },
  ];

  const results = [];

  for (const sec of sections) {
    // Click the navigation link by href
    const link = page.locator(`a[href="#/settings?section=${sec.id}"]`);
    await link.click();

    // Wait for the section to be visible
    const selector = `#settings-${sec.id}`;
    try {
      await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
    } catch (e) {
      // Section not found; record error
    }

    // Screenshot the view
    const screenshotPath = `${sec.id}-section.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });

    // Capture innerHTML of the main content area
    const html = await page.locator('.settings-content').innerHTML();

    results.push({ section: sec.title, screenshot: screenshotPath, html });
  }

  return results;
}
