#!/usr/bin/env node
// Logs into Cityworks PublicAccess, runs the same fetch script the dashboard
// uses (HomePage/GetHomeTabResults + CaseTask + CaseAddress), and writes the
// result to ../data/latest.json. Designed to run inside a GitHub Actions
// workflow on a schedule.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://cityworks.cleburne.net/Permits/';
const LOGIN_URL = BASE_URL + 'login';

const USERNAME = process.env.CITYWORKS_USERNAME;
const PASSWORD = process.env.CITYWORKS_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('Missing CITYWORKS_USERNAME or CITYWORKS_PASSWORD secrets.');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();

  // ---- Step 1: Sign in ----
  console.log('Going to', LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // Find username + password fields with permissive selectors so we don't
  // have to hardcode Cityworks-specific element names.
  const usernameSelectors = [
    'input[name="LoginId" i]',
    'input[name="username" i]',
    'input[name="email" i]',
    'input[type="email"]',
    'input[id*="login" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
  ];
  const passwordSelectors = [
    'input[name="Password" i]',
    'input[name="password" i]',
    'input[type="password"]',
  ];

  async function findFirst(selectors) {
    for (const s of selectors) {
      const handle = await page.$(s);
      if (handle) return s;
    }
    return null;
  }

  const userSel = await findFirst(usernameSelectors);
  const passSel = await findFirst(passwordSelectors);
  if (!userSel || !passSel) {
    throw new Error(
      `Could not find login form fields on ${page.url()}. ` +
      `Update LOGIN_URL or selectors in scripts/fetch-permits.js.`
    );
  }
  console.log(`Using username selector: ${userSel}`);
  console.log(`Using password selector: ${passSel}`);

  await page.fill(userSel, USERNAME);
  await page.fill(passSel, PASSWORD);

  // Submit. Try button[type=submit] first, then a generic submit input.
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button:has-text("Login")',
  ];
  const submitSel = await findFirst(submitSelectors);
  if (!submitSel) throw new Error('Could not find submit button on login form.');
  console.log(`Submitting via: ${submitSel}`);

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
    page.click(submitSel),
  ]);

  const postLoginUrl = page.url();
  console.log('Post-login URL:', postLoginUrl);
  if (/login|sign.?in|error/i.test(postLoginUrl) && !postLoginUrl.endsWith('/Permits/')) {
    throw new Error('Login appears to have failed. Check CITYWORKS_USERNAME / CITYWORKS_PASSWORD.');
  }

  // Make sure we're inside /Permits/ before running fetches.
  if (!postLoginUrl.includes('/Permits/')) {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  }

  // ---- Step 2: Run the same fetch logic the dashboard uses ----
  console.log('Fetching permits...');
  const data = await page.evaluate(async () => {
    const BASE = location.origin + '/Permits/services/';
    const post = (path, obj) => fetch(BASE + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(JSON.stringify(obj || {})),
    }).then(r => r.json()).catch(() => ({ Value: [] }));

    const tab = await fetch(BASE + 'HomePage/GetHomeTabResults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=1',
    }).then(r => r.json());

    const EXCLUDED = new Set(['CON-005561']);
    const permits = (tab.Value || [])
      .filter(p => p && p.CaseType !== 'BPCONTRACT' && !EXCLUDED.has(p.CaseNumber))
      .map(p => Object.assign({}, p));

    function deriveAddress(rec) {
      if (!rec) return null;
      if (rec.FormatedAddress) return rec.FormatedAddress;
      if (rec.FormattedAddress) return rec.FormattedAddress;
      if (rec.FullAddress) return rec.FullAddress;
      const pieces = [
        rec.HouseNumber || rec.StreetNumber,
        rec.StreetPrefix || rec.PreDirection,
        rec.StreetName,
        rec.StreetType || rec.StreetSuffix,
        rec.PostDirection,
      ].filter(Boolean);
      const line1 = pieces.join(' ').trim();
      return line1 || null;
    }

    async function fetchAddress(caObjectId) {
      const tries = [
        ['CaseAddress/SearchObject',   { CaObjectId: caObjectId }],
        ['CaseAddress/ByCaObjectId',   { CaObjectId: caObjectId }],
        ['CaseAddress/Search',         { CaObjectId: caObjectId }],
        ['CaseAddress/ByCaseObjectId', { CaseObjectId: caObjectId }],
        ['CaseAddress',                { CaObjectId: caObjectId }],
        ['Address/SearchObject',       { CaObjectId: caObjectId }],
        ['Case/GetDetailsByCaObjectId', { CaObjectId: caObjectId }],
        ['CaseObject/GetCaseDetail',    { CaObjectId: caObjectId }],
      ];
      for (const [path, body] of tries) {
        const r = await post(path, body);
        let rec = null;
        if (r && r.Value) {
          if (Array.isArray(r.Value) && r.Value.length) rec = r.Value[0];
          else if (r.Value.Addresses && r.Value.Addresses.length) rec = r.Value.Addresses[0];
          else if (r.Value.Address) rec = r.Value.Address;
          else if (typeof r.Value === 'object' && !Array.isArray(r.Value)) rec = r.Value;
        }
        if (rec) {
          const addr = deriveAddress(rec);
          if (addr) return { addr, record: rec };
        }
      }
      return { addr: null, record: null };
    }

    // Fetch tasks & address with bounded concurrency. Cityworks rate-limits
    // bursty traffic, so keep this conservative.
    const CONC = 4;
    const idx = { n: 0 };
    async function worker() {
      while (true) {
        const i = idx.n++;
        if (i >= permits.length) return;
        const p = permits[i];
        try {
          const tr = await post('CaseTask/ByCaObjectId', { CaObjectId: p.CaObjectId, CheckRelatedItems: true });
          p.Tasks = (tr.Value || []).map(t => {
            const o = Object.assign({}, t);
            if (o.TaskDesc) o.TaskDesc = String(o.TaskDesc).trim();
            if (Array.isArray(o.CaTaskCommentsItemList)) {
              o.Comments = o.CaTaskCommentsItemList.map(c => ({
                text: (c.Commenttext || c.CommentText || '').trim(),
                by: (c.CreatedByLoginId || c.LoginId || '').trim(),
                date: c.DateCreated || c.CreatedDate || null,
              }));
            } else if (!Array.isArray(o.Comments)) {
              o.Comments = [];
            }
            return o;
          });

          const { addr, record } = await fetchAddress(p.CaObjectId);
          if (addr) p.Address = addr;
          if (record) p.AddressRecord = record;
          if (!p.Address) p.Address = p.Location || null;
        } catch (e) {
          p.Tasks = p.Tasks || [];
          p._err = e.message;
        }
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));

    return { generated: Date.now(), permits };
  });

  console.log(`Fetched ${data.permits.length} permits.`);

  // ---- Step 3: Write to data/latest.json ----
  const outPath = path.join(__dirname, '..', 'data', 'latest.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data));
  console.log(`Wrote ${outPath}`);

  await browser.close();
})().catch(err => {
  console.error('Refresh failed:', err);
  process.exit(1);
});
