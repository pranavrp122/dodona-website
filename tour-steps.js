/** Guided tour steps for every page with a Help button, in the order a first-time visitor would want them, plus the Help menu links. */
import { waitFor, goToHash } from './tour.js';

const sec = id => `section[aria-labelledby="${id}"]`;
const go = (hash, ready) => () => goToHash(hash, ready);

/* ---------- public home page: booking a price ---------- */
export const homeTour = [
  { target: '[data-tour="promise"]', title: 'The short version', body: 'Dodona lets you lock in what you will pay for GPU time before you need it. If prices go up, you are covered. If they go down, you can rent somewhere cheaper instead.' },
  { target: '[data-tour="how"]', title: 'How it works', body: 'Choose the compute, pay a small fee to hold the price, then use it when your run starts. You only pay for the compute itself if you use it.' },
  { target: '#co-tabs', title: 'Pick a GPU', body: 'Start here. Each tab is a GPU model, and the chart shows what it has cost to rent over the last 90 days. Step 1, just below the chart, sets how many you need and where.' },
  { target: '[data-tour="window"]', title: 'Pick your window', body: 'Set when your run starts and ends. The shortcuts fill in a day, a week, two weeks or a month from the start date, and the times are shown in UTC as well.' },
  { target: '[data-tour="protection"]', title: 'Fixed price or a cap', body: 'A fixed price is one rate per GPU-hour, whatever the market does. A cap means you pay at most this, and can walk away if prices fall.' },
  { target: '[data-tour="quote"]', title: 'Your quote', body: 'The fee pays for the protection and the booking fee is a flat $2. Pay now is the two added up. Underneath is the most you would pay for the compute if you use it.', placement: 'left' },
  { target: '#co-buy', title: 'Buy protection', body: 'When it looks right, press Buy protection. You get a short review to confirm, then a receipt with a link to your dashboard. No money moves on this page.' },
  { target: '[data-tour="costs"]', title: 'What it costs in practice', body: 'Two worked examples for the same booking. If the price rises to $4 an hour, you save $78. If it falls to $2, you rent elsewhere and are only out the $22 you paid upfront.' },
  { target: '[data-tour="resale"]', title: 'If plans change', body: 'Do not need the hours any more? List them for another user to buy. You set the asking price and see exactly what you would get after the fee before you accept.' },
  { target: '[data-tour="faq"]', title: 'Questions', body: 'Short answers to what people ask most, like whether this is insurance, how you would get the compute and what the fees are. Tap a question to open it.' },
  { target: '#waitlist-form', title: 'Get early access', body: 'Leave your email and we will tell you when you can book for real. A line about what you would use it for helps us build the right thing.' },
];

/* ---------- buyer and lender console (/dashboard) ---------- */
const dashReady = () => waitFor('body[data-portfolio="loaded"]', 8000);
const overview = ready => go('#overview', ready);
const clockStep = body => ({ target: '#p-clock', title: 'The demo clock', body, before: dashReady });

const hasPositions = () => !!document.querySelector('#d-rows [data-row]');

// The positions screen with a row selected; an account with no positions moves on at once and its position steps are skipped.
async function openFirstPosition() {
  await goToHash('#positions', sec('d-ledger-h'));
  const row = document.querySelector('#d-rows [data-row]');
  if (!row) return;
  if (!document.querySelector('#d-rows [data-row][aria-selected="true"]')) row.click();
  await waitFor('[data-tour="detail-head"]', 2000);
}

const accountMenuStep = (back, ready) => ({
  target: '#p-acct-pop', title: 'Your account', placement: 'left',
  body: 'Your company, its verification status and the email you signed in with. Sign out is in here too. Help, just to the left, brings this tour back whenever you want it.',
  before: async () => {
    await goToHash(back, ready);
    const opener = document.querySelector('[data-pop="p-acct-pop"]');
    if (opener && document.getElementById('p-acct-pop')?.hidden) opener.click();
  },
  after: () => {
    const pop = document.getElementById('p-acct-pop');
    if (pop && !pop.hidden) { pop.hidden = true; document.querySelector('[data-pop="p-acct-pop"]')?.setAttribute('aria-expanded', 'false'); }
  },
});

