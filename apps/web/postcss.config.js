// apps/web/postcss.config.js
//
// PostCSS config so Vite/RR7 processes Tailwind directives in CSS
// files. The `globals.css` import in root.tsx is what triggers the
// build pipeline.

export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
