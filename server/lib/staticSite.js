/* Only publish the site's HTML pages and frontend assets. */
import express from 'express';
import path from 'path';

export function mountStaticSite(app, siteDir, uploadsDir) {
  app.use('/uploads', express.static(uploadsDir));
  app.use(['/css', '/js'], (req, res, next) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    next();
  });
  app.use('/css', express.static(path.join(siteDir, 'css'), { index: false, dotfiles: 'deny' }));
  app.use('/js', express.static(path.join(siteDir, 'js'), { index: false, dotfiles: 'deny' }));
  app.get(/^\/(?:[a-zA-Z0-9_-]+(?:\.html)?)?$/, (req, res, next) => {
    const page = req.path === '/' ? 'index.html' : req.path.slice(1);
    const filename = page.endsWith('.html') ? page : `${page}.html`;
    res.sendFile(filename, { root: siteDir, maxAge: 0, etag: false }, err => {
      if (err) next(err.status === 404 ? undefined : err);
    });
  });
}
