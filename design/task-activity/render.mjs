// Brand-native motion study. Reuses the actual Piora SVG, without changing the app.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const directory = import.meta.dirname;
const root = resolve(directory, '../..');
await mkdir(directory, { recursive: true });
const original = await readFile(join(root, 'desktop/build/piora-icon.svg'), 'utf8');
const brand = original.replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const paths = [
  ['M246 310C364 274 655 274 778 310', 536, 0],
  ['M363 326C362 507 337 680 256 789', 481, 0.23],
  ['M655 326C653 523 681 693 790 786', 489, 0.46],
];
const frameCount = 48, delay = 50, duration = frameCount * delay;
const mod = value => ((value % 1) + 1) % 1;

function icon(t, animated = false) {
  const turn = t * 360 - 90;
  const breathing = 1 + 0.015 * Math.sin(t * Math.PI * 2);
  const traces = paths.map(([d, length, phase], index) => {
    const offset = length * (1.15 - 2.3 * mod(t - phase));
    return `<path class="trace trace-${index}" d="${d}" fill="none" stroke="#eaffff" stroke-width="34" stroke-linecap="round" stroke-opacity=".78" stroke-dasharray="${length * .2} ${length * 2.4}" stroke-dashoffset="${animated ? length * 1.15 : offset}"/>`;
  }).join('');
  const animation = animated ? `<style>
    .orbit { transform-origin:64px 64px; animation:orbit 2.4s linear infinite; }
    .breath { transform-origin:512px 512px; animation:breath 2.4s ease-in-out infinite; }
    @keyframes orbit { from{transform:rotate(-90deg)} to{transform:rotate(270deg)} }
    @keyframes breath { 0%,100%{transform:scale(1)} 25%{transform:scale(1.015)} 75%{transform:scale(.985)} }
    ${paths.map(([, length, phase], index) => `.trace-${index}{animation:trace-${index} 2.4s linear infinite;animation-delay:${phase * 2.4}s} @keyframes trace-${index}{from{stroke-dashoffset:${length * 1.15}}to{stroke-dashoffset:${-length * 1.15}}}`).join('\n')}
    @media(prefers-reduced-motion:reduce){.orbit,.breath,.trace{animation:none}.trace{display:none}}
  </style>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Piora 凝思求解中">
    <title>Piora · 流光 π</title>${animation}
    <circle cx="64" cy="64" r="59" fill="none" stroke="#8273d6" stroke-opacity=".14" stroke-width="1.5"/>
    <svg x="14" y="14" width="100" height="100" viewBox="0 0 1024 1024" overflow="visible">
      <g ${animated ? 'class="breath"' : `transform="translate(512 512) scale(${breathing}) translate(-512 -512)"`}>${brand}${traces}</g>
    </svg>
    <g ${animated ? 'class="orbit"' : `transform="rotate(${turn} 64 64)"`}>
      ${Array.from({ length: 15 }, (_, n) => {
        const angle = -(15 - n) * 2.7 * Math.PI / 180;
        return `<circle cx="${64 + 59 * Math.cos(angle)}" cy="${64 + 59 * Math.sin(angle)}" r="${1.3 + n * .1}" fill="${n < 7 ? '#9a7bff' : '#63d8f3'}" opacity="${.07 + n * .035}"/>`;
      }).join('')}
      <circle cx="123" cy="64" r="5" fill="#66d8ef" opacity=".22"/>
      <circle cx="123" cy="64" r="3.3" fill="#55c9eb"/>
      <circle cx="122.3" cy="63.3" r="1.15" fill="#efffff"/>
    </g>
  </svg>`;
}

