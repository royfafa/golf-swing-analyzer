// MP4/MOV 파일의 moov 박스만 읽어 영상 트랙의 정확한 프레임 정보를 얻는다.
// 브라우저 재생 콜백으로 fps를 재는 방식은 화면 주사율에 묶여 부정확하므로,
// 컨테이너에 기록된 샘플 수·시간표(stts)를 직접 읽어 평균 fps와 가변 프레임레이트(VFR) 여부를 판단한다.
// 파일 전체를 메모리에 올리지 않고 상위 박스 헤더와 moov 박스만 잘라 읽는다.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

/**
 * @param {Blob} file
 * @returns {Promise<null|{
 *   timescale:number, durationSec:number, sampleCount:number,
 *   avgFps:number, modeFps:number, minFps:number, maxFps:number,
 *   isVFR:boolean, sttsEntries:number, editCount:number, editRates:number[]
 * }>} MP4/MOV가 아니거나 해석에 실패하면 null
 */
export async function readVideoMeta(file) {
  try {
    const moov = await findTopLevelBox(file, 'moov');
    if (!moov) return null;
    const tracks = [];
    walk(moov, 8, moov.byteLength, [], tracks);
    const video = tracks.find((t) => t.handler === 'vide' && t.stts && t.timescale);
    if (!video) return null;
    return summarize(video);
  } catch {
    return null;
  }
}

/** 상위 박스를 헤더만 읽으며 건너뛰다가 원하는 박스를 통째로 읽는다. */
async function findTopLevelBox(file, wanted) {
  let offset = 0;
  for (let guard = 0; guard < 4096 && offset + 8 <= file.size; guard++) {
    const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = fourcc(head, 4);
    if (size === 1) {
      if (head.byteLength < 16) return null;
      size = Number(head.getBigUint64(8));
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < 8) return null;
    if (type === wanted) {
      // moov는 보통 수 MB 이하. 비정상적으로 크면 안전하게 포기한다.
      if (size > 64 * 1024 * 1024) return null;
      return new DataView(await file.slice(offset, offset + size).arrayBuffer());
    }
    offset += size;
  }
  return null;
}

function fourcc(dv, at) {
  return String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));
}

/** 박스 트리를 순회하며 트랙별 필요한 값만 모은다. */
function walk(dv, start, end, path, tracks) {
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = fourcc(dv, p + 4);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    const body = p + hdr;
    const bodyEnd = p + size;

    if (type === 'trak') tracks.push({ editRates: [] });
    const cur = tracks[tracks.length - 1];

    if (CONTAINERS.has(type)) {
      walk(dv, body, bodyEnd, [...path, type], tracks);
    } else if (cur && path.includes('trak')) {
      readLeaf(dv, type, body, bodyEnd, cur, path[path.length - 1]);
    }
    p += size;
  }
}

function readLeaf(dv, type, b, end, tr, parent) {
  const version = dv.getUint8(b);
  switch (type) {
    case 'hdlr':
      // MOV는 minf 안에도 데이터 참조용 hdlr(alis/url)이 있으므로 mdia 직속 hdlr만 본다
      if (parent === 'mdia') tr.handler = fourcc(dv, b + 8);
      break;
    case 'mdhd':
      if (version === 1) {
        tr.timescale = dv.getUint32(b + 20);
        tr.duration = Number(dv.getBigUint64(b + 24));
      } else {
        tr.timescale = dv.getUint32(b + 12);
        tr.duration = dv.getUint32(b + 16);
      }
      break;
    case 'stts': {
      const n = dv.getUint32(b + 4);
      const entries = [];
      for (let i = 0; i < n && b + 8 + i * 8 + 8 <= end; i++) {
        entries.push({ count: dv.getUint32(b + 8 + i * 8), delta: dv.getUint32(b + 12 + i * 8) });
      }
      tr.stts = entries;
      break;
    }
    case 'elst': {
      // 편집 목록: 슬로모션 파일은 구간별 재생 속도(media_rate)가 다르게 기록되기도 한다
      const n = dv.getUint32(b + 4);
      const entrySize = version === 1 ? 20 : 12;
      for (let i = 0; i < n; i++) {
        const e = b + 8 + i * entrySize;
        if (e + entrySize > end) break;
        const rateAt = e + (version === 1 ? 16 : 8);
        const rate = dv.getInt16(rateAt) + dv.getUint16(rateAt + 2) / 65536;
        tr.editRates.push(Math.round(rate * 1000) / 1000);
      }
      break;
    }
    default:
      break;
  }
}

function summarize(tr) {
  const { timescale, stts } = tr;
  let samples = 0, ticks = 0;
  for (const e of stts) { samples += e.count; ticks += e.count * e.delta; }
  // 마지막 프레임 하나만 길이가 다른 경우가 흔하므로, 2개 이상 연속된 항목만으로 VFR을 판단한다
  const runs = stts.filter((e) => e.count >= 2 && e.delta > 0);
  const basis = runs.length ? runs : stts.filter((e) => e.delta > 0);
  const deltas = basis.map((e) => e.delta);
  const minD = Math.min(...deltas), maxD = Math.max(...deltas);
  // 가장 많은 프레임이 쓰는 간격 = 대표 fps
  const byDelta = new Map();
  for (const e of basis) byDelta.set(e.delta, (byDelta.get(e.delta) || 0) + e.count);
  let modeDelta = minD, modeCount = -1;
  for (const [d, c] of byDelta) if (c > modeCount) { modeCount = c; modeDelta = d; }

  const durationSec = (tr.duration || ticks) / timescale;
  return {
    timescale,
    durationSec,
    sampleCount: samples,
    avgFps: ticks > 0 ? (samples * timescale) / ticks : 0,
    modeFps: timescale / modeDelta,
    minFps: timescale / maxD,
    maxFps: timescale / minD,
    isVFR: (maxD - minD) / minD > 0.15,
    sttsEntries: stts.length,
    editCount: tr.editRates.length,
    editRates: tr.editRates,
  };
}
