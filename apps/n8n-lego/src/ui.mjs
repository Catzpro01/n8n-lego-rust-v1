/**
 * Serves the stock n8n editor UI.
 *
 * The bundle is taken verbatim from the `n8n-editor-ui` package and templated
 * exactly like n8n's `start.ts` does at boot:
 *
 *   %CONFIG_TAGS%       -> <meta name="n8n:config:rest-endpoint"> + sentry config
 *   /{{BASE_PATH}}/     -> the configured base path (default "/")
 *   {{REST_ENDPOINT}}   -> <basePath>rest/
 *
 * Everything is cached in memory after the first request, so the 150 MB bundle is
 * only read (and rewritten) once per process. Only `.html`, `.js` and `.css`
 * files are rewritten — images, fonts and wasm are streamed untouched.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const TEMPLATED_EXTENSIONS = new Set(['.html', '.js', '.css']);

/**
 * Generic node glyph used when a requested icon is not in the extracted set —
 * n8n's editor asks for icons of community/langchain nodes it lists in templates.
 * Answering with an image (instead of 404) keeps the palette free of broken
 * images.
 */
const FALLBACK_ICON = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">` +
    `<rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="#eaeaea" stroke="#c3c3c3"/>` +
    `<circle cx="12" cy="12" r="3.2" fill="none" stroke="#909090" stroke-width="1.6"/>` +
    `</svg>`,
  'utf8',
);

export function createUi({ config, logger, frontend = null }) {
  const distDir = resolve(config.editorDist);
  const available = existsSync(join(distDir, 'index.html'));
  const cache = new Map();

  // The editor computes `restUrl = window.BASE_PATH + restEndpoint`, so the meta
  // tag carries the bare segment ('rest') — never a path or a full URL.
  const restEndpoint = config.restEndpoint;

  // Frontend LEGO (P2.5): additive boot descriptor — one `<meta>` tag, the same
  // JSON `GET /rest/frontend/bootstrap` answers. The stock bundle never reads it
  // and nothing else in the document changes; when the LEGO is unavailable the
  // tag is simply absent and the UI renders exactly as before.
  const bootMetaTag = typeof frontend?.metaTag === 'string' ? frontend.metaTag : '';

  const configTags = [
    `<meta name="n8n:config:rest-endpoint" content="${base64(restEndpoint)}">`,
    `<meta name="n8n:config:sentry" content="${base64(
      JSON.stringify({ dsn: '', environment: config.env, serverName: 'n8n-lego', release: `n8n-lego@${config.version}` }),
    )}">`,
  ].join('');

  if (!available) {
    logger.warn('editor UI bundle not found — run `npm install` in apps/n8n-lego', { editorDist: distDir });
  }

  function template(fileName, raw) {
    let out = raw;
    // n8n rewrites the placeholders in index.html, js and css only.
    out = out.split('/{{BASE_PATH}}/').join(config.basePath);
    out = out.split('/%7B%7BBASE_PATH%7D%7D/').join(config.basePath);
    out = out.split('/%257B%257BBASE_PATH%257D%257D/').join(config.basePath);
    out = out.split('%CONFIG_TAGS%').join(configTags);
    out = out.split('{{REST_ENDPOINT}}').join(restEndpoint);
    if (fileName.endsWith('index.html')) {
      out = out.replace('</title>', `</title><meta name="application-name" content="${config.appName}">${bootMetaTag}`);
      out = out.replace(/<title>.*?<\/title>/, `<title>${config.appName} — Workflow Automation</title>`);
    }
    return out;
  }

  /**
   * Serves node icons. `nodes.json` carries relative `iconUrl`s such as
   * `icons/n8n-nodes-base/dist/nodes/Code/code.svg`, which the editor resolves
   * against the server root; the files are extracted by
   * `scripts/fetch-n8n-catalog.mjs` into `<dataDir>/icons`.
   */
  const iconRoot = resolve(config.dataDir, 'icons');

  function serveIcon(res, pathname) {
    const relative = decodeURIComponent(pathname.replace(/^\/icons\//, ''));
    const filePath = resolve(join(iconRoot, relative));
    if (!filePath.startsWith(`${iconRoot}${sep}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(200, {
        'content-type': 'image/svg+xml',
        'cache-control': 'public, max-age=86400',
        'content-length': FALLBACK_ICON.length,
      });
      res.end(FALLBACK_ICON);
      return;
    }
    const ext = extname(filePath).toLowerCase();
    const stat = statSync(filePath);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=604800',
      'content-length': stat.size,
    });
    createReadStream(filePath).pipe(res);
  }

  function serveFile(res, filePath, { status = 200 } = {}) {
    const ext = extname(filePath).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    };

    if (!TEMPLATED_EXTENSIONS.has(ext)) {
      const stat = statSync(filePath);
      res.writeHead(status, { ...headers, 'content-length': stat.size });
      createReadStream(filePath).pipe(res);
      return;
    }

    const key = `${filePath}`;
    let body = cache.get(key);
    if (!body) {
      body = Buffer.from(template(filePath, readFileSync(filePath, 'utf8')), 'utf8');
      cache.set(key, body);
    }
    res.writeHead(status, { ...headers, 'content-length': body.length });
    res.end(body);
  }

  return {
    available,
    serveIcon,
    distDir,
    bootMetaTagPresent: bootMetaTag.length > 0,
    /** @param {string} pathname already stripped of the base path */
    serve(req, res, pathname) {
      if (!available) {
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>n8n lego</title>` +
            `<body style="font:15px/1.6 system-ui;max-width:44rem;margin:4rem auto;padding:0 1rem">` +
            `<h1>n8n lego</h1><p>The editor UI bundle is not installed yet.</p>` +
            `<pre style="background:#f4f4f5;padding:1rem;border-radius:8px">cd apps/n8n-lego &amp;&amp; npm install\nnpm run catalog</pre>` +
            `<p>Then reload this page. The REST API is already running: <a href="/rest/settings">/rest/settings</a>.</p></body>`,
        );
        return;
      }

      const relative = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '');
      const candidate = normalize(join(distDir, relative));
      const insideDist = candidate === distDir || candidate.startsWith(distDir + sep);

      if (insideDist && existsSync(candidate) && statSync(candidate).isFile()) {
        serveFile(res, candidate);
        return;
      }
      // SPA fallback: /workflow/:id, /home, /signin, … all render the shell.
      if (!relative.includes('.')) {
        serveFile(res, join(distDir, 'index.html'));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    },
  };
}

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}
