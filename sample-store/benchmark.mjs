#!/usr/bin/env node
// Token benchmark: the same QA task on the official @playwright/mcp and on playwright-lite-mcp.
// Task: guest checkout of a simple product up to the payment step, then read the order totals
// and the console errors. Measures what lands in the agent's context: tool results, plus the tool
// definitions, which are sent to the model with EVERY request of a session.
//
// The official server gets the cheapest realistic call sequence an agent could make (one snapshot
// whenever element refs are needed, one fill_form for all fields); a real agent usually needs more.
// Tokens are estimated as chars / 4 (typical for English text and code).
//
// Usage: node sample-store/benchmark.mjs [base-url]       (needs Google Chrome for the official server)
import { fileURLToPath } from 'node:url';
import { startMcpServer } from './mcp-client.mjs';

const base = (process.argv[2] ?? 'https://app.hyva-demo.test').replace(/\/$/, '');
const productUrl = `${base}/joust-duffle-bag.html`;
const OFFICIAL = '@playwright/mcp@0.0.86';
const tokens = (chars) => Math.round(chars / 4);

/** Finds an element ref in a @playwright/mcp snapshot: `- textbox "First Name*" [ref=f2e42]`. */
function ref(snapshot, role, name) {
  // Refs may carry a frame prefix (f2e32); YAML quotes lines that contain a colon.
  const re = new RegExp(`- '?${role} "([^"]*)" \\[ref=(\\w+)\\]`, 'g');
  for (const m of snapshot.matchAll(re)) if (name.test(m[1])) return m[2];
  throw new Error(`no ${role} matching ${name} in snapshot`);
}

async function official() {
  const s = await startMcpServer('npx', ['-y', OFFICIAL, '--headless', '--isolated', '--browser', 'chrome'], { quiet: true });
  const calls = [];
  const call = async (name, args) => {
    const r = await s.call(name, args);
    if (!r.ok) throw new Error(`${name}: ${r.text.slice(0, 300)}`);
    calls.push({ name, chars: r.chars });
    return r.text;
  };
  try {
    const schema = JSON.stringify(await s.listTools()).length;
    await call('browser_navigate', { url: productUrl });
    let snap = await call('browser_snapshot', {});
    await call('browser_click', { element: 'Add to Cart', target: ref(snap, 'button', /^Add to Cart$/) });
    await call('browser_wait_for', { text: 'You added' });
    await call('browser_navigate', { url: `${base}/checkout/` });
    await call('browser_wait_for', { text: 'Shipping Methods' });
    snap = await call('browser_snapshot', {});
    const field = (name, value) => ({ name: name.source, element: name.source, target: ref(snap, 'textbox', name), type: 'textbox', value });
    await call('browser_fill_form', {
      fields: [
        field(/^Email Address/, 'guest@example.com'),
        field(/^First Name/, 'Test'),
        field(/^Last Name/, 'Guest'),
        field(/^Street Address: Line 1/, '123 Main Street'),
        field(/^City/, 'Austin'),
        field(/^Zip\/Postal Code/, '78701'),
        field(/^Phone Number/, '5125550100'),
      ],
    });
    await call('browser_select_option', { element: 'State/Province', target: ref(snap, 'combobox', /^State\/Province/), values: ['Texas'] });
    await call('browser_wait_for', { time: 3 });
    snap = await call('browser_snapshot', {});
    await call('browser_click', { element: 'Flat Rate', target: ref(snap, 'radio', /Flat Rate/) });
    await call('browser_click', { element: 'Next', target: ref(snap, 'button', /^Next$/) });
    await call('browser_wait_for', { text: 'Payment Method' });
    snap = await call('browser_snapshot', {});
    if (!/Order Total/.test(snap)) throw new Error('totals not found on payment step');
    await call('browser_console_messages', { level: 'error' });
    return { schema, calls };
  } finally {
    s.close();
  }
}

async function lite(tool, args) {
  const server = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const s = await startMcpServer(process.execPath, [server], {
    quiet: true,
    env: { PW_ALLOWED_ORIGINS: new URL(base).origin, PW_HEADLESS: 'true', PW_ALLOW_SCRIPTS: 'true' },
  });
  try {
    const schema = JSON.stringify(await s.listTools()).length;
    const r = await s.call(tool, args);
    if (!r.ok) throw new Error(`${tool}: ${r.text.slice(0, 300)}`);
    return { schema, calls: [{ name: tool, chars: r.chars }] };
  } finally {
    s.close();
  }
}

const runs = [
  { label: `${OFFICIAL} (tool chain)`, ...(await official()) },
  { label: 'playwright-lite: magento_guest_checkout', ...(await lite('magento_guest_checkout', { productUrl })) },
  {
    label: 'playwright-lite: browser_run + magento.checkout',
    ...(await lite('browser_run', {
      code: `const r = await magento.checkout({ productUrl: '${productUrl}' });
             return { ok: r.ok, totals: r.totals, consoleErrors: r.consoleErrors.length, failedRequests: r.failedRequests.length };`,
    })),
  },
];

const rows = runs.map((r) => {
  const results = r.calls.reduce((n, c) => n + c.chars, 0);
  return { ...r, results, total: results + r.schema };
});
const baseline = rows[0];
console.log(`Task: guest checkout to the payment step + totals + console errors, ${productUrl}\n`);
console.log('| Server | Tool calls | Tool results | Tool definitions | Total (one task) |');
console.log('|---|---|---|---|---|');
for (const r of rows) {
  const saving = r === baseline ? '' : ` (${Math.round((1 - r.total / baseline.total) * 100)}% less)`;
  console.log(
    `| ${r.label} | ${r.calls.length} | ~${tokens(r.results).toLocaleString('en')} tok | ` +
      `~${tokens(r.schema).toLocaleString('en')} tok | ~${tokens(r.total).toLocaleString('en')} tok${saving} |`,
  );
}
console.log(`\nOfficial call sequence: ${baseline.calls.map((c) => `${c.name} ${tokens(c.chars)}`).join(', ')}`);
console.log('Tool definitions are re-sent with every model request, so in a long session they repeat many times.');