const width = 880, height = 420;
const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="880" height="420" fill="#f1f2f6"/>
  <g font-family="Microsoft YaHei UI, Microsoft YaHei, sans-serif">
    <text x="28" y="42" font-size="27" font-weight="600" fill="#222339">流光 π</text>
    <text x="28" y="67" font-size="13" fill="#72768a">Piora · 凝思求解中的品牌动效</text>
    <text x="852" y="43" text-anchor="end" font-size="12" fill="#72768a">2.4 秒循环 · 20 fps</text>
    <rect x="24" y="90" width="404" height="302" rx="20" fill="#ffffff" stroke="#e3e5ed"/>
    <rect x="452" y="90" width="404" height="302" rx="20" fill="#171922"/>
    <text x="44" y="120" font-size="12" fill="#8b8e9e">浅色界面</text>
    <text x="472" y="120" font-size="12" fill="#9b9eae">深色界面</text>
    <text x="226" y="270" text-anchor="middle" font-size="12" fill="#8b8e9e">放大动效</text>
    <text x="654" y="270" text-anchor="middle" font-size="12" fill="#9b9eae">放大动效</text>
    <rect x="44" y="306" width="364" height="60" rx="13" fill="#f6f7fb"/>
    <rect x="472" y="306" width="364" height="60" rx="13" fill="#232632"/>
    <text x="96" y="341" font-size="14" fill="#454b61">凝思求解中</text>
    <text x="524" y="341" font-size="14" fill="#dce0ed">凝思求解中</text>
    <text x="190" y="340" font-size="12" fill="#8b8e9e">· 已用时 2:34</text>
    <text x="618" y="340" font-size="12" fill="#9b9eae">· 已用时 2:34</text>
    <text x="388" y="340" text-anchor="end" font-size="12" fill="#527bc6">≈42.5 t/s</text>
    <text x="816" y="340" text-anchor="end" font-size="12" fill="#83b5fa">≈42.5 t/s</text>
    <text x="440" y="411" text-anchor="middle" font-size="11" fill="#8b8e9e">下方为 24px 状态栏尺寸预览 · 设计样稿</text>
  </g>
</svg>`;
const background = await sharp(Buffer.from(preview)).png().toBuffer();
const icons = [], tiny = [], previews = [];
console.log('Rendering 48 frames from the original Piora vector mark');
for (let frame = 0; frame < frameCount; frame++) {
  const svg = Buffer.from(icon(frame / frameCount));
  const png = await sharp(svg, { density: 144 }).resize(96, 96).png().toBuffer();
  const small = await sharp(png).resize(24, 24).png().toBuffer();
  icons.push(await sharp(png).ensureAlpha().raw().toBuffer());
  tiny.push(await sharp(small).ensureAlpha().raw().toBuffer());
  const composed = sharp(background).composite([
    { input: png, left: 178, top: 146 }, { input: png, left: 606, top: 146 },
    { input: small, left: 60, top: 324 }, { input: small, left: 488, top: 324 },
  ]);
  previews.push(await composed.ensureAlpha().raw().toBuffer());
  if (frame === 12) {
    await writeFile(join(directory, 'piora-thinking.png'), png);
    await sharp(previews.at(-1), { raw: { width, height, channels: 4 } }).png().toFile(join(directory, 'preview.png'));
  }
}
async function saveAnimation(name, frames, frameWidth, frameHeight, webp = false) {
  const image = sharp(Buffer.concat(frames), { raw: { width: frameWidth, height: frameHeight * frames.length, channels: 4, pageHeight: frameHeight }, limitInputPixels: false });
  const delays = Array(frames.length).fill(delay);
  await (webp ? image.webp({ lossless: true, effort: 3, loop: 0, delay: delays }) : image.gif({ effort: 3, colours: 256, dither: .15, loop: 0, delay: delays, keepDuplicateFrames: true })).toFile(join(directory, name));
  const metadata = await sharp(join(directory, name), { animated: true }).metadata();
  if (metadata.pages !== frameCount || metadata.loop !== 0 || metadata.delay.reduce((sum, ms) => sum + ms, 0) !== duration) throw new Error(`Invalid animation ${name}`);
  return { name, width: metadata.width, frameHeight: metadata.pageHeight, frames: metadata.pages, loop: metadata.loop, durationMs: duration, transparent: metadata.hasAlpha };
}
const outputs = [];
outputs.push(await saveAnimation('piora-thinking.gif', icons, 96, 96));
outputs.push(await saveAnimation('piora-thinking-24.gif', tiny, 24, 24));
outputs.push(await saveAnimation('piora-thinking.webp', icons, 96, 96, true));
outputs.push(await saveAnimation('preview.gif', previews, width, height));
await writeFile(join(directory, 'piora-thinking.svg'), icon(0, true));
await writeFile(join(directory, 'verification.json'), JSON.stringify({ source: 'desktop/build/piora-icon.svg', outputs }, null, 2));
console.log(JSON.stringify(outputs));