const consoleSteps = [
  { target: sec('d-hero-h'), title: 'Total Dodona Value', body: 'What your remaining GPU-hours are worth at today\'s prices, compared with what you agreed to pay for them. Above zero means your contracts are saving you money right now.', before: overview(sec('d-hero-h')) },
  { target: sec('d-kpi-h'), title: 'Key figures', body: 'Behind that total sit what you still owe on fixed prices, the premiums paid for caps, the hours you have left and how the value moved this week.', before: overview(sec('d-kpi-h')) },
  { target: sec('d-chart-h'), title: 'Value over time', body: 'The top line is what your hours would cost at market prices and the lower one is what you committed to pay. The gap is your Dodona Value. The buttons from 1D to All change the range.', before: overview(sec('d-chart-h')) },
  { target: sec('d-alerts-mini-h'), title: 'Alerts', body: 'Things worth a look, like a big price move or a deadline coming up. The full list is under Alerts in the menu.', before: overview(sec('d-alerts-mini-h')) },
  { target: `${sec('d-ledger-h')}:has([data-row])`, title: 'Positions', body: 'Every price cap, fixed price and offtake you hold, one per row. Click a row to open its details underneath.', before: openFirstPosition, when: hasPositions },
  { target: '[data-tour="detail-head"]', title: 'The position you picked', body: 'Its name, where it stands and what you can do next. Before the window starts you can use the hours yourself or resell them. Open the order shows its full history.', before: openFirstPosition, when: hasPositions },
  { target: '[data-tour="terms"]', title: 'Term sheet', body: 'Every detail of the contract in one place, with the GPUs, the window, the price you locked in, today\'s index price and who supplies the compute.', before: openFirstPosition, when: hasPositions },
  { target: '[data-tour="what-if"]', title: 'What if', body: 'Drag the slider to try a different average price for the window and see what this contract would be worth to you. It is the quickest way to see where it starts to pay off.', before: openFirstPosition, when: hasPositions },
  { target: '.d-rail [data-nav="orders"]', title: 'Orders', body: 'Every order you have placed, from payment through delivery to settlement. Open one for its timeline, the emails it sent and what the GPU provider saw.', placement: 'right', before: overview(sec('d-hero-h')) },
  { target: '.d-rail [data-nav="offers"]', title: 'Offers', body: 'This is where you buy. GPU providers post price caps and fixed prices on real blocks of GPUs, and you can price your own dates too.', placement: 'right' },
  { target: sec('d-mail-h'), title: 'Emails', body: 'Every receipt, confirmation and settlement notice the platform sent you.', before: go('#emails', sec('d-mail-h')) },
  { target: sec('d-set-bill'), title: 'Billing and statements', body: 'Under Settings you can see what you have been billed and when the next invoice is due. Monthly statements sit just below, and both download as a spreadsheet.', before: go('#settings', sec('d-set-bill')) },
  accountMenuStep('#overview', sec('d-hero-h')),
];

export const dashboardTour = [
  clockStep('This is a demo, so you can move time forward and watch a contract run. Jump a day, a week or straight to settlement, and everything on the page catches up.'),
  ...consoleSteps,
];

export const lenderTour = [
  clockStep('This is a demo, so you can move time forward and watch the loans and the GPU prices behind them change. Everything on the page catches up as the date moves.'),
  { target: sec('d-shock-h'), title: 'Rent shock', body: 'Start here. Slide this to imagine GPU rents falling by up to 40% and watch what happens to every fleet you have lent against.', before: go('#lender', sec('d-shock-h')) },
  { target: sec('d-fleets-h'), title: 'Loan-to-value', body: 'Each row is a loan backed by GPUs. Loan-to-value (LTV) is the loan divided by what the fleet is worth. Under 60% is comfortable, and 75% or more is a breach.', before: go('#lender', sec('d-fleets-h')) },
  ...consoleSteps,
];

/* ---------- provider portal (/provider) ---------- */
const providerReady = () => waitFor('body[data-portal="loaded"]', 8000);

export const providerTour = [
  { target: '#p-clock', title: 'The demo clock', body: 'This is a demo, so you can move time forward. Reservations confirm, windows start, usage gets reported and payouts land as the date moves.', before: providerReady },
  { target: sec('p-cap-h'), title: 'Capacity', body: 'Your GPUs by type and region, with how many are held for Dodona orders and how many are still free to rent out.', before: go('#overview', sec('p-cap-h')) },
  { target: sec('p-inc-h'), title: 'Income', body: 'What you have earned this month and in total, from premiums and compute bills. It is all paid out through the escrow agent.', before: go('#overview', sec('p-inc-h')) },
  { target: sec('p-in-h'), title: 'Orders to confirm', body: 'When a buyer pays, the request lands here. Confirm holds the GPUs for their window. Decline releases them and the buyer gets a refund.', before: go('#orders', sec('p-in-h')) },
  { target: sec('p-con-h'), title: 'Contracts', body: 'Caps you sell earn a premium today on hours that might otherwise sit idle. Floors you buy protect your revenue if prices drop. Value shows which way each one is leaning.', before: go('#contracts', sec('p-con-h')) },
  { target: sec('p-wi-h'), title: 'What if', body: 'Drag the slider to pick an average price for the window and see every contract at once. A sold cap costs you more as prices rise. A bought floor pays more as they fall.', before: go('#contracts', sec('p-wi-h')) },
  { target: sec('p-stl-h'), title: 'Settlements and payouts', body: 'When a window ends, the contract settles on the average daily price and its statement shows up here. Payouts underneath show what has been paid and what is still due.', before: go('#settlements', sec('p-stl-h')) },
  { target: sec('p-ev-h'), title: 'Message log', body: 'Every message between Dodona and your systems, newest first. Open one to see the exact data, which helps a lot when you are wiring up your side.', before: go('#integration', sec('p-ev-h')) },
  { target: sec('p-key-h'), title: 'API key', body: 'Your systems sign their calls to Dodona with this key. A new key is only shown once, so copy it somewhere safe when you regenerate it.', before: go('#integration', sec('p-key-h')) },
  { target: sec('p-hook-h'), title: 'Webhook and the guide', body: 'Tell us where to send reservation requests. The guide, one click away, walks through every message and what your side should send back.', before: go('#integration', sec('p-hook-h')) },
  { target: sec('p-res-h'), title: 'Auto-confirm', body: 'Leave this on and requests confirm by themselves when the clock moves. Turn it off if you would rather approve each one yourself in Orders.', before: go('#settings', sec('p-res-h')) },
];

