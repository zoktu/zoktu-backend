import { Router } from 'express';
import Room from '../models/Room.js';
import { env } from '../config/env.js';

const router = Router();

const SITE_ORIGIN = (env && env.clientOrigin) ? String(env.clientOrigin).replace(/\/$/, '') : 'https://zoktu.com';

router.get('/sitemap.xml', async (req, res) => {
  try {
    // static pages
    const pages = [
      { loc: `${SITE_ORIGIN}/`, changefreq: 'hourly', priority: '1.0' },
      { loc: `${SITE_ORIGIN}/about`, changefreq: 'weekly', priority: '0.6' },
      { loc: `${SITE_ORIGIN}/privacy-policy`, changefreq: 'monthly', priority: '0.3' },
      { loc: `${SITE_ORIGIN}/terms-and-conditions`, changefreq: 'monthly', priority: '0.3' }
    ];

    // fetch recent active public rooms (not DMs)
    const roomDocs = await Room.find({ isActive: true, type: { $ne: 'dm' } })
      .select('_id updatedAt')
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean()
      .exec();

    const urls = pages.map(p => ({ ...p }));
    for (const r of (roomDocs || [])) {
      const id = String(r._id || r.id || r);
      const lastmod = r.updatedAt ? new Date(r.updatedAt).toISOString() : new Date().toISOString();
      urls.push({ loc: `${SITE_ORIGIN}/rooms/${encodeURIComponent(id)}`, lastmod, changefreq: 'daily', priority: '0.8' });
    }

    const xmlParts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    ];

    for (const u of urls) {
      xmlParts.push('  <url>');
      xmlParts.push(`    <loc>${u.loc}</loc>`);
      if (u.lastmod) xmlParts.push(`    <lastmod>${u.lastmod}</lastmod>`);
      if (u.changefreq) xmlParts.push(`    <changefreq>${u.changefreq}</changefreq>`);
      if (u.priority) xmlParts.push(`    <priority>${u.priority}</priority>`);
      xmlParts.push('  </url>');
    }

    xmlParts.push('</urlset>');
    const xml = xmlParts.join('\n');
    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (e) {
    res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  }
});

export default router;
