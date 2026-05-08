#!/usr/bin/env node
// Logs into Cityworks PublicAccess (a single-page app), pulls all residential,
// plumbing, and electrical permits, and stitches BPEL-TPOLE (T-Pole) and
// BPPL-ROUGH (Rough Plumbing) tasks from the plumbing/electrical sub-permits
// into each residential permit's Tasks array — so the dashboard sees them as
// part of the main workflow.
//
// Writes output to ../data/latest.json. Designed for GitHub Actions.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://cityworks.cleburne.net/Permits/';
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

  let passField;
  try {
    passField = await page.waitForSelector('input[type="password"]', {
      timeout: 30000,
      state: 'visible',
    });
  } catch (e) {
    await dumpDebug(page, 'no-password-field');
    throw new Error('Login form never appeared. Check debug/no-password-field.png.');
  }

  let userField =
    (await page.$('input[name="LoginId" i]')) ||
    (await page.$('input[name="username" i]')) ||
    (await page.$('input[name="email" i]')) ||
    (await page.$('input[type="email"]:visible')) ||
    (await page.$('input[type="text"]:visible'));
  if (!userField) {
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
    throw new Error('Could not find username field.');
  }

  await userField.fill(USERNAME);
  await passField.fill(PASSWORD);

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
      await el.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) await passField.press('Enter');

  try {
    await Promise.race([
      page.waitForSelector('input[type="password"]', { state: 'detached', timeout: 30000 }),
      page.waitForURL(u => !/login/i.test(u.toString()), { timeout: 30000 }),
    ]);
  } catch (e) {
    await dumpDebug(page, 'login-not-progressing');
    throw new Error('Login submitted but page did not advance.');
  }

  console.log('Post-login URL:', page.url());

  if (!/\/Permits\/?$/.test(page.url()) && !page.url().includes('/Permits/')) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // ---- Step 2: Run the data pull inside the page context ----
  console.log('Fetching permits + plumbing/electrical sub-permits...');
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

    // Address normalizer that mirrors the dashboard's normStr/addrKeys.
    function normAddr(s){
      if (!s) return '';
      return String(s).toUpperCase()
        .replace(/[,.#]/g, ' ')
        .replace(/\bSTREET\b/g, 'ST')
        .replace(/\bDRIVE\b/g, 'DR')
        .replace(/\bROAD\b/g, 'RD')
        .replace(/\bAVENUE\b/g, 'AVE')
        .replace(/\bBOULEVARD\b/g, 'BLVD')
        .replace(/\bLANE\b/g, 'LN')
        .replace(/\bCIRCLE\b/g, 'CIR')
        .replace(/\bCOURT\b/g, 'CT')
        .replace(/\bPLACE\b/g, 'PL')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .slice(0, 4)
        .join(' ');
    }

    // ---- 2a. Pull the home tab (all cases this account can see) ----
    const home = await fetch(BASE + 'HomePage/GetHomeTabResults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=1',
    }).then(r => r.json());

    const EXCLUDED = new Set(['CON-005561']);
    const all = (home.Value || [])
      .filter(p => p && p.CaseType !== 'BPCONTRACT' && !EXCLUDED.has(p.CaseNumber));

    // Split by SubType: residential vs. plumbing vs. electrical sub-permits.
    const residential = all.filter(p => p.SubType === 'BPNEWCONST').map(p => Object.assign({}, p));
    const plumbing    = all.filter(p => p.SubType === 'BPPLUMBING');
    const electrical  = all.filter(p => p.SubType === 'BPELECTRIC');

    // Build address -> sub-permit CaObjectId maps so we can match by address.
    function buildAddrMap(list){
      const m = new Map();
      for (const p of list){
        const a = normAddr(p.Location || p.Address || '');
        if (!a) continue;
        if (!m.has(a)) m.set(a, []);
        m.get(a).push(p.CaObjectId);
      }
      return m;
    }
    const plumbByAddr = buildAddrMap(plumbing);
    const elecByAddr  = buildAddrMap(electrical);

    // Cache so we don't re-fetch the same sub-permit's tasks if it shows up
    // multiple times (shouldn't, but cheap insurance).
    const subTaskCache = new Map();
    async function fetchSubTasks(caObjectId){
      if (subTaskCache.has(caObjectId)) return subTaskCache.get(caObjectId);
      const r = await post('CaseTask/ByCaObjectId', { CaObjectId: caObjectId, CheckRelatedItems: true });
      const tasks = r.Value || [];
      subTaskCache.set(caObjectId, tasks);
      return tasks;
    }

    // ---- 2b. Address resolution for residential permits ----
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

    // ---- 2c. For each residential permit, pull tasks + matched sub-permit
    //          inspection rows, then merge T-Pole / Rough Plumbing into the
    //          Tasks array at the right positions. ----
    function tidyTask(t){
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
    }

    function findFirstIndex(arr, code){
      for (let i = 0; i < arr.length; i++) if (arr[i].TaskCode === code) return i;
      return -1;
    }
    function findLastIndex(arr, code){
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].TaskCode === code) return i;
      return -1;
    }
    function injectAt(tasksArr, opts, newTasks){
      // opts: { afterLast: code } | { beforeFirst: code }
      // Falls back through fallback list if primary anchor missing.
      // Last resort: append at end of milestone-4 group, or end of array.
      if (!newTasks.length) return;
      const tries = Array.isArray(opts) ? opts : [opts];
      for (const opt of tries){
        if (opt.afterLast){
          const i = findLastIndex(tasksArr, opt.afterLast);
          if (i >= 0){ tasksArr.splice(i + 1, 0, ...newTasks); return; }
        }
        if (opt.beforeFirst){
          const i = findFirstIndex(tasksArr, opt.beforeFirst);
          if (i >= 0){ tasksArr.splice(i, 0, ...newTasks); return; }
        }
      }
      // Fallback: end of milestone 4
      let lastM4 = -1;
      for (let i = 0; i < tasksArr.length; i++){
        const m = tasksArr[i].StartPoint || tasksArr[i].Milestone || tasksArr[i].TaskGroup || tasksArr[i].Tab;
        if (Number(m) === 4) lastM4 = i;
      }
      if (lastM4 >= 0) tasksArr.splice(lastM4 + 1, 0, ...newTasks);
      else tasksArr.push(...newTasks);
    }

    const CONC = 4;
    const idx = { n: 0 };
    let mergedTPole = 0, mergedRough = 0, missingPlumb = 0, missingElec = 0;

    async function worker() {
      while (true) {
        const i = idx.n++;
        if (i >= residential.length) return;
        const p = residential[i];
        try {
          // Main residential workflow tasks.
          const tr = await post('CaseTask/ByCaObjectId', {
            CaObjectId: p.CaObjectId,
            CheckRelatedItems: true,
          });
          p.Tasks = (tr.Value || []).map(tidyTask);

          // Resolve street address.
          const { addr, record } = await fetchAddress(p.CaObjectId);
          if (addr) p.Address = addr;
          if (record) p.AddressRecord = record;
          if (!p.Address) p.Address = p.Location || null;

          const matchKey = normAddr(p.Address || p.Location);

          // T-Pole rows from the matched electrical sub-permit.
          const elIds = (matchKey && elecByAddr.get(matchKey)) || [];
          if (!elIds.length) missingElec++;
          for (const eid of elIds){
            const subTasks = await fetchSubTasks(eid);
            const tpoles = subTasks
              .filter(t => t.TaskCode === 'BPEL-TPOLE')
              .map(t => {
                const o = tidyTask(t);
                o._fromCaObjectId = eid;
                o._fromCaseSubType = 'BPELECTRIC';
                return o;
              });
            if (tpoles.length){
              // T-Pole goes between Create Water/Sewer and Setback — i.e.
              // right after BPWTRSWRWO (review step), or right before SETBAC
              // if WTRSWRWO is missing.
              injectAt(p.Tasks, [
                { afterLast: 'BPWTRSWRWO' },
                { beforeFirst: 'BPB-SETBAC' },
              ], tpoles);
              mergedTPole += tpoles.length;
            }
          }

          // Rough Plumbing rows from the matched plumbing sub-permit.
          const plIds = (matchKey && plumbByAddr.get(matchKey)) || [];
          if (!plIds.length) missingPlumb++;
          for (const pid of plIds){
            const subTasks = await fetchSubTasks(pid);
            const roughs = subTasks
              .filter(t => t.TaskCode === 'BPPL-ROUGH')
              .map(t => {
                const o = tidyTask(t);
                o._fromCaObjectId = pid;
                o._fromCaseSubType = 'BPPLUMBING';
                return o;
              });
            if (roughs.length){
              // Rough Plumbing goes right after the LAST Setback row (so it
              // lands after any reinspection attempts), with the foundation
              // anchor as a safety net.
              injectAt(p.Tasks, [
                { afterLast: 'BPB-SETBAC' },
                { beforeFirst: 'BPB-FOUNDA' },
              ], roughs);
              mergedRough += roughs.length;
            }
          }
        } catch (e) {
          p.Tasks = p.Tasks || [];
          p._err = e.message;
        }
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));

    return {
      generated: Date.now(),
      permits: residential,
      _stats: { mergedTPole, mergedRough, missingPlumb, missingElec, total: residential.length },
    };
  });

  console.log(`Fetched ${data.permits.length} permits. Stats:`, data._stats);

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