/* ---------- admin portal (/admin) ---------- */
// Opens the first customer account (not an admin login, which has no orders to show).
async function openFirstAccount() {
  if (!/^#account\//.test(location.hash)) {
    const first = await goToHash('#accounts', '#a-acc-rows tr[data-href]');
    const rows = [...document.querySelectorAll('#a-acc-rows tr[data-href]')];
    const row = rows.find(r => r.cells[2]?.textContent.trim() !== 'Admin') || first;
    if (row) await goToHash(row.dataset.href);
  }
  await waitFor(sec('a-d-contact-h'), 5000);
}

export const adminTour = [
  { target: sec('a-acc-h'), title: 'Every account', body: 'Each login, who it belongs to and how far along they are. Search, or filter by role, stage and KYB (the business identity check), to find someone fast.', before: async () => { await waitFor('body[data-admin="ready"]', 8000); await goToHash('#accounts', '#a-acc-rows tr[data-href]'); } },
  { target: '[data-act="create-open"]', title: 'Create an account', body: 'Set up a login before a meeting. Choose the role and a password, and they can sign in straight away.', placement: 'left', before: go('#accounts', '[data-act="create-open"]') },
  { target: sec('a-d-contact-h'), title: 'Contact card', body: 'Open an account to see its details. You can fix the company name or phone, and move its stage and KYB status along as things progress.', before: openFirstAccount },
  { target: sec('a-d-notes-h'), title: 'Notes', body: 'Write down what happened in a meeting and what comes next. Only admins see these.', before: openFirstAccount },
  { target: sec('a-d-orders-h'), title: 'Their orders', body: 'Everything this account has bought, with its status, price and the result once it settles.', before: openFirstAccount },
  { target: sec('a-d-clock-h'), title: 'Demo clock and reset', body: 'Where this account\'s demo date stands. Reset puts its orders, prices, emails and clock back to the start, which is handy before showing it to someone new. Notes stay.', before: openFirstAccount },
  { target: sec('a-orders-h'), title: 'All orders', body: 'Every order across every account. The buttons at the top filter by status, and Events shows the messages for a single order.', before: go('#orders', sec('a-orders-h')) },
  { target: '[aria-labelledby^="a-nc-"]', title: 'Neoclouds', body: 'Each GPU provider, how much capacity it has, what is reserved and the contracts written on it.', before: go('#neoclouds', '[aria-labelledby^="a-nc-"]') },
  { target: sec('a-activity-h'), title: 'Activity', body: 'The latest messages between Dodona and the GPU providers, across all accounts. A good place to check that something really happened.', before: go('#activity', sec('a-activity-h')) },
  { target: sec('a-sync-state-h'), title: 'Supabase sync', body: 'Copies the CRM tables to your own Supabase project every minute or so. The steps next to it walk through the one-time setup.', before: go('#sync', sec('a-sync-state-h')) },
];

/* ---------- buyer pages: one order, the orders list, the offers board, checkout ---------- */
const pageReady = () => waitFor('body[data-ready="1"]', 8000);
const shown = id => () => document.getElementById(id)?.hidden === false;

