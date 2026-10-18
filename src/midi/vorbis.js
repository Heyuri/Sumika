// What spessasynth_core imports as `stb-vorbis` (tools/build.mjs aliases the bare name here, and the package itself to
// `stb-vorbis-impl`). The package compiles and instantiates its WebAssembly decoder (16 MiB of memory) as soon as its
// module runs, and the one MIDI bundle also runs in the AudioWorklet, which only ever gets SF2 (midi.md §5.2,
// §5.4). So the package is evaluated lazily and outside a worklet scope only: in the Worker (it decodes the SF3) and
// in Node. In a worklet `ready` is already resolved, and `decode` throws as the package's does before it is ready.

const WORKLET = typeof registerProcessor === 'function';

let impl = null;

export class StbVorbis {
  /** Resolves once the decoder can run (in a worklet: at once, with no decoder). */
  static ready = WORKLET
    ? Promise.resolve()
    : import('stb-vorbis-impl').then(m => {
      impl = m.StbVorbis;
      return impl.ready;
    });

  /**
   * @param {ArrayBuffer|Uint8Array} data one Ogg Vorbis stream
   * @returns {{sampleRate: number, channels: Float32Array[]}}
   */
  static decode(data) {
    if (!impl) throw new Error('Vorbis decoder not ready');
    return impl.decode(data);
  }
}
