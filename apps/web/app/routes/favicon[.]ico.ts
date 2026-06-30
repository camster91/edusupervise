// apps/web/app/routes/favicon[.]ico.ts
//
// Tiny inline-SVG favicon served as /favicon.ico to silence the
// 404 in browser devtools. Returns an SVG with a simple "E" mark
// matching the EduSupervise accent color.
//
// Route name uses [.] escape so RR7's flat-routes parser treats
// "favicon.ico" as a single segment (the `.` in `favicon.ico`
// would otherwise be parsed as a path separator).

export function loader() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#3b82f6"/>
  <path d="M22 18h22v8H32v6h10v8H32v6h12v8H22z" fill="#fff"/>
</svg>`;
  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=86400',
    },
  });
}