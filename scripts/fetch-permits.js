#!/usr/bin/env node
// Logs into Cityworks PublicAccess (a single-page app), runs the same fetch
// script the dashboard uses, and writes the result to ../data/latest.json.
// Designed to run inside a GitHub Actions workflow on a schedule.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://cityworks.cleburne.net/Permits/';
// PublicAccess uses client-side routing; this URL renders the login screen.
const LOGIN_URL = BASE_URL + '?currentRoutePath=/login';

const USERNAME = process.env.CITYWORKS_USERNAME;
const PASSWORD = process.env.CITYWORKS_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('Missing CITYWORKS_USERNAME or CITYWORKS_PASSWORD secrets.');
  process.exit(1);
}

const DEBUG_DIR = path.join(__dirname, '..', 'debug');
fs.mkdirSync(DEBUG_DIR, { recursive: true });

async function dumpDebug(page, tag) {
  try {
    const png = path.join(DEBUG_DIR, `${tag}.png`);
    const html = path.join(DEBUG_DIR, `${tag}.html`);
    await page.screenshot({ path: png, fullPage: true });
    fs.writeFileSync(html, await page.content());
    console.log(`[debug] saved ${png} and ${html}`);
  } catch (e) {
    console.log('[debug] dump failed:', e.message);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  page.on('console', msg => console.log(`[page-console:${msg.type()}]`, msg.text()));

  // ---- Step 1: Sign in ----
  console.log('Going to', LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // PublicAccess is an SPA — wait for the password field to actually render
  // before trying to fill anything.
  let passField;
  try {
    passField = await page.waitForSelector('input[type="password"]', {
      timeout: 30000,
      state: 'visible',
    });
  } catch (e) {
    await dumpDebug(page, 'no-password-field');
    throw new Error(
      'Login form never appeared. The page might be using SSO (Microsoft/Google) ' +
      'or a different login URL. Check debug/no-password-field.png in the build artifacts.'
    );
  }

  // Username field — try to find the closest preceding visible text input.
  let userField =
    (await page.$('input[name="LoginId" i]')) ||
    (await page.$('input[name="username" i]')) ||
    (await page.$('input[name="email" i]')) ||
    (await page.$('input[type="email"]:visible')) ||
    (await page.$('input[type="text"]:visible'));
  if (!userField) {
    // Fallback: any visible text-ish input that isn't the password.
    const all = await page.$$('input');
    for (const h of all) {
      const t = (await h.getAttribute('type')) || 'text';
      const visible = await h.isVisible();
      if (visible && t !== 'password' && t !== 'hidden' && t !== 'submit' && t !== 'button') {
        userField = h;
        break;
      }
    }
  }
  if (!userField) {
    await dumpDebug(page, 'no-username-field');
    throw new Error('Could not find username field. See debug/no-username-field.png.');
  }

  console.log('Filling credentials...');
  await userField.fill(USERNAME);
  await passField.fill(PASSWORD);

  // Submit. Try common buttons; if none match, press Enter on the password field.
  const submitCandidates = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Sign in")',
    'button:has-text("Log In")',
    'button:has-text("Login")',
    'button:has-text("Submit")',
  ];
  let clicked = false;
  for (const sel of submitCandidates) {
    const el = await page.$(sel);
    if (el && (await el.isVisible())) {
      console.log('Submitting via', sel);
      await el.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    console.log('No submit button matched; pressing Enter.');
    await passField.press('Enter');
  }

  // Wait for the password field to disappear (or URL to change), which signals
  // the SPA has accepted the login and routed away.
  try {
    await Promise.race([
      page.waitForSelector('input[type="password"]', { state: 'detached', timeout: 30000 }),
      page.waitForURL(u => !/login/i.test(u.toString()), { timeout: 30000 }),
    ]);
  } catch (e) {
    await dumpDebug(page, 'login-not-progressing');
    throw new Error('Login submitted but page didn\'t advance — credentials may be wrong, or there\'s an MFA prompt.');
  }

  console.log('Post-login URL:', page.url());

  // Make sure we're at /Permits/ before running fetches.
  if (!/\/Permits\/?$/.test(page.url()) && !page.url().includes('/Permits/')) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  }
  // Give the SPA a moment to settle so cookies/session state is ready.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // Sanity-check the session by hitting the home tab endpoint once.
  const sanityCheck = await page.evaluate(async () => {
    const r = await fetch('/Permits/services/HomePage/GetHomeTabResults', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=1',
    });
    return { status: r.status, ok: r.ok };
  });
  console.log('Sanity check on HomePage/GetHomeTabResults:', sanityCheck);
  if (!sanityCheck.ok) {
    await dumpDebug(page, 'session-not-authed');
    throw new Error('Session is not authenticated. Got status ' + sanityCheck.status);
  }

  // ---- Step 2: Run the same fetch logic the dashboard uses ----
  console.log('Fetching permits...');
  const data = await page.evaluate(async () => {
    const BASE = location.origin + '/Permits/services/';
    const post = (path, obj) =>
      fetch(BASE + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(JSON.stringify(obj || {})),
      })
        .then(r => r.json())
        .catch(() => ({ Value: [] }));

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

    const CONC = 4;
    const idx = { n: 0 };
    async function worker() {
      while (true) {
        const i = idx.n++;
        if (i >= permits.length) return;
        const p = permits[i];
        try {
          const tr = await post('CaseTask/ByCaObjectId', {
            CaObjectId: p.CaObjectId,
            CheckRelatedItems: true,
          });
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
