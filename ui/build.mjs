import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'dist');
fs.mkdirSync(outDir, { recursive: true });

const iconPath = path.join(__dirname, '..', 'assets', 'artifacts-icon.jpg');
const iconDataUri = fs.existsSync(iconPath)
  ? `data:image/jpeg;base64,${fs.readFileSync(iconPath).toString('base64')}`
  : '';

const wrenchPath = path.join(__dirname, '..', 'assets', 'wrench.png');
const wrenchDataUri = fs.existsSync(wrenchPath)
  ? `data:image/png;base64,${fs.readFileSync(wrenchPath).toString('base64')}`
  : '';

const result = await esbuild.build({
  entryPoints: [path.join(__dirname, 'src', 'main.ts')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2022'],
  define: {
    __GAUNTLET_ICON__: JSON.stringify(iconDataUri),
    __WRENCH_ICON__: JSON.stringify(wrenchDataUri),
  },
  write: false,
});

const jsCode = result.outputFiles[0].text.replaceAll('</script>', '<\\/script>');
const template = fs.readFileSync(path.join(__dirname, 'src', 'template.html'), 'utf-8');
const html = template.replace('<!--__INLINE_SCRIPT__-->', () => `<script type="module">\n${jsCode}\n</script>`);

const outPath = path.join(outDir, 'app.html');
fs.writeFileSync(outPath, html, 'utf-8');
console.log(`Built ${outPath} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB)`);
