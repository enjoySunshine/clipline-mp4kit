import { createFile, type ISOFile, type Sample } from '../entries/all';
import { getFileRange, getFilePath, loadAndGetInfo } from './common';

/**
 * The conformance file `published/nalu/hevc/hvc1_only.mp4` is an HEVC track with
 * B-frames: samples are stored in decoding order but their composition times
 * (cts) are not monotonic. It has 257 samples, 11 sync samples and a media
 * timescale of 25000. The first samples, in decoding order, have cts values
 * 17000, 25000, 21000, 19000, 18000, 20000, 23000, 22000.
 */
const HEVC_GROUP = 'nalu';
const HEVC_FILE = 'hevc/hvc1_only.mp4';
const HEVC_TIMESCALE = 25000;
const SEEK_STEP = 0.07;
const SEEK_POINTS = 120;

async function loadHevcFile(loadAll: boolean): Promise<{ mp4: ISOFile; samples: Array<Sample> }> {
  const { testFile } = getFilePath(HEVC_GROUP, HEVC_FILE);
  if (loadAll) {
    const { mp4 } = await loadAndGetInfo(testFile, true, true);
    return { mp4, samples: mp4.moov.traks[0].samples };
  }
  const mp4 = createFile(false);
  const ready = new Promise<void>(resolve => {
    mp4.onReady = () => resolve();
  });
  await getFileRange(testFile, data => mp4.appendBuffer(data));
  mp4.flush();
  await ready;
  return { mp4, samples: mp4.moov.traks[0].samples };
}

/* Samples ordered by display (composition) time, which differs from the
   decoding order stored in trak.samples when B-frames are present. */
function displayOrder(samples: Array<Sample>): Array<Sample> {
  return [...samples].sort((a, b) => a.cts - b.cts || a.number - b.number);
}

/* For every sample, the closest sync sample that precedes it in decoding order.
   A decoder must start from this random access point to decode the sample. */
function decodeOrderRapTable(samples: Array<Sample>): Array<number> {
  const rap: Array<number> = [];
  let lastSync = 0;
  for (const sample of samples) {
    if (sample.is_sync) lastSync = sample.number;
    rap[sample.number] = lastSync;
  }
  return rap;
}

/* The sample whose display interval contains the given time: the last sample
   in display order with a cts not greater than the target media time. */
function expectedDisplaySample(samples: Array<Sample>, time: number): Sample {
  const timescale = samples[0].timescale;
  const target = time * timescale;
  let result = samples[0];
  for (const sample of displayOrder(samples)) {
    if (sample.cts <= target) result = sample;
    else break;
  }
  return result;
}

