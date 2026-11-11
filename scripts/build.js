// Builds Tailwind CSS, copies the Arabic font (Tajawal) and generates the icon set (Lucide).
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const root = path.join(__dirname, '..'), pub = path.join(root, 'public');
fs.mkdirSync(path.join(pub, 'fonts'), { recursive: true });
for (const w of [400, 500, 700, 800])
  fs.copyFileSync(path.join(root, `node_modules/@fontsource/tajawal/files/tajawal-arabic-${w}-normal.woff2`), path.join(pub, `fonts/tajawal-${w}.woff2`));

const ICONS = ['sticky-note', 'log-out', 'layout-grid', 'git-fork', 'archive', 'users', 'building-2', 'folder', 'folder-plus', 'plus', 'pencil', 'trash-2',
  'check', 'check-check', 'undo-2', 'clock', 'calendar-days', 'user', 'triangle-alert', 'flame', 'hourglass', 'monitor', 'globe', 'chevron-down', 'chevron-left',
  'chevron-right', 'search', 'filter', 'rotate-ccw', 'arrow-up-down', 'bell-ring', 'volume-2', 'repeat', 'alarm-clock', 'sparkles',
  'x', 'bell', 'list-checks', 'corner-down-left', 'inbox', 'shield-check', 'timer-off', 'rocket', 'leaf', 'zap', 'key-round'];
const map = {};
for (const n of ICONS) {
  const svg = fs.readFileSync(path.join(root, 'node_modules/lucide-static/icons', n + '.svg'), 'utf8');
  map[n] = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
}
fs.writeFileSync(path.join(pub, 'icons.js'), 'window.ICONS = ' + JSON.stringify(map) + ';\n');
execSync('npx tailwindcss -i src/input.css -o public/tailwind.css --minify', { cwd: root, stdio: 'inherit' });
