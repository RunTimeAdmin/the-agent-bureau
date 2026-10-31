import { readFile, writeFile } from 'node:fs/promises';
import { renderDocument, CASE_PAGES } from '../dist/prerender/prerender.js';
const origin = (process.env.PUBLIC_SITE_URL || 'https://theagentbureau.xyz').replace(/\/+$/, '');
const parsed = new URL(origin);
if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('PUBLIC_SITE_URL must be an HTTP(S) origin.');
const escape = value => value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const template = await readFile(new URL('../dist/public/index.html', import.meta.url), 'utf8');
for (const [pathname, filename] of [['/','index.html'],['/bureau','bureau.html'],['/review-log','review-log.html'],['/privacy','privacy.html'],['/terms','terms.html'],['/inbox','inbox.html'],...CASE_PAGES.map(page=>[page.path,page.file]),['/agents','agents.html'],['/404','404.html']]) {
  let {html} = renderDocument(template, pathname, origin);
  if (['/','/bureau','/review-log','/privacy','/terms','/agents',...CASE_PAGES.map(page=>page.path)].includes(pathname)) html=html.replace('</head>',`<link rel="canonical" href="${escape(origin+pathname)}" /><meta property="og:url" content="${escape(origin+pathname)}" /></head>`);
  await writeFile(new URL(`../dist/public/${filename}`, import.meta.url), html);
  console.log(`Prerendered ${pathname}`);
}
const urls=['/',...CASE_PAGES.map(page=>page.path),'/agents','/bureau','/review-log','/privacy','/terms'].map(path=>`<url><loc>${escape(origin+path)}</loc></url>`).join('');
await writeFile(new URL('../dist/public/sitemap.xml',import.meta.url),`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`);
await writeFile(new URL('../dist/public/robots.txt',import.meta.url),`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /inbox\nDisallow: /404\nSitemap: ${origin}/sitemap.xml\n`);