describe('Seek on HEVC content with B-frames', () => {
  it('exposes re-ordered composition times so the file actually uses B-frames', async () => {
    const { samples } = await loadHevcFile(true);

    expect(samples).toHaveLength(257);
    expect(samples[0].timescale).toBe(HEVC_TIMESCALE);
    expect(samples.filter(sample => sample.is_sync)).toHaveLength(11);
    // Decoding order cts are not monotonic: proof of B-frame re-ordering.
    expect(samples.slice(0, 8).map(sample => sample.cts)).toEqual([
      17000, 25000, 21000, 19000, 18000, 20000, 23000, 22000,
    ]);
    let nonMonotonic = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].cts < samples[i - 1].cts) nonMonotonic++;
    }
    expect(nonMonotonic).toBeGreaterThan(0);
  });

  it('locates the sample displayed at the seek time (useRap=false)', async () => {
    const { mp4, samples } = await loadHevcFile(true);
    const trak = mp4.moov.traks[0];
    const failures: Array<string> = [];

    for (let i = 0; i < SEEK_POINTS; i++) {
      const time = i * SEEK_STEP;
      const expected = expectedDisplaySample(samples, time);
      const result = mp4.seek(time, false);

      if (trak.nextSample !== expected.number) {
        failures.push(
          `t=${time.toFixed(2)}: got sample #${trak.nextSample} (cts ${samples[trak.nextSample].cts}), expected #${expected.number} (cts ${expected.cts})`,
        );
      }
      // The returned time must match the located sample's composition time.
      expect(result.time).toBe(expected.cts / HEVC_TIMESCALE);
    }

    expect(failures).toEqual([]);
  });

  it('moves to the decode-order sync sample required to decode the target (useRap=true)', async () => {
    const { mp4, samples } = await loadHevcFile(true);
    const trak = mp4.moov.traks[0];
    const decodeRap = decodeOrderRapTable(samples);
    const failures: Array<string> = [];

    for (let i = 0; i < SEEK_POINTS; i++) {
      const time = i * SEEK_STEP;
      const target = expectedDisplaySample(samples, time);
      const expectedRap = decodeRap[target.number];
      const result = mp4.seek(time, true);

      if (trak.nextSample !== expectedRap) {
        failures.push(
          `t=${time.toFixed(2)}: target #${target.number}, got RAP #${trak.nextSample}, expected #${expectedRap}`,
        );
      }
      expect(result.time).toBe(samples[expectedRap].cts / HEVC_TIMESCALE);
    }

    expect(failures).toEqual([]);
  });

  it('returns an offset that covers the whole decoding chain of the target frame', async () => {
    const { samples } = await loadHevcFile(true);
    const decodeRap = decodeOrderRapTable(samples);
    const target = expectedDisplaySample(samples, 0.77);
    const rapNumber = decodeRap[target.number];

    // Only buffer the moov plus a short prefix of mdat: the sync sample is
    // available but none of the frames between it and the target are.
    const prefixEnd = samples[rapNumber].offset + 256;
    const { testFile } = getFilePath(HEVC_GROUP, HEVC_FILE);
    const mp4 = createFile(false);
    const ready = new Promise<void>(resolve => {
      mp4.onReady = () => resolve();
    });
    await getFileRange(testFile, data => mp4.appendBuffer(data), 0, prefixEnd);
    await ready;

    const time = target.cts / HEVC_TIMESCALE;
    const rapResult = mp4.seek(time, true);

    // Downloading from this offset must not skip the sync sample the decoder
    // has to start from, otherwise the target frame cannot be decoded.
    expect(mp4.moov.traks[0].nextSample).toBe(rapNumber);
    expect(rapResult.offset).toBeLessThanOrEqual(samples[rapNumber].offset);

    // A plain seek still identifies the exact displayed sample and returns an
    // offset no later than that sample's data.
    const plainResult = mp4.seek(time, false);
    expect(mp4.moov.traks[0].nextSample).toBe(target.number);
    expect(plainResult.offset).toBeLessThanOrEqual(target.offset);
  });

  it('matches the documented B-frame repro case at 0.77s', async () => {
    const { mp4, samples } = await loadHevcFile(true);

    const plain = mp4.seek(0.77, false);
    expect(mp4.moov.traks[0].nextSample).toBe(3);
    expect(samples[3].cts).toBe(19000);
    expect(plain.time).toBe(19000 / HEVC_TIMESCALE);

    const rap = mp4.seek(0.77, true);
    expect(mp4.moov.traks[0].nextSample).toBe(0);
    expect(rap.time).toBe(samples[0].cts / HEVC_TIMESCALE);
    expect(rap.offset).toBeLessThanOrEqual(samples[0].offset);
  });
});

describe('Seek on re-ordered AVC content with negative composition offsets', () => {
  async function loadReorderedAvc() {
    const { testFile } = getFilePath('isobmff', '17_negative_ctso.mp4');
    const { mp4 } = await loadAndGetInfo(testFile, true, true);
    return { mp4, samples: mp4.moov.traks[0].samples };
  }

  it('still seeks by display time when cts is not monotonic in decoding order', async () => {
    const { mp4, samples } = await loadReorderedAvc();
    const trak = mp4.moov.traks[0];
    const timescale = samples[0].timescale;

    // Proof that this asset is also re-ordered (negative composition offsets).
    expect(samples.slice(0, 4).map(sample => sample.cts)).toEqual([0, 12, 8, 4]);

    const failures: Array<string> = [];
    for (let i = 0; i <= 60; i++) {
      const time = i * 0.1;
      const expected = expectedDisplaySample(samples, time);
      const result = mp4.seek(time, false);
      if (trak.nextSample !== expected.number) {
        failures.push(
          `t=${time.toFixed(1)}: got #${trak.nextSample}, expected #${expected.number}`,
        );
      }
      expect(result.time).toBe(expected.cts / timescale);
    }
    expect(failures).toEqual([]);
  });

  it('falls back to the single sync sample in decoding order when useRap=true', async () => {
    const { mp4, samples } = await loadReorderedAvc();
    const trak = mp4.moov.traks[0];
    expect(samples.filter(sample => sample.is_sync)).toHaveLength(1);

    for (const time of [0.4, 2.5, 10]) {
      const result = mp4.seek(time, true);
      expect(trak.nextSample).toBe(0);
      expect(result.time).toBe(samples[0].cts / samples[0].timescale);
    }
  });
});