export const orderTour = [
  { target: sec('od-tl-h'), title: 'Where it stands', body: 'The order\'s journey from payment to settlement. The highlighted step is where it is now, and it moves along as each date passes.', before: async () => { await pageReady(); await waitFor('#od-body', 5000); } },
  { target: '#od-choice-box', when: shown('od-choice-box'), title: 'Use or resell', body: 'Before the window starts, choose whether you will use the hours yourself or resell them to someone else.' },
  { target: '#od-list-box', when: shown('od-list-box'), title: 'Your listing', body: 'When you resell, the hours go on the board. Bids come in from buyers, and you can counter or accept the best one.' },
  { target: '#od-settle-box', when: shown('od-settle-box'), title: 'Settlement statement', body: 'Once the window closes, this shows the average price over the window, what you were billed and what you saved.' },
  { target: sec('od-terms-h'), title: 'Term sheet', body: 'The contract itself, with the GPUs, window, price and who supplies the compute.' },
  { target: sec('od-pay-h'), title: 'Payouts', body: 'Every payment tied to this order and whether it has gone out yet. Money always moves through the escrow agent, never through Dodona.' },
  { target: '#od-events-box', title: 'What the neocloud saw', body: 'The messages Dodona and the GPU provider swapped about this order. Open it to read each one.', placement: 'top' },
];

export const ordersTour = [
  { target: '#or-tabs', title: 'Filter', body: 'Show everything, only open orders, settled ones, or those still waiting for payment.', before: pageReady },
  { target: sec('or-h'), title: 'Your orders', body: 'Newest first, with where each one stands. Open any order for its timeline, term sheet and payouts.' },
  { target: '#p-content a[href="/offers"]', title: 'Place another', body: 'Ready for more? This opens the offers board, where every order starts.', placement: 'left' },
];

export const offersTour = [
  { target: '#of-filters', title: 'Narrow it down', body: 'Filter the board by GPU, region or the kind of protection you want.', before: async () => { await pageReady(); await waitFor('#of-rows a[href^="/checkout"]', 5000); } },
  { target: '#of-rows tr:first-child', title: 'An offer', body: 'Each row is a block of GPUs from a provider, with the window, the price, the premium you pay now and the break-even, the average price where it starts paying for itself.' },
  { target: '#of-rows a[href^="/checkout"]', title: 'Take this offer', body: 'Found one you like? This takes you to checkout, where you choose how many GPUs and pay with a test card.', placement: 'left' },
  { target: '#custom', title: 'Price your own', body: 'Nothing on the board fits? Pick the GPU, the dates and a price, and you get a quote from the same model the board uses.' },
];

export const checkoutTour = [
  { target: sec('co-qty-h'), title: 'How many', body: 'Choose how many GPUs you want from this block. The summary updates as you type.', before: async () => { await pageReady(); await waitFor('#co-body', 4000); } },
  { target: sec('co-sum-h'), title: 'Order summary', body: 'Before you pay you see the premium, the booking fee and what you pay today. For a cap, it also shows the break-even price.', placement: 'left' },
  { target: '[data-tour="test-cards"]', title: 'Test cards', body: 'Use a test card here. 4242 4242 4242 4242 goes through, and the other two show what a decline looks like.' },
  { target: '#co-pay', title: 'Pay', body: 'Paying takes you straight to your new order, where you can follow it from reservation to settlement.' },
];

/* ---------- which tour belongs to which page ---------- */
const BUYER_LINKS = [['/methodology', 'file-text', 'How we value contracts'], ['/audit', 'file-text', 'Audit trail']];
const TOURS = {
  home: { key: 'home', steps: homeTour, links: [] },
  dashboard: { key: 'dashboard', steps: dashboardTour, links: BUYER_LINKS },
  lender: { key: 'lender', steps: lenderTour, links: BUYER_LINKS },
  provider: { key: 'provider', steps: providerTour, links: [['/docs/neocloud-api', 'book-open', 'Integration guide']], role: 'provider' },
  admin: { key: 'admin', steps: adminTour, links: [['#sync', 'database', 'Supabase setup']], role: 'admin' },
  order: { key: 'order', steps: orderTour, links: BUYER_LINKS },
  orders: { key: 'orders', steps: ordersTour, links: BUYER_LINKS },
  offers: { key: 'offers', steps: offersTour, links: BUYER_LINKS },
  checkout: { key: 'checkout', steps: checkoutTour, links: BUYER_LINKS },
};

/** The tour name for a console path: /dashboard (lender or buyer), /provider, /admin, /orders, /orders/:ref, /offers or /checkout. */
export function tourName(pathname, role) {
  if (pathname === '/dashboard') return role === 'lender' ? 'lender' : 'dashboard';
  if (/^\/orders\/[^/]+$/.test(pathname)) return 'order';
  const name = pathname.replace(/^\/|\/$/g, '');
  return ['provider', 'admin', 'orders', 'offers', 'checkout'].includes(name) ? name : null;
}

/** { key, steps, links } for a tour name, or null when there is none or the account cannot use it (the admin tour needs an admin). */
export function tourFor(name, account) {
  const tour = TOURS[name];
  if (!tour || (tour.role && account?.role !== tour.role)) return null;
  return tour;
}
