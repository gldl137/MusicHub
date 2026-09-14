/**
 * 生成 PWA maskable 图标（纯 Web 标准，依赖后端已安装的 sharp）
 *
 * maskable 规范要求：图标内容必须落在中心 80% 安全区内，
 * 外围 10% 留白/纯色填充，避免被 Android 自适应图标遮罩裁切。
 *
 * 运行：node app/backend/scripts/gen-maskable-icon.js
 * 输出：app/frontend/icons/icon-maskable-512.png
 */
const path = require('path');
const sharp = require('sharp');

const SRC = path.resolve(__dirname, '../../frontend/icons/icon-512.png');
const OUT = path.resolve(__dirname, '../../frontend/icons/icon-maskable-512.png');

const SIZE = 512;
const INNER = Math.round(SIZE * 0.8); // 409.6 -> 410，中心安全区

// 背景用 manifest 的 background_color（深灰），遮罩后图标落在深色圆/方内更协调
const BG = { r: 0x12, g: 0x12, b: 0x12, alpha: 1 };

(async () => {
  const inner = await sharp(SRC)
    .resize(INNER, INNER, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: BG }
  })
    .composite([{ input: inner, gravity: 'center' }])
    .png()
    .toFile(OUT);

  console.log('[ok] maskable icon generated ->', OUT);
})().catch((err) => {
  console.error('[fail]', err);
  process.exit(1);
});
