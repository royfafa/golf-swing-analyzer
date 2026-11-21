import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readVideoMeta } from '../js/mp4meta.js';

const load = (name) => new Blob([readFileSync(new URL(`./fixtures/${name}`, import.meta.url))]);

test('고정 60fps MP4', async () => {
  const m = await readVideoMeta(load('cfr60.mp4'));
  assert.ok(m);
  assert.ok(Math.abs(m.modeFps - 60) < 0.01, String(m.modeFps));
  assert.equal(m.isVFR, false);
  assert.equal(m.sampleCount, 60);
});

test('가변 프레임레이트(앞 240fps, 뒤 30fps) 감지', async () => {
  const m = await readVideoMeta(load('vfr.mp4'));
  assert.ok(m);
  assert.equal(m.isVFR, true);
  assert.ok(m.maxFps > 200 && m.minFps < 40, `${m.minFps}~${m.maxFps}`);
});

test('240fps MOV(moov 앞쪽 배치)', async () => {
  const m = await readVideoMeta(load('native240.mov'));
  assert.ok(m);
  assert.ok(Math.abs(m.modeFps - 240) < 0.01, String(m.modeFps));
});

test('MP4가 아니면 null', async () => {
  assert.equal(await readVideoMeta(new Blob([new Uint8Array(100)])), null);
});
