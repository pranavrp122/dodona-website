import defaults from '../site.json' with { type: 'json' };
import { structuredData } from './discovery.mjs';

export function readSiteSettings(environment = process.env) {
  const settings = {
    operatorName: (environment.OPERATOR_NAME || defaults.operatorName).trim(),
    contactEmail: (environment.CONTACT_EMAIL || defaults.contactEmail).trim().toLowerCase(),
    retentionDays: environment.WAITLIST_RETENTION_DAYS ? Number(environment.WAITLIST_RETENTION_DAYS) : null,
  };
  if (settings.operatorName.length > 160 || /[\x00-\x1f]/.test(settings.operatorName)) throw new Error('Invalid OPERATOR_NAME.');
  if (settings.contactEmail && (settings.contactEmail.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,63}$/i.test(settings.contactEmail))) throw new Error('Invalid CONTACT_EMAIL.');
  if (settings.retentionDays !== null && (!Number.isInteger(settings.retentionDays) || settings.retentionDays < 1 || settings.retentionDays > 3650)) throw new Error('Invalid WAITLIST_RETENTION_DAYS.');
  return settings;
}

export const collectionDetailsReady = settings => Boolean(settings.operatorName && settings.contactEmail);
export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function privacyBody(settings, heading = 'h2') {
  const ready = collectionDetailsReady(settings);
  const contact = settings.contactEmail ? `<a href="mailto:${escapeHtml(settings.contactEmail)}">${escapeHtml(settings.contactEmail)}</a>` : 'Contact details will be published before signups open.';
  return `${ready ? '' : '<p class="notice-box">Contact details are being finalized. Signups remain closed until they are published.</p>'}
    <${heading}>Who handles your information</${heading}>
    <p>${settings.operatorName ? escapeHtml(settings.operatorName) + ' operates the Dodona waitlist.' : 'The operator’s details will be published before signups open.'} ${contact}</p>
    <${heading}>What we collect and why</${heading}>
    <p>We save your email, any project or interest details you share, and the signup time. We use them for product updates and possible early access. Joining doesn’t buy protection or guarantee access.</p>
    <p>We temporarily use connection/IP addresses and form tokens to limit spam.</p>
    <${heading}>Storage and access</${heading}>
    <p>When signups are open, details go into a private Supabase database. Only the authorized Dodona team can read them. The host processes requests to run the site. The form doesn’t share your details with compute providers or publish a signup list.</p>
    <${heading}>Retention</${heading}>
    <p>${settings.retentionDays ? `The waitlist retention period is ${settings.retentionDays} days from signup. You can request deletion sooner.` : 'We keep signup details for Dodona product updates and possible early access until you ask us to remove them.'}</p>
    <${heading}>Unsubscribe, correction, or deletion</${heading}>
    <p>${settings.contactEmail ? `Email ${contact} from your signup address to unsubscribe, correct your details, or ask us to delete them. We may check that the address belongs to you.` : 'We’ll publish a contact address before opening signups.'}</p>
    <${heading}>Cookies and analytics</${heading}>
    <p>This demo has no marketing cookies, ads, or analytics scripts. Signup details are not saved in browser storage.</p>`;
}

export function renderPage(html, { settings = readSiteSettings(), origin = '', path = '/' } = {}) {
  const canonical = origin ? `<link rel="canonical" href="${escapeHtml(origin + path)}"><meta property="og:url" content="${escapeHtml(origin + path)}">` : '';
  const image = `${origin}/assets/social-card.png`;
  const sharing = `<meta property="og:image" content="${escapeHtml(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Dodona — protection against rising compute costs"><meta name="twitter:image" content="${escapeHtml(image)}">`;
  const contact = settings.contactEmail ? `<a href="mailto:${escapeHtml(settings.contactEmail)}">Contact Dodona</a>` : '';
  const identity = settings.operatorName ? `<p class="operator-line">Operated by ${escapeHtml(settings.operatorName)}.</p>` : '';
  const aboutContact = settings.contactEmail ? `<a class="text-link about-contact" href="mailto:${escapeHtml(settings.contactEmail)}">${escapeHtml(settings.contactEmail)}</a>` : '';
  return html.replaceAll('<!-- CANONICAL -->', canonical).replaceAll('<!-- SHARE_IMAGE -->', sharing)
    .replaceAll('<!-- CONTACT_LINK -->', contact).replaceAll('<!-- OPERATOR_LINE -->', identity)
    .replaceAll('<!-- ABOUT_CONTACT -->', aboutContact)
    .replaceAll('<!-- MCP_URL -->', escapeHtml(origin + '/mcp'))
    .replaceAll('<!-- STRUCTURED_DATA -->', `<script type="application/ld+json">${structuredData(settings, origin)}</script>`)
    .replaceAll('<!-- PRIVACY_BODY -->', privacyBody(settings));
}
