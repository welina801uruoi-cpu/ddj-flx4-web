/**
 * Pioneer DJ DDJ-FLX4 Web Audio DSP Engine
 * Supports:
 * - True variable-rate & reverse Vinyl Scratching + Pitch Bend
 * - Sample-accurate Loops (IN/OUT, 4-Beat Auto Loop, 1/2X, 2X, Loop Roll)
 * - 8 Hot Cues, 8 Pad FX, 8 Beat Jumps, 8 Built-in DJ Sampler slots
 * - 3-Band Isolator EQ (HI / MID / LOW) + TRIM per channel
 * - Sound Color FX (Bi-directional LPF/HPF) + SMART CFX (Multi-FX Macro)
 * - SMART FADER (Auto BPM sync morph + Auto Bass Swap + Echo tail + Volume curve)
 * - Beat FX Unit (Echo, Delay, Reverb, Trans Gate, Flanger, Phaser, BitCrush)
 * - Split Cue (Master L / Cue R) + Microphone Talkover + Live Mix Recorder
 */

class DeckDSP {
  constructor(engine, deckId) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.deckId = deckId;

    // Track Metadata & AudioBuffer
    this.track = null;
    this.buffer = null;
    this.leftData = null;
    this.rightData = null;
    this.duration = 0;
    this.baseBpm = deckId === 1 ? 124.0 : 128.0;
    this.rgbPeaks = []; // Array of { low, mid, high } normalized 0..1

    // Transport & Playhead State
    this.isPlaying = false;
    this.endedNaturally = false;
    this.playheadSec = 0;
    this.cuePointSec = 0;
    this.isCuePreviewing = false;
    this.shiftPressed = false;

    // Tempo & Sync State
    this.vinylMode = true;
    this.keyLock = true;
    this.syncEnabled = false;
    this.tempoRange = 0.10; // ±10% default (0.06, 0.10, 0.16, 0.50)
    this.tempoSliderPos = 0; // -1 .. +1
    this.pitchBendOffset = 0; // temporary nudge
    this.smartFaderBpmOverride = null; // BPM target when Smart Fader is active

    // Jog Scratching State
    this.isScratching = false;
    this.scratchVelocity = 0; // 1.0 = normal forward speed, -1.0 = reverse
    this.platterAngle = 0;

    // Loop State
    this.loopActive = false;
    this.loopInSec = null;
    this.loopOutSec = null;
    this.loopLengthBeats = 4;

    // Pad Modes & 8 Hot Cues
    this.padMode = "hotcue"; // 'hotcue' | 'padfx' | 'beatjump' | 'sampler'
    this.hotCues = [null, null, null, null, null, null, null, null];

    // Active Pad FX state
    this.activePadFx = null; // 0..7 or null
    this.brakeFactor = 1.0;
    this.rollSavedSec = null;
    this.rollLoopLenSec = 0;

    // Master Tempo (Key-Lock Pitch-Preserving WSOLA Phase-Aligned Time-Stretcher)
    this.grainSize = 4410; // ~100ms Hann grain (at 44.1kHz) for uncolored vocals & deep bass coherence
    this.hannWindow = new Float32Array(this.grainSize);
    for (let i = 0; i < this.grainSize; i++) {
      this.hannWindow[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / this.grainSize));
    }
    this.grainPhase = 0;
    this.grainPosA = 0;
    this.grainPosB = 0;
    this._wasUsingKeyLock = false;

    // Auto-Gain / Loudness Normalization & Jog Display Mode
    this.autoGainTrim = 1.0;
    this.userTrimDb = 0;
    this.jogLcdMode = "bpm"; // 'bpm' | 'remain' | 'bar' | 'loop'

    // Build Web Audio Signal Chain
    this._buildAudioChain();
  }

  _buildAudioChain() {
    const ctx = this.ctx;

    // 1. Variable-rate Stereo Buffer Reader (ScriptProcessor for true scratch/reverse/loop)
    this.scriptNode = ctx.createScriptProcessor(1024, 0, 2);
    this.scriptNode.onaudioprocess = (e) => this._processAudioBlock(e);

    // 2. TRIM (Gain)
    this.trimNode = ctx.createGain();
    this.trimNode.gain.value = 1.0;

    // 3. 3-Band Isolator EQ (LOW / MID / HI)
    this.lowEq = ctx.createBiquadFilter();
    this.lowEq.type = "lowshelf";
    this.lowEq.frequency.value = 250;
    this.lowEq.gain.value = 0;

    this.midEq = ctx.createBiquadFilter();
    this.midEq.type = "peaking";
    this.midEq.frequency.value = 1000;
    this.midEq.Q.value = 0.85;
    this.midEq.gain.value = 0;

    this.highEq = ctx.createBiquadFilter();
    this.highEq.type = "highshelf";
    this.highEq.frequency.value = 4000;
    this.highEq.gain.value = 0;

    // 4. Smart Fader Automatic Bass-Swap Filter
    this.smartBassFilter = ctx.createBiquadFilter();
    this.smartBassFilter.type = "lowshelf";
    this.smartBassFilter.frequency.value = 260;
    this.smartBassFilter.gain.value = 0;

    // 5. Sound Color FX (CFX) Click-Free Dual Cascaded Filters (LPF + HPF without live .type switching!)
    this.cfxLpFilter = ctx.createBiquadFilter();
    this.cfxLpFilter.type = "lowpass";
    this.cfxLpFilter.frequency.value = 20000;
    this.cfxLpFilter.Q.value = 0.707;

    this.cfxHpFilter = ctx.createBiquadFilter();
    this.cfxHpFilter.type = "highpass";
    this.cfxHpFilter.frequency.value = 20;
    this.cfxHpFilter.Q.value = 0.707;
    this.cfxFilter = this.cfxLpFilter;

    this.cfxDryGain = ctx.createGain();
    this.cfxDryGain.gain.value = 1.0;

    this.cfxWetGain = ctx.createGain();
    this.cfxWetGain.gain.value = 0.0;

    this.cfxDelay = ctx.createDelay(2.0);
    this.cfxDelay.delayTime.value = 0.24;
    this.cfxFeedback = ctx.createGain();
    this.cfxFeedback.gain.value = 0.35;
    this.cfxDelay.connect(this.cfxFeedback);
    this.cfxFeedback.connect(this.cfxDelay);

    // 6. Pad FX Filter & Flanger/Echo insert
    this.padFxFilter = ctx.createBiquadFilter();
    this.padFxFilter.type = "allpass";
    this.padFxFilter.frequency.value = 1000;

    // 6B. Nicky Romero EDM Remix Mode: Low-End Cleanup HPF + 4-on-the-Floor Sidechain Pump Gain
    this.edmCleanHpFilter = ctx.createBiquadFilter();
    this.edmCleanHpFilter.type = "highpass";
    this.edmCleanHpFilter.frequency.value = 20;
    this.edmCleanHpFilter.Q.value = 0.707;

    this.edmSidechainGain = ctx.createGain();
    this.edmSidechainGain.gain.value = 1.0;
    this.rootFreq = 55.0; // Default A1 (55 Hz), auto-detected per track

    // 7. Channel Analyser (for 5-LED VU Meter)
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);

    // 8. Channel Volume Fader & Crossfader Gain
    this.chFaderGain = ctx.createGain();
    this.chFaderGain.gain.value = 0.9;

    this.xfaderGain = ctx.createGain();
    this.xfaderGain.gain.value = 1.0;

    // 9. Headphone Cue Tap
    this.cueTapGain = ctx.createGain();
    this.cueTapGain.gain.value = 0.0; // toggled by Headphone CUE button

    // 10. Pioneer DJM Per-Channel Post-Fader Echo-Freeze & Spatial Wash Bus
    // (Allows David Guetta Echo-Out Fader Slams & MITOMI TOKOTO ageHa Filter-Echo Pulls without muddying the incoming deck!)
    this.echoSendGain = ctx.createGain();
    this.echoSendGain.gain.value = 0.0;

    this.echoToneFilter = ctx.createBiquadFilter();
    this.echoToneFilter.type = "bandpass";
    this.echoToneFilter.frequency.value = 1050;
    this.echoToneFilter.Q.value = 0.65;

    this.echoDelayL = ctx.createDelay(2.5);
    this.echoDelayL.delayTime.value = 0.35;
    this.echoDelayR = ctx.createDelay(2.5);
    this.echoDelayR.delayTime.value = 0.36;

    this.echoFeedbackGain = ctx.createGain();
    this.echoFeedbackGain.gain.value = 0.68;

    this.echoReturnMerger = ctx.createChannelMerger(2);
    this.echoReturnGain = ctx.createGain();
    this.echoReturnGain.gain.value = 0.0;

    // Connect chain
    this.scriptNode.connect(this.trimNode);
    this.trimNode.connect(this.lowEq);
    this.lowEq.connect(this.midEq);
    this.midEq.connect(this.highEq);
    this.highEq.connect(this.smartBassFilter);
    this.smartBassFilter.connect(this.cfxLpFilter);
    this.cfxLpFilter.connect(this.cfxHpFilter);

    // CFX Dry + Smart CFX Wet parallel
    this.cfxHpFilter.connect(this.cfxDryGain);
    this.cfxHpFilter.connect(this.cfxDelay);
    this.cfxDelay.connect(this.cfxWetGain);

    this.cfxDryGain.connect(this.padFxFilter);
    this.cfxWetGain.connect(this.padFxFilter);

    this.padFxFilter.connect(this.edmCleanHpFilter);
    this.edmCleanHpFilter.connect(this.edmSidechainGain);
    this.edmSidechainGain.connect(this.analyser);
    this.analyser.connect(this.chFaderGain);
    this.analyser.connect(this.cueTapGain);
    this.chFaderGain.connect(this.xfaderGain);

    // Post-EQ / Post-CFX, Pre-Channel-Fader Send -> Stereo Warm Echo Freeze Tail
    this.edmSidechainGain.connect(this.echoSendGain);
    this.echoSendGain.connect(this.echoToneFilter);
    this.echoToneFilter.connect(this.echoDelayL);
    this.echoToneFilter.connect(this.echoDelayR);
    this.echoDelayL.connect(this.echoFeedbackGain);
    this.echoFeedbackGain.connect(this.echoToneFilter);
    this.echoDelayL.connect(this.echoReturnMerger, 0, 0);
    this.echoDelayR.connect(this.echoReturnMerger, 0, 1);
    this.echoReturnMerger.connect(this.echoReturnGain);
  }

  setEchoSend(sendLevel, delaySec = 0.35, feedback = 0.68) {
    const now = this.ctx.currentTime;
    const clampedDelay = Math.max(0.06, Math.min(2.2, delaySec));
    this.echoDelayL.delayTime.setTargetAtTime(clampedDelay, now, 0.02);
    this.echoDelayR.delayTime.setTargetAtTime(Math.min(2.4, clampedDelay * 1.028), now, 0.02);
    this.echoFeedbackGain.gain.setTargetAtTime(Math.max(0.1, Math.min(0.84, feedback)), now, 0.02);
    this.echoReturnGain.gain.setTargetAtTime(sendLevel > 0.005 ? 0.86 : 0.0, now, 0.03);
    this.echoSendGain.gain.setTargetAtTime(Math.max(0, Math.min(1.0, sendLevel)), now, 0.025);
  }

  freezeEchoTail(feedback = 0.78) {
    const now = this.ctx.currentTime;
    // Close dry input into echo while letting the warm stereo feedback tail ring out over the drop!
    this.echoSendGain.gain.setTargetAtTime(0.0, now, 0.015);
    this.echoFeedbackGain.gain.setTargetAtTime(Math.max(0.2, Math.min(0.86, feedback)), now, 0.02);
    this.echoReturnGain.gain.setTargetAtTime(0.92, now, 0.02);
  }

  killEchoTail() {
    const now = this.ctx.currentTime;
    this.echoSendGain.gain.setTargetAtTime(0.0, now, 0.015);
    this.echoFeedbackGain.gain.setTargetAtTime(0.2, now, 0.02);
    this.echoReturnGain.gain.setTargetAtTime(0.0, now, 0.03);
  }

  triggerSidechainPump(beatSec = 0.46875, depth = 0.72) {
    const now = this.ctx.currentTime;
    const g = this.edmSidechainGain.gain;
    const minGain = Math.max(0.15, 1.0 - depth);
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    // Fast 12ms duck on the kick transient, then smooth exponential Nicky Romero sidechain swell!
    g.linearRampToValueAtTime(minGain, now + 0.012);
    g.exponentialRampToValueAtTime(1.06, now + beatSec * 0.78);
    g.linearRampToValueAtTime(1.0, now + beatSec * 0.98);
  }

  setEdmRemixMode(enabled, cleanMode = false) {
    const now = this.ctx.currentTime;
    // In cleanMode (Pad 5-8 FX OFF), preserve the original song's natural warm bass (only trim <48Hz rumble)
    const hpHz = !enabled ? 20 : cleanMode ? 48 : 115;
    this.edmCleanHpFilter.frequency.setTargetAtTime(hpHz, now, 0.05);
    if (!enabled) {
      this.edmSidechainGain.gain.cancelScheduledValues(now);
      this.edmSidechainGain.gain.setTargetAtTime(1.0, now, 0.04);
    }
  }

  getCurrentBpm() {
    if (this.smartFaderBpmOverride !== null) {
      return this.smartFaderBpmOverride;
    }
    const rate = 1.0 + this.tempoSliderPos * this.tempoRange + this.pitchBendOffset;
    return Math.max(40, this.baseBpm * rate);
  }

  getEffectivePlaybackRate() {
    if (this.isScratching && this.vinylMode) {
      return this.scratchVelocity;
    }
    if (!this.isPlaying && !this.isCuePreviewing) {
      return 0;
    }
    // Pad FX 7: Vinyl Brake deceleration
    if (this.activePadFx === 6) {
      this.brakeFactor = Math.max(0, this.brakeFactor - 0.012);
    } else {
      this.brakeFactor = Math.min(1.0, this.brakeFactor + 0.05);
    }

    let baseRate = 1.0 + this.tempoSliderPos * this.tempoRange + this.pitchBendOffset;
    if (this.smartFaderBpmOverride !== null && this.baseBpm > 0) {
      baseRate = this.smartFaderBpmOverride / this.baseBpm + this.pitchBendOffset;
    }
    return baseRate * this.brakeFactor;
  }

  cycleJogLcdMode() {
    const modes = ["bpm", "remain", "bar", "loop"];
    const idx = modes.indexOf(this.jogLcdMode);
    this.jogLcdMode = modes[(idx + 1) % modes.length];
    return this.jogLcdMode;
  }

  _alignGrainPhaseWsola(targetPos, refPos, left, totalSamples, rate = 1.0) {
    // Dynamic WSOLA search window tailored to current tempo stretch drift
    const drift = Math.ceil(Math.abs(rate - 1.0) * (this.grainSize >> 1));
    const maxOff = Math.max(480, Math.min(1080, drift + 240));
    const refBase = Math.min(totalSamples - 160, Math.max(0, refPos | 0));
    const center = Math.min(totalSamples - (maxOff + 160), Math.max(maxOff, targetPos | 0));
    let bestOffset = 0;
    let bestCorr = -Infinity;

    // Coarse search (step 6)
    for (let off = -maxOff; off <= maxOff; off += 6) {
      const cand = center + off;
      let corr = 0;
      for (let k = 0; k < 120; k += 4) {
        corr += left[refBase + k] * left[cand + k];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestOffset = off;
      }
    }

    // Fine search (step 1 around best coarse peak)
    const fineStart = Math.max(-maxOff, bestOffset - 6);
    const fineEnd = Math.min(maxOff, bestOffset + 6);
    for (let off = fineStart; off <= fineEnd; off += 1) {
      const cand = center + off;
      let corr = 0;
      for (let k = 0; k < 120; k += 4) {
        corr += left[refBase + k] * left[cand + k];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestOffset = off;
      }
    }
    return Math.max(0, Math.min(totalSamples - 4, center + bestOffset));
  }

  _processAudioBlock(event) {
    if (this.deckId === 1 && typeof this.engine._onAudioProcessTick === "function") {
      this.engine._onAudioProcessTick();
    }

    const outL = event.outputBuffer.getChannelData(0);
    const outR = event.outputBuffer.getChannelData(1);
    const len = outL.length;

    if (!this.buffer || !this.leftData) {
      outL.fill(0);
      outR.fill(0);
      return;
    }

    const sr = this.buffer.sampleRate;
    const left = this.leftData;
    const right = this.rightData || left;
    const totalSamples = left.length;
    const rate = this.getEffectivePlaybackRate();
    const INV_PCM16 = 0.000030517578125; // 1.0 / 32768.0 (CD-grade 16-bit PCM -> Float32)

    if (Math.abs(rate) < 0.0001) {
      outL.fill(0);
      outR.fill(0);
      return;
    }

    let pos = this.playheadSec * sr;

    // Determine active loop boundaries (either normal loop or Pad FX Beat Roll)
    let loopStartSample = -1;
    let loopEndSample = -1;
    if (this.rollSavedSec !== null && this.rollLoopLenSec > 0) {
      loopStartSample = this.rollSavedSec * sr;
      loopEndSample = (this.rollSavedSec + this.rollLoopLenSec) * sr;
    } else if (this.loopActive && this.loopInSec !== null && this.loopOutSec !== null && this.loopOutSec > this.loopInSec) {
      loopStartSample = this.loopInSec * sr;
      loopEndSample = this.loopOutSec * sr;
    }

    const useKeyLock = this.keyLock && !this.isScratching && rate > 0.25 && Math.abs(rate - 1.0) > 0.004;
    const gSize = this.grainSize;
    const halfG = gSize >> 1;
    const win = this.hannWindow;

    if (useKeyLock && !this._wasUsingKeyLock) {
      // Smoothly seed both grains to current playhead so entering Master Tempo never jumps or plays stale samples!
      this.grainPhase = 0;
      this.grainPosA = pos;
      this.grainPosB = pos;
      this._wasUsingKeyLock = true;
    } else if (!useKeyLock) {
      this._wasUsingKeyLock = false;
    }

    for (let i = 0; i < len; i++) {
      // Loop wrap
      if (loopStartSample >= 0 && loopEndSample > loopStartSample) {
        if (pos >= loopEndSample) {
          pos = loopStartSample + ((pos - loopStartSample) % (loopEndSample - loopStartSample));
          this.grainPosA = pos;
          this.grainPosB = pos;
        } else if (pos < loopStartSample && rate < 0) {
          pos = loopEndSample - 1;
        }
      }

      if (pos >= totalSamples - 2) {
        outL[i] = 0;
        outR[i] = 0;
        if (this.isPlaying) {
          this.endedNaturally = true;
        }
        this.isPlaying = false;
        pos = totalSamples - 2;
      } else if (pos < 0) {
        outL[i] = 0;
        outR[i] = 0;
        pos = 0;
      } else if (useKeyLock) {
        // Pioneer MASTER TEMPO: WSOLA Phase-Locked Dual-Grain Overlap-Add (zero comb-filtering, 100% original vocal pitch!)
        const pA = this.grainPhase;
        const pB = (pA + halfG) % gSize;
        if (pA === 0) {
          this.grainPosA = this._alignGrainPhaseWsola(pos, this.grainPosB, left, totalSamples, rate);
        }
        if (pB === 0) {
          this.grainPosB = this._alignGrainPhaseWsola(pos, this.grainPosA, left, totalSamples, rate);
        }

        const wA = win[pA];
        const wB = win[pB];

        const idxA = Math.min(totalSamples - 2, Math.max(0, this.grainPosA | 0));
        const fracA = Math.max(0, this.grainPosA - idxA);
        const sLA = left[idxA] + fracA * (left[idxA + 1] - left[idxA]);
        const sRA = right[idxA] + fracA * (right[idxA + 1] - right[idxA]);

        const idxB = Math.min(totalSamples - 2, Math.max(0, this.grainPosB | 0));
        const fracB = Math.max(0, this.grainPosB - idxB);
        const sLB = left[idxB] + fracB * (left[idxB + 1] - left[idxB]);
        const sRB = right[idxB] + fracB * (right[idxB + 1] - right[idxB]);

        outL[i] = (sLA * wA + sLB * wB) * INV_PCM16;
        outR[i] = (sRA * wA + sRB * wB) * INV_PCM16;

        // Pitch assist for extreme tempo stretches (> ±8%) to eliminate vocal tremolo & phasing
        const grainStep = Math.abs(rate - 1.0) > 0.08
          ? 1.0 + (rate - 1.0) * 0.16
          : 1.0;
        this.grainPosA += grainStep;
        this.grainPosB += grainStep;
        this.grainPhase = (pA + 1) % gSize;
        pos += rate;           // Beatgrid advances at target BPM rate!
      } else {
        const idx = pos | 0;
        const frac = pos - idx;
        outL[i] = (left[idx] + frac * (left[idx + 1] - left[idx])) * INV_PCM16;
        outR[i] = (right[idx] + frac * (right[idx + 1] - right[idx])) * INV_PCM16;
        pos += rate;
        this.grainPosA = pos;
        this.grainPosB = pos;
      }
    }

    this.playheadSec = pos / sr;
    // Advance platter rotation angle (33.3 RPM = 200 deg/sec)
    const blockSec = len / sr;
    this.platterAngle = (this.platterAngle + rate * blockSec * 200) % 360;
  }

  unloadTrack() {
    this.isPlaying = false;
    this.endedNaturally = false;
    this.buffer = null;
    this.leftData = null;
    this.rightData = null;
    this.duration = 0;
    this.track = null;
    this.baseBpm = 128.0;
    this.playheadSec = 0;
    this.cuePointSec = 0;
    this.rgbPeaks = [];
    this.loopActive = false;
    this.loopInSec = null;
    this.loopOutSec = null;
  }

  loadAudioBuffer(audioBuffer, trackMeta) {
    // Release any previous PCM arrays on this deck first
    this.isPlaying = false;
    this.endedNaturally = false;
    this.buffer = null;
    this.leftData = null;
    this.rightData = null;

    const sr = audioBuffer.sampleRate || this.ctx.sampleRate || 44100;
    const isIOS =
      typeof navigator !== "undefined" &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

    const srcL = audioBuffer.getChannelData(0);
    const hasStereo = audioBuffer.numberOfChannels > 1;
    const srcR = hasStereo ? audioBuffer.getChannelData(1) : srcL;

    // Protect iOS WebKit from multi-hour DJ mix files exceeding Jetsam limits (cap at 15 min on iOS, 45 min desktop)
    const maxSec = isIOS ? 900 : 2700;
    const numSamples = Math.min(srcL.length, Math.floor(sr * maxSec));
    this.duration = numSamples / sr;
    this.track = trackMeta;

    // Compute or reuse cached scalar analysis metadata (saves CPU & avoids re-scanning on repeat)
    const rawBpm = Number(trackMeta.bpm) || this._estimateBpmFromBuffer(audioBuffer);
    this.baseBpm = this._clampNaturalBpm(rawBpm);
    this.track.bpm = this.baseBpm;
    this.track.duration = this.duration;
    this.tempoRange = 0.08;
    this.tempoSliderPos = 0; // Start at 100% original tempo (+0.0%)

    this.playheadSec = 0;
    this.cuePointSec = 0;
    this.loopActive = false;
    this.loopInSec = null;
    this.loopOutSec = null;

    if (typeof trackMeta.firstBeatSec === "number" && typeof trackMeta.phraseCueSec === "number") {
      this.firstBeatSec = trackMeta.firstBeatSec;
      this.phraseCueSec = trackMeta.phraseCueSec;
      this.phraseBreaks = trackMeta.phraseBreaks || [];
    } else {
      const gridInfo = this._detectFirstBeatAndPhraseCue(audioBuffer, this.baseBpm);
      this.firstBeatSec = gridInfo.firstBeatSec;
      this.phraseCueSec = gridInfo.phraseCueSec;
      this.phraseBreaks = gridInfo.phraseBreaks || [];
      trackMeta.firstBeatSec = this.firstBeatSec;
      trackMeta.phraseCueSec = this.phraseCueSec;
      trackMeta.phraseBreaks = this.phraseBreaks;
    }
    this.cuePointSec = this.phraseCueSec;

    if (Number(trackMeta.rootFreq) > 0) {
      this.rootFreq = Number(trackMeta.rootFreq);
    } else {
      this.rootFreq = this._detectTrackRootFreq(audioBuffer);
      trackMeta.rootFreq = this.rootFreq;
    }

    this.rgbPeaks = this._computeRgbWaveformPeaks(audioBuffer, 600);

    if (typeof trackMeta.chorusEndSec === "number" && trackMeta.chorusEndSec > 0) {
      this.chorusStartSec = trackMeta.chorusStartSec || this.phraseCueSec;
      this.chorusEndSec = trackMeta.chorusEndSec;
    } else {
      const chorusInfo = this._detectChorusWindow(
        this.duration,
        this.rgbPeaks,
        this.firstBeatSec,
        this.phraseCueSec,
        this.baseBpm
      );
      this.chorusStartSec = chorusInfo.chorusStartSec;
      this.chorusEndSec = chorusInfo.chorusEndSec;
      trackMeta.chorusStartSec = this.chorusStartSec;
      trackMeta.chorusEndSec = this.chorusEndSec;
    }

    // Auto-Gain (Loudness Normalization): Measure integrated RMS across track
    let sumSq = 0;
    let sampleCnt = 0;
    const rmsStep = 16;
    for (let i = 0; i < numSamples; i += rmsStep) {
      const v = srcL[i];
      sumSq += v * v;
      sampleCnt++;
    }
    const measuredRms = Math.sqrt(sumSq / Math.max(1, sampleCnt));
    const targetRms = 0.175; // Standard dancefloor master target (~ -15 dBFS integrated)
    this.autoGainTrim = measuredRms > 0.01
      ? Math.max(0.65, Math.min(1.35, targetRms / measuredRms))
      : 1.0;
    this.userTrimDb = 0;
    this.trimNode.gain.value = this.autoGainTrim;

    // Pack into compact 16-bit PCM TypedArrays (cuts RAM by >75% on iOS WebKit and allows native AudioBuffer to be freed immediately!)
    const left16 = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const s = srcL[i];
      left16[i] = s >= 1.0 ? 32767 : s <= -1.0 ? -32768 : (s * 32767.0) | 0;
    }
    let right16 = left16;
    if (hasStereo) {
      right16 = new Int16Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        const s = srcR[i];
        right16[i] = s >= 1.0 ? 32767 : s <= -1.0 ? -32768 : (s * 32767.0) | 0;
      }
    }

    this.leftData = left16;
    this.rightData = right16;
    // Store lightweight descriptor instead of retaining native C++ AudioBuffer!
    this.buffer = { sampleRate: sr, duration: this.duration, length: numSamples };

    this.hotCues = [null, null, null, null, null, null, null, null];
    const beatSec = 60.0 / this.baseBpm;
    this.hotCues[0] = this.phraseCueSec;
    if (this.chorusStartSec > this.phraseCueSec + 4 && this.chorusStartSec < this.duration - 4) {
      this.hotCues[1] = this.chorusStartSec;
    } else if (this.duration > this.phraseCueSec + beatSec * 32) {
      this.hotCues[1] = this.phraseCueSec + beatSec * 32;
    }
    if (this.chorusEndSec > (this.hotCues[1] || 0) + 4 && this.chorusEndSec < this.duration - 4) {
      this.hotCues[2] = this.chorusEndSec;
    } else if (this.duration > this.phraseCueSec + beatSec * 64) {
      this.hotCues[2] = this.phraseCueSec + beatSec * 64;
    }
    // HOT CUE 4: Amusement Break Point / Speech End Cue for Clean Phrase Transition
    if (this.phraseBreaks && this.phraseBreaks.length > 0) {
      this.hotCues[3] = this.phraseBreaks[0];
    } else if (this.duration > this.phraseCueSec + beatSec * 96) {
      this.hotCues[3] = this.phraseCueSec + beatSec * 96;
    }
  }

  // Musical Phrase & Bar/Beat Positioning Helper (for Phrase Sync & Bar Counts)
  getBarAndBeat(sec = null) {
    const t = sec !== null ? sec : this.playheadSec;
    const bpm = this.getCurrentBpm() || this.baseBpm || 120.0;
    const beatSec = 60.0 / bpm;
    const barSec = beatSec * 4.0;
    const firstBeat = this.firstBeatSec || 0;
    const elapsed = Math.max(0, t - firstBeat);
    const barIndex = Math.floor(elapsed / barSec);
    const beatInBar = Math.floor((elapsed % barSec) / beatSec) + 1;
    const subBeat = (elapsed % beatSec) / beatSec;
    return {
      barIndex,
      barNumber: barIndex + 1,
      beatInBar,
      subBeat,
      displayStr: `${barIndex + 1}.${beatInBar}`,
      beatSec,
      barSec,
      firstBeatSec: firstBeat
    };
  }

  getNextPhraseDownbeat(sec = null, barBlock = 16) {
    const t = sec !== null ? sec : this.playheadSec;
    const bpm = this.getCurrentBpm() || this.baseBpm || 120.0;
    const beatSec = 60.0 / bpm;
    const barSec = beatSec * 4.0;
    const firstBeat = this.firstBeatSec || 0;
    const elapsed = Math.max(0, t - firstBeat);
    const currentBar = elapsed / barSec;
    const nextPhraseBar = Math.max(1, Math.ceil(currentBar / barBlock)) * barBlock;
    return firstBeat + nextPhraseBar * barSec;
  }

  _detectFirstBeatAndPhraseCue(buffer, bpm) {
    try {
      const data = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      const beatSec = 60.0 / (bpm || 128.0);
      const barSec = beatSec * 4.0;
      const hop = Math.max(1, Math.floor(sr / 200)); // 5ms resolution (200 Hz)
      const maxSec = Math.min(buffer.duration, 45.0);
      const numFrames = Math.floor((maxSec * sr) / hop);
      if (numFrames < 100) return { firstBeatSec: 0, phraseCueSec: 0 };

      // Low-pass proxy for kick/bass transients + full-band RMS so quiet piano/vocal intros are never skipped!
      const lowEnv = new Float32Array(numFrames);
      const fullEnv = new Float32Array(numFrames);
      let lp = 0;
      for (let i = 0; i < numFrames; i++) {
        const base = i * hop;
        let sumLow = 0;
        let sumFull = 0;
        for (let j = 0; j < hop; j += 4) {
          const s = data[base + j] || 0;
          lp = lp * 0.92 + s * 0.08;
          sumLow += lp * lp;
          sumFull += s * s;
        }
        const denom = Math.max(1, hop / 4);
        lowEnv[i] = Math.sqrt(sumLow / denom);
        fullEnv[i] = Math.sqrt(sumFull / denom);
      }

      // Find best sub-beat phase offset (0 .. beatSec) where kicks land strongest
      const beatFrames = Math.max(10, Math.round((beatSec * sr) / hop));
      let bestPhaseFrame = 0;
      let bestPhaseScore = -1;
      for (let p = 0; p < beatFrames; p++) {
        let score = 0;
        for (let f = p; f < numFrames - 1; f += beatFrames) {
          const onset = Math.max(0, lowEnv[f] - (f > 0 ? lowEnv[f - 1] : 0));
          score += onset + lowEnv[f] * 0.25;
        }
        if (score > bestPhaseScore) {
          bestPhaseScore = score;
          bestPhaseFrame = p;
        }
      }
      const firstBeatSec = (bestPhaseFrame * hop) / sr;

      // Only skip genuine dead silence / video bumper at 0:00 (up to 12s max) so Aメロ & Bメロ -> サビ play naturally!
      let maxBarFull = 0;
      const barFrames = beatFrames * 4;
      const numBars = Math.floor((numFrames - bestPhaseFrame) / barFrames);
      const barFullEnergies = [];
      for (let b = 0; b < numBars; b++) {
        const startF = bestPhaseFrame + b * barFrames;
        let e = 0;
        for (let k = 0; k < barFrames; k++) e += fullEnv[startF + k];
        barFullEnergies.push(e);
        if (e > maxBarFull) maxBarFull = e;
      }

      let bestBarIdx = 0;
      const maxSkipBars = Math.max(2, Math.floor(12.0 / barSec));
      for (let b = 0; b < Math.min(numBars, maxSkipBars); b++) {
        if (barFullEnergies[b] >= maxBarFull * 0.14) {
          bestBarIdx = b;
          break;
        }
      }
      const phraseCueSec = Math.min(
        Math.max(0, buffer.duration - barSec * 4),
        firstBeatSec + bestBarIdx * barSec
      );

      // Detect breakdown / vocal speech pause candidates where energy dips cleanly between phrases
      const phraseBreaks = [];
      const minBreakSearchSec = Math.max(firstBeatSec + barSec * 16, 30.0);
      const maxBreakSearchSec = Math.max(minBreakSearchSec, buffer.duration - barSec * 8);
      for (let b = 16; b < numBars - 4; b += 4) {
        const t = firstBeatSec + b * barSec;
        if (t >= minBreakSearchSec && t <= maxBreakSearchSec) {
          // If bar full energy dips below 35% of max or sudden drop from previous bar
          const curE = barFullEnergies[b] || 0;
          const prevE = barFullEnergies[b - 1] || curE;
          if (curE < maxBarFull * 0.32 || (prevE > maxBarFull * 0.5 && curE < prevE * 0.45)) {
            phraseBreaks.push(t);
          }
        }
      }

      return { firstBeatSec, phraseCueSec, phraseBreaks };
    } catch (_) {
      return { firstBeatSec: 0, phraseCueSec: 0, phraseBreaks: [] };
    }
  }

  _detectChorusWindow(duration, rgbPeaks, firstBeatSec, phraseCueSec, bpm) {
    // Detects the 1st full Chorus (1番サビ) start & end time so AUTO DJ PRO always plays at least past the Chorus!
    const grooveBpm = bpm > 152.0 ? bpm * 0.5 : bpm < 72.0 ? bpm * 2.0 : bpm || 120.0;
    const barSec = (60.0 / grooveBpm) * 4.0;
    const startRef = phraseCueSec || firstBeatSec || 0;

    if (!duration || duration <= 40 || !rgbPeaks || rgbPeaks.length < 32) {
      const fallbackEnd = Math.max(startRef + barSec * 4, (duration || 30) - barSec * 2);
      return { chorusStartSec: startRef + barSec * 2, chorusEndSec: fallbackEnd };
    }

    const numBins = rgbPeaks.length;
    const maxScanSec = Math.min(duration, Math.max(startRef + 160.0, 180.0));
    const totalBars = Math.floor((maxScanSec - firstBeatSec) / barSec);
    if (totalBars < 14) {
      const shortEnd = Math.max(startRef + barSec * 6, duration - barSec * 4);
      return { chorusStartSec: startRef + barSec * 4, chorusEndSec: shortEnd };
    }

    // Per-bar full-spectrum energy (vocals/chords in mid + cymbals in high + kick/bass in low)
    const barScores = new Float32Array(totalBars);
    for (let b = 0; b < totalBars; b++) {
      const t0 = firstBeatSec + b * barSec;
      const t1 = t0 + barSec;
      const i0 = Math.max(0, Math.floor((t0 / duration) * numBins));
      const i1 = Math.min(numBins - 1, Math.ceil((t1 / duration) * numBins));
      let sum = 0;
      let cnt = 0;
      for (let i = i0; i <= i1; i++) {
        const pk = rgbPeaks[i];
        if (pk) {
          sum += pk.low * 0.85 + pk.mid * 1.25 + pk.high * 0.90;
          cnt++;
        }
      }
      barScores[b] = cnt > 0 ? sum / cnt : 0;
    }

    // 8-bar rolling chorus energy window
    const winLen = 8;
    const maxWinIdx = Math.max(1, totalBars - winLen);
    const win8 = new Float32Array(maxWinIdx);
    for (let b = 0; b < maxWinIdx; b++) {
      let s = 0;
      for (let k = 0; k < winLen; k++) s += barScores[b + k];
      win8[b] = s / winLen;
    }

    // Skip opening 頭サビ / intro riff (search after >= 28s / 14 bars on normal tracks) to find the true 1番サビ!
    const minChorusOffsetSec = duration >= 105 ? Math.max(28.0, barSec * 14) : Math.max(14.0, duration * 0.25);
    const maxChorusOffsetSec = Math.min(duration - barSec * 10, 120.0);
    const minBar = Math.max(2, Math.min(maxWinIdx - 1, Math.floor((startRef + minChorusOffsetSec - firstBeatSec) / barSec)));
    const maxBar = Math.max(minBar, Math.min(maxWinIdx - 1, Math.floor((startRef + maxChorusOffsetSec - firstBeatSec) / barSec)));

    let peakChorusEnergy = 0;
    let peakBar = minBar;
    for (let b = minBar; b <= maxBar; b++) {
      if (win8[b] > peakChorusEnergy) {
        peakChorusEnergy = win8[b];
        peakBar = b;
      }
    }

    // Find the first sustained 8-bar high-energy chorus plateau (>= 84% of peak energy)
    let chorusStartBar = peakBar;
    for (let b = minBar; b <= maxBar; b++) {
      if (win8[b] >= peakChorusEnergy * 0.84) {
        chorusStartBar = b;
        break;
      }
    }

    // Walk forward through the entire Chorus (minimum 12 bars, up to 22 bars if double-chorus / post-chorus hook continues)
    let chorusEndBar = Math.min(totalBars - 2, chorusStartBar + 16);
    const minChorusLenBars = duration >= 105 ? 12 : 8;
    const maxChorusLenBars = 22;
    for (let b = chorusStartBar + minChorusLenBars; b <= Math.min(totalBars - 4, chorusStartBar + maxChorusLenBars); b++) {
      const ahead4 = (barScores[b] + barScores[b + 1] + barScores[b + 2] + barScores[b + 3]) * 0.25;
      // Detect post-chorus 間奏 / 2番Aメロ energy drop, or complete 16-bar chorus phrase
      if (ahead4 < peakChorusEnergy * 0.76 || (b >= chorusStartBar + 16 && ahead4 <= peakChorusEnergy * 0.90)) {
        chorusEndBar = b;
        break;
      }
      chorusEndBar = b + 2;
    }

    const cueBar = Math.round((startRef - firstBeatSec) / barSec);
    // Guarantee at least ~75-85s (40 bars on >=110s songs) so even early-hook or ambient tracks play generously past the main chorus!
    const minPlayBars =
      duration >= 115
        ? Math.max(36, Math.round(76.0 / barSec))
        : Math.max(12, Math.floor(((duration - startRef) * 0.68) / barSec));
    let relBars = Math.max(minPlayBars, chorusEndBar - cueBar);
    // Snap up to a clean 4-bar musical phrase boundary
    relBars = Math.ceil(relBars / 4) * 4;

    const rawEndSec = startRef + relBars * barSec;
    const safeReserveSec = Math.max(11.0, barSec * 6.0);
    const maxEndSec = Math.max(startRef + barSec * 6, duration - safeReserveSec);
    const cappedEndSec = Math.min(maxEndSec, Math.min(startRef + 140.0, rawEndSec));
    const chorusStartSec = Math.min(cappedEndSec - barSec * 4, firstBeatSec + chorusStartBar * barSec);

    return {
      chorusStartSec: Math.max(startRef, chorusStartSec),
      chorusEndSec: cappedEndSec,
    };
  }

  _detectTrackRootFreq(buffer) {
    try {
      const data = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      const startSample = Math.min(Math.floor(data.length * 0.25), Math.floor(sr * 15));
      const N = Math.min(16384, data.length - startSample);
      if (N < 2048) return 55.0; // A1

      // 12 chromatic bass root frequencies (F1=43.65Hz to E2=82.41Hz)
      const candidates = [
        43.65, 46.25, 49.0, 51.91, 55.0, 58.27,
        61.74, 65.41, 69.3, 73.42, 77.78, 82.41
      ];
      let bestFreq = 55.0;
      let bestPower = -1;

      for (let c = 0; c < candidates.length; c++) {
        const f = candidates[c];
        // Goertzel / DFT magnitude at fundamental f and 2nd harmonic 2*f
        let power = 0;
        for (let h = 1; h <= 2; h++) {
          const omega = (2.0 * Math.PI * f * h) / sr;
          let re = 0;
          let im = 0;
          for (let i = 0; i < N; i += 4) {
            const s = data[startSample + i];
            re += s * Math.cos(omega * i);
            im += s * Math.sin(omega * i);
          }
          power += Math.sqrt(re * re + im * im) * (h === 1 ? 1.0 : 0.7);
        }
        if (power > bestPower) {
          bestPower = power;
          bestFreq = f;
        }
      }
      return bestFreq;
    } catch (_) {
      return 55.0;
    }
  }

  _clampNaturalBpm(bpm) {
    let b = Number(bpm) || 120.0;
    if (b <= 0) return 120.0;
    while (b < 68.0) b *= 2.0;
    while (b > 176.0) b *= 0.5;
    return Math.round(b * 2) / 2;
  }

  _normalizeBpmToDanceRange(bpm) {
    const b = Number(bpm) || 128.0;
    if (b <= 0) return 128.0;
    const ratios = [1.0, 2.0, 0.5, 4.0 / 3.0, 3.0 / 4.0, 1.5, 2.0 / 3.0];
    let best = b;
    let bestDist = 999.0;
    for (let i = 0; i < ratios.length; i++) {
      const r = ratios[i];
      const cand = b * r;
      if (cand >= 112.0 && cand <= 146.0) {
        const penalty = r === 1.0 || r === 2.0 || r === 0.5 ? 0.0 : 1.2;
        const dist = Math.abs(cand - 128.0) + penalty;
        if (dist < bestDist) {
          bestDist = dist;
          best = cand;
        }
      }
    }
    if (Math.abs(best - 128.0) <= 1.6) {
      return 128.0;
    }
    return Math.round(best * 2) / 2;
  }

  _estimateBpmFromBuffer(buffer) {
    try {
      const data = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      const step = Math.floor(sr / 100); // 100 Hz envelope (10ms hop)
      const totalFrames = Math.floor(data.length / step);
      if (totalFrames < 300) return 120.0;

      // Skip quiet intro: analyze up to 2800 frames (28s) from 22% into the track
      const startFrame = totalFrames > 1400 ? Math.floor(totalFrames * 0.22) : 0;
      const maxFrames = Math.min(2800, totalFrames - startFrame);

      const energy = new Float32Array(maxFrames);
      for (let i = 0; i < maxFrames; i++) {
        let sum = 0;
        const base = (startFrame + i) * step;
        for (let j = 0; j < step; j += 4) {
          const v = data[base + j];
          sum += v * v;
        }
        energy[i] = Math.sqrt(sum / (step / 4));
      }

      const onset = new Float32Array(maxFrames - 1);
      let meanOnset = 0;
      for (let i = 0; i < onset.length; i++) {
        const d = Math.max(0, energy[i + 1] - energy[i]);
        onset[i] = d;
        meanOnset += d;
      }
      meanOnset /= onset.length || 1;
      for (let i = 0; i < onset.length; i++) {
        onset[i] -= meanOnset;
      }

      // Evaluate true original BPMs across the full musical spectrum (74 to 164 BPM)
      let bestBpm = 120.0;
      let bestScore = -Infinity;
      for (let candBpm = 74.0; candBpm <= 164.0; candBpm += 0.5) {
        const beatLag = 6000.0 / candBpm; // fractional frames per beat @ 100 Hz
        let score = 0;
        let count = 0;
        const limit = Math.min(onset.length - Math.ceil(beatLag * 4) - 2, 1400);
        if (limit < 100) continue;
        for (let i = 0; i < limit; i += 2) {
          const idx1 = Math.round(i + beatLag);
          const idx2 = Math.round(i + beatLag * 2);
          const idx4 = Math.round(i + beatLag * 4);
          score += onset[i] * (onset[idx1] + 0.65 * onset[idx2] + 0.45 * onset[idx4]);
          count++;
        }
        if (count > 0) {
          score /= count;
          // Gentle human perceptual tempo prior centered broadly around 112 BPM (avoids extreme half/double octave errors)
          const prior = Math.exp(-Math.pow((candBpm - 112.0) / 48.0, 2) * 0.22);
          const weighted = score * prior;
          if (weighted > bestScore) {
            bestScore = weighted;
            bestBpm = candBpm;
          }
        }
      }
      return this._clampNaturalBpm(bestBpm);
    } catch (_) {
      return 120.0;
    }
  }

  _computeRgbWaveformPeaks(buffer, numBins = 700) {
    const data = buffer.getChannelData(0);
    const total = data.length;
    const binSize = Math.max(1, Math.floor(total / numBins));
    const peaks = [];

    for (let b = 0; b < numBins; b++) {
      const start = b * binSize;
      const end = Math.min(total - 2, start + binSize);
      let lowSum = 0;
      let midSum = 0;
      let highSum = 0;
      let count = 0;
      let prev = data[start] || 0;
      let lp = prev;

      const stride = Math.max(1, Math.floor((end - start) / 64));
      for (let i = start; i < end; i += stride) {
        const s = data[i];
        lp = lp * 0.85 + s * 0.15; // Low frequency proxy
        const hp = s - prev;       // High frequency derivative proxy
        const mp = s - lp;         // Mid frequency proxy
        lowSum += Math.abs(lp);
        midSum += Math.abs(mp);
        highSum += Math.abs(hp);
        prev = s;
        count++;
      }
      if (count === 0) count = 1;
      peaks.push({
        low: Math.min(1, (lowSum / count) * 3.2),
        mid: Math.min(1, (midSum / count) * 3.5),
        high: Math.min(1, (highSum / count) * 4.2),
      });
    }
    return peaks;
  }

  // Transport controls
  togglePlay() {
    this.engine.resume();
    this.endedNaturally = false;
    if (!this.isPlaying && this.duration > 0 && this.playheadSec >= this.duration - 0.15) {
      this.playheadSec = 0;
    }
    this.isPlaying = !this.isPlaying;
    return this.isPlaying;
  }

  pressCue() {
    this.engine.resume();
    this.endedNaturally = false;
    if (this.isPlaying) {
      // Return to Cue point and pause
      this.isPlaying = false;
      this.playheadSec = this.cuePointSec;
    } else {
      // Set Cue point at current position if moved, or preview
      this.cuePointSec = this.playheadSec;
      this.isCuePreviewing = true;
    }
  }

  releaseCue() {
    if (this.isCuePreviewing) {
      this.isCuePreviewing = false;
      if (!this.isPlaying) {
        this.playheadSec = this.cuePointSec;
      }
    }
  }

  seekTo(seconds) {
    if (!this.duration) return;
    this.endedNaturally = false;
    this.playheadSec = Math.max(0, Math.min(this.duration - 0.01, seconds));
  }

  // Loop Controls
  setLoopIn() {
    this.loopInSec = this.playheadSec;
    if (this.loopOutSec !== null && this.loopOutSec <= this.loopInSec) {
      this.loopOutSec = null;
      this.loopActive = false;
    }
  }

  setLoopOut() {
    if (this.loopInSec === null) {
      this.loopInSec = Math.max(0, this.playheadSec - (240 / this.getCurrentBpm()));
    }
    if (this.playheadSec > this.loopInSec + 0.05) {
      this.loopOutSec = this.playheadSec;
      this.loopActive = true;
    }
  }

  triggerAutoLoop4Beat() {
    const beatSec = 60.0 / this.getCurrentBpm();
    this.loopLengthBeats = 4;
    this.loopInSec = this.playheadSec;
    this.loopOutSec = Math.min(this.duration, this.loopInSec + beatSec * 4);
    this.loopActive = true;
  }

  scaleLoop(factor) {
    if (this.loopInSec === null || this.loopOutSec === null) return;
    const len = (this.loopOutSec - this.loopInSec) * factor;
    const beatSec = 60.0 / this.getCurrentBpm();
    if (len >= beatSec * 0.125 && len <= beatSec * 32) {
      this.loopOutSec = Math.min(this.duration, this.loopInSec + len);
    }
  }

  toggleReloopExit() {
    if (this.loopActive) {
      this.loopActive = false;
    } else if (this.loopInSec !== null && this.loopOutSec !== null) {
      this.playheadSec = this.loopInSec;
      this.loopActive = true;
    }
  }

  // EQ & Trim & CFX setters
  setTrimDb(db) {
    this.userTrimDb = db;
    const autoGain = this.autoGainTrim || 1.0;
    const gain = autoGain * Math.pow(10, db / 20);
    this.trimNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.015);
  }

  setEqDb(band, db) {
    const val = db <= -25 ? -40 : db;
    const now = this.ctx.currentTime;
    if (band === "low") this.lowEq.gain.setTargetAtTime(val, now, 0.015);
    if (band === "mid") this.midEq.gain.setTargetAtTime(val, now, 0.015);
    if (band === "hi") this.highEq.gain.setTargetAtTime(val, now, 0.015);
  }

  setCfxValue(val, smartCfxActive, smartPreset) {
    // val is -100 to +100 (0 = center off) — click-free dual LPF/HPF without mutating .type!
    const now = this.ctx.currentTime;
    const absNorm = Math.abs(val) / 100.0;

    if (Math.abs(val) < 2) {
      this.cfxLpFilter.frequency.setTargetAtTime(20000, now, 0.025);
      this.cfxLpFilter.Q.setTargetAtTime(0.707, now, 0.025);
      this.cfxHpFilter.frequency.setTargetAtTime(20, now, 0.025);
      this.cfxHpFilter.Q.setTargetAtTime(0.707, now, 0.025);
      this.cfxWetGain.gain.setTargetAtTime(0, now, 0.025);
      return;
    }

    if (val < 0) {
      // Turn Left: Smooth Butterworth/Musical Low-Pass Filter (20kHz -> 120Hz), HPF stays flat at 20Hz
      const freq = 120 * Math.pow(20000 / 120, 1 - absNorm);
      this.cfxLpFilter.frequency.setTargetAtTime(freq, now, 0.025);
      this.cfxLpFilter.Q.setTargetAtTime(0.707 + absNorm * 0.65, now, 0.025);
      this.cfxHpFilter.frequency.setTargetAtTime(20, now, 0.025);
      this.cfxHpFilter.Q.setTargetAtTime(0.707, now, 0.025);
    } else {
      // Turn Right: Smooth Musical High-Pass Filter (20Hz -> 3200Hz), LPF stays flat at 20kHz
      const freq = 20 * Math.pow(3200 / 20, absNorm);
      this.cfxHpFilter.frequency.setTargetAtTime(freq, now, 0.025);
      this.cfxHpFilter.Q.setTargetAtTime(0.707 + absNorm * 0.55, now, 0.025);
      this.cfxLpFilter.frequency.setTargetAtTime(20000, now, 0.025);
      this.cfxLpFilter.Q.setTargetAtTime(0.707, now, 0.025);
    }

    if (smartCfxActive) {
      const beatSec = 60.0 / this.getCurrentBpm();
      if (smartPreset === "echo_filter") {
        this.cfxDelay.delayTime.setTargetAtTime(beatSec * 0.5, now, 0.03);
        this.cfxFeedback.gain.setTargetAtTime(0.35, now, 0.03);
        this.cfxWetGain.gain.setTargetAtTime(absNorm * 0.28, now, 0.03);
      } else if (smartPreset === "cyber_jet") {
        const modDelay = 0.002 + (1 - absNorm) * 0.008;
        this.cfxDelay.delayTime.setTargetAtTime(modDelay, now, 0.03);
        this.cfxFeedback.gain.setTargetAtTime(0.55, now, 0.03);
        this.cfxWetGain.gain.setTargetAtTime(absNorm * 0.45, now, 0.03);
      } else if (smartPreset === "space_verb") {
        this.cfxDelay.delayTime.setTargetAtTime(0.085, now, 0.03);
        this.cfxFeedback.gain.setTargetAtTime(0.55, now, 0.03);
        this.cfxWetGain.gain.setTargetAtTime(absNorm * 0.38, now, 0.03);
      } else {
        this.cfxDelay.delayTime.setTargetAtTime(0.015 * (1 + absNorm), now, 0.03);
        this.cfxFeedback.gain.setTargetAtTime(0.45, now, 0.03);
        this.cfxWetGain.gain.setTargetAtTime(absNorm * 0.35, now, 0.03);
      }
    } else {
      this.cfxWetGain.gain.setTargetAtTime(0, now, 0.025);
    }
  }

  // Pad FX 1 Trigger (Hold to apply, Release to stop)
  startPadFx(padIndex) {
    this.activePadFx = padIndex;
    const now = this.ctx.currentTime;
    const beatSec = 60.0 / this.getCurrentBpm();

    switch (padIndex) {
      case 0: // JET FLANGER
        this.cfxDelay.delayTime.setTargetAtTime(0.004, now, 0.01);
        this.cfxFeedback.gain.setTargetAtTime(0.78, now, 0.01);
        this.cfxWetGain.gain.setTargetAtTime(0.75, now, 0.01);
        break;
      case 1: // PHASER SWEEP
        this.padFxFilter.type = "notch";
        this.padFxFilter.frequency.setTargetAtTime(750, now, 0.02);
        this.padFxFilter.Q.setTargetAtTime(3.5, now, 0.02);
        break;
      case 2: // ECHO 1/2
        this.cfxDelay.delayTime.setTargetAtTime(beatSec * 0.5, now, 0.01);
        this.cfxFeedback.gain.setTargetAtTime(0.65, now, 0.01);
        this.cfxWetGain.gain.setTargetAtTime(0.7, now, 0.01);
        break;
      case 3: // REVERB WASH
        this.cfxDelay.delayTime.setTargetAtTime(0.065, now, 0.01);
        this.cfxFeedback.gain.setTargetAtTime(0.8, now, 0.01);
        this.cfxWetGain.gain.setTargetAtTime(0.75, now, 0.01);
        break;
      case 4: // ROLL 1/4 BEAT
        this.rollSavedSec = this.playheadSec;
        this.rollLoopLenSec = beatSec * 0.25;
        break;
      case 5: // ROLL 1/2 BEAT
        this.rollSavedSec = this.playheadSec;
        this.rollLoopLenSec = beatSec * 0.5;
        break;
      case 6: // VINYL BRAKE
        // Handled in getEffectivePlaybackRate
        break;
      case 7: // HPF DROP RISER
        this.padFxFilter.type = "highpass";
        this.padFxFilter.frequency.setTargetAtTime(1800, now, 0.03);
        this.padFxFilter.Q.setTargetAtTime(3.0, now, 0.03);
        break;
    }
  }

  stopPadFx() {
    this.activePadFx = null;
    this.rollSavedSec = null;
    this.rollLoopLenSec = 0;
    const now = this.ctx.currentTime;
    this.padFxFilter.type = "allpass";
    this.padFxFilter.frequency.setTargetAtTime(1000, now, 0.02);
    this.padFxFilter.Q.setTargetAtTime(0.707, now, 0.02);
    this.cfxWetGain.gain.setTargetAtTime(0, now, 0.03);
  }

  getVuLevel() {
    if (!this.isPlaying && !this.isCuePreviewing && !this.isScratching) return 0;
    this.analyser.getByteTimeDomainData(this.analyserData);
    let sum = 0;
    for (let i = 0; i < this.analyserData.length; i++) {
      const v = (this.analyserData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.analyserData.length);
    return Math.min(1.0, rms * 2.8 * this.chFaderGain.gain.value);
  }
}

class DDJFlx4AudioEngine {
  constructor() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    try {
      this.ctx = new AudioCtx({ sampleRate: 44100 });
    } catch (_) {
      this.ctx = new AudioCtx();
    }

    // Master & Beat FX Bus
    this.masterBus = this.ctx.createGain();
    this.masterBus.gain.value = 1.0;

    // Beat FX Processor on Master/Assignable Bus
    this.beatFxActive = false;
    this.beatFxType = "echo";
    this.beatFxBeats = 0.5; // 1/4, 1/2, 1, 2, 4
    this.beatFxChannel = "master"; // '1' | '2' | 'master'
    this.beatFxDepth = 0.5;

    this._buildBeatFxChain();

    // Headphone Cue / Split Cue Matrix
    this.splitCueEnabled = false;
    this.cueMixBus = this.ctx.createGain();
    this.cueMixBus.gain.value = 0.85;

    // Master Limiter / Compressor for clean club sound
    this.masterCompressor = this.ctx.createDynamicsCompressor();
    this.masterCompressor.threshold.value = -6;
    this.masterCompressor.knee.value = 12;
    this.masterCompressor.ratio.value = 4;
    this.masterCompressor.attack.value = 0.003;
    this.masterCompressor.release.value = 0.15;

    this.masterOutputGain = this.ctx.createGain();
    this.masterOutputGain.gain.value = 1.0;

    // Split Cue Stereo Merger (Left = Master, Right = Cue when Split Cue ON)
    this.channelMerger = this.ctx.createChannelMerger(2);

    // Recording Destination + sub-audible (-96 dBFS) clock keep-alive so MediaRecorder never drops initial silent audio frames
    this.recordDest = this.ctx.createMediaStreamDestination();
    this._recKeepAliveOsc = this.ctx.createOscillator();
    this._recKeepAliveGain = this.ctx.createGain();
    this._recKeepAliveOsc.type = "sine";
    this._recKeepAliveOsc.frequency.value = 18;
    this._recKeepAliveGain.gain.value = 0.000015;
    this._recKeepAliveOsc.connect(this._recKeepAliveGain);
    this._recKeepAliveGain.connect(this.recordDest);
    try {
      this._recKeepAliveOsc.start();
    } catch (_) {}

    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;
    this._activeRecVideoStream = null;

    // Connect Master Bus -> Beat FX -> Compressor -> Output & Recorder
    this.masterBus.connect(this.fxInputNode);
    this.fxOutputNode.connect(this.masterCompressor);
    this.cueMixBus.connect(this.masterCompressor);

    this.masterCompressor.connect(this.masterOutputGain);
    this.masterOutputGain.connect(this.ctx.destination);
    this.masterOutputGain.connect(this.recordDest);

    // Create Deck 1 & Deck 2
    this.deck1 = new DeckDSP(this, 1);
    this.deck2 = new DeckDSP(this, 2);

    this.deck1.xfaderGain.connect(this.masterBus);
    this.deck2.xfaderGain.connect(this.masterBus);
    this.deck1.echoReturnGain.connect(this.masterBus);
    this.deck2.echoReturnGain.connect(this.masterBus);
    this.deck1.cueTapGain.connect(this.cueMixBus);
    this.deck2.cueTapGain.connect(this.cueMixBus);

    // Smart Features State
    this.smartFaderEnabled = false;
    this.smartCfxEnabled = false;
    this.smartCfxPreset = "echo_filter";
    this.crossfaderPos = 0; // -1 (Deck 1) .. 0 (Center) .. +1 (Deck 2)

    // Sampler Gain & 8 Built-in DJ Samples
    this.samplerGain = this.ctx.createGain();
    this.samplerGain.gain.value = 0.9;
    this.samplerGain.connect(this.masterCompressor);
    this.samplerNames = [
      "AIR HORN",
      "LASER ZAP",
      "CLUB SIREN",
      "SUB DROP",
      "SCRATCH HIT",
      "SNARE BUILD",
      "HAND CLAP",
      "CROWD YEAH!"
    ];

    // Microphone state
    this.micStream = null;
    this.micSource = null;
    this.micGain = null;
    this.micActive = false;

    // Trans Gate LFO Timer for Beat FX 'trans'
    this._startLfoTimer();

    // iOS / iPhone Screen-Closed Background Playback Bridge & Unthrottled Audio Clock
    this.onBackgroundTick = null;
    this.lastForegroundFrameMs = 0;
    this._lastBgTickMs = 0;
    this.bgKeepAliveWanted = false;
    this._bgAudioUnlocked = false;
    this._initIosBackgroundAudioBridge();

    // Generate 4 Built-in Demo Tracks immediately
    this.demoTracks = this._generateBuiltInDemoTracks();
  }

  _configurePlaybackAudioSession() {
    try {
      // iOS 17+ / 18+ Safari: promotes Web Audio to AVAudioSessionCategoryPlayback
      // so audio plays continuously when the iPhone screen is closed/locked and when Silent switch is ON!
      if (typeof navigator !== "undefined" && navigator.audioSession) {
        if (navigator.audioSession.type !== "playback") {
          navigator.audioSession.type = "playback";
        }
      }
    } catch (_) {}
  }

  _createSubAudibleKeepAliveWavUrl() {
    // 30-second mono 4000 Hz 16-bit PCM WAV with a 1 Hz infrasonic ±2 LSB (-84 dBFS) wave:
    // 100% physically inaudible on speakers/AirPods, yet strictly non-zero digital PCM
    // so iOS Safari's AVAudioSession & Lock Screen Now Playing never treat it as silence!
    const sampleRate = 4000;
    const durationSec = 30;
    const numSamples = sampleRate * durationSec;
    const dataBytes = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const writeAscii = (off, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);      // PCM chunk size
    view.setUint16(20, 1, true);       // PCM format = 1
    view.setUint16(22, 1, true);       // 1 channel (mono)
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);       // block align
    view.setUint16(34, 16, true);      // 16-bit
    writeAscii(36, "data");
    view.setUint32(40, dataBytes, true);

    for (let i = 0; i < numSamples; i++) {
      const val = Math.round(Math.sin((2.0 * Math.PI * i) / sampleRate) * 2.0);
      view.setInt16(44 + i * 2, val, true);
    }
    const blob = new Blob([buffer], { type: "audio/wav" });
    return URL.createObjectURL(blob);
  }

  _initIosBackgroundAudioBridge() {
    this._configurePlaybackAudioSession();
    try {
      this._keepAliveWavUrl = this._createSubAudibleKeepAliveWavUrl();
      const audioEl = new Audio(this._keepAliveWavUrl);
      audioEl.loop = true;
      audioEl.preload = "auto";
      audioEl.volume = 0.02;
      audioEl.playsInline = true;
      audioEl.setAttribute("playsinline", "");
      audioEl.setAttribute("webkit-playsinline", "");
      this.bgKeepAliveAudio = audioEl;

      // If iOS briefly pauses the <audio> carrier during screen-lock transition while DJ playback is active, immediately keep it alive!
      audioEl.addEventListener("pause", () => {
        if (!this.bgKeepAliveWanted) return;
        setTimeout(() => {
          if (this.bgKeepAliveWanted && audioEl.paused) {
            this._configurePlaybackAudioSession();
            audioEl.play().catch(() => {});
          }
          if (this.bgKeepAliveWanted && this.ctx.state !== "running") {
            this.ctx.resume().catch(() => {});
          }
        }, 50);
      });
    } catch (_) {
      this.bgKeepAliveAudio = null;
    }

    // Recover immediately from iOS 'interrupted' or 'suspended' AudioContext states when screen locks or notifications arrive
    if (this.ctx && typeof this.ctx.addEventListener === "function") {
      this.ctx.addEventListener("statechange", () => {
        if (this.bgKeepAliveWanted && this.ctx.state !== "running") {
          this._configurePlaybackAudioSession();
          try {
            this.ctx.resume().catch(() => {});
          } catch (_) {}
        }
      });
    }
  }

  unlockIosAudio() {
    this._configurePlaybackAudioSession();
    if (this.ctx && this.ctx.state !== "running") {
      try {
        this.ctx.resume().catch(() => {});
      } catch (_) {}
    }
    if (this.bgKeepAliveAudio && !this._bgAudioUnlocked) {
      const el = this.bgKeepAliveAudio;
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          this._bgAudioUnlocked = true;
          if (!this.bgKeepAliveWanted) {
            el.pause();
          }
        }).catch(() => {});
      }
    } else if (this.bgKeepAliveAudio && this.bgKeepAliveWanted && this.bgKeepAliveAudio.paused) {
      this.bgKeepAliveAudio.play().catch(() => {});
    }
  }

  setBackgroundPlaybackActive(active) {
    this.bgKeepAliveWanted = Boolean(active);
    this._configurePlaybackAudioSession();
    if (this.bgKeepAliveWanted) {
      if (this.ctx && this.ctx.state !== "running") {
        try {
          this.ctx.resume().catch(() => {});
        } catch (_) {}
      }
      if (this.bgKeepAliveAudio && this.bgKeepAliveAudio.paused) {
        this.bgKeepAliveAudio.play().catch(() => {});
      }
    } else {
      if (this.bgKeepAliveAudio && !this.bgKeepAliveAudio.paused) {
        try {
          this.bgKeepAliveAudio.pause();
        } catch (_) {}
      }
    }
  }

  _onAudioProcessTick() {
    if (!this.onBackgroundTick) return;
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const isHidden = typeof document !== "undefined" && document.hidden;
    const rafStalled = nowMs - (this.lastForegroundFrameMs || 0) > 90;
    if ((isHidden || rafStalled) && nowMs - (this._lastBgTickMs || 0) >= 40) {
      this._lastBgTickMs = nowMs;
      try {
        this.onBackgroundTick();
      } catch (_) {}
    }
  }

  resume() {
    this._configurePlaybackAudioSession();
    if (this.ctx && this.ctx.state !== "running") {
      try {
        const p = this.ctx.resume();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (_) {}
    }
    if (this.bgKeepAliveWanted && this.bgKeepAliveAudio && this.bgKeepAliveAudio.paused) {
      this.bgKeepAliveAudio.play().catch(() => {});
    }
  }

  setSplitCue(enabled) {
    this.splitCueEnabled = enabled;
    // Disconnect and re-route masterCompressor & cueMixBus
    try {
      this.fxOutputNode.disconnect();
      this.cueMixBus.disconnect();
      this.channelMerger.disconnect();
    } catch (_) {}

    if (enabled) {
      // Split Cue Mode: Left ear = Master Mix, Right ear = Headphone Cue
      this.fxOutputNode.connect(this.channelMerger, 0, 0);
      this.cueMixBus.connect(this.channelMerger, 0, 1);
      this.channelMerger.connect(this.masterCompressor);
    } else {
      // Normal Stereo Mode
      this.fxOutputNode.connect(this.masterCompressor);
      this.cueMixBus.connect(this.masterCompressor);
    }
  }

  _buildBeatFxChain() {
    const ctx = this.ctx;
    this.fxInputNode = ctx.createGain();
    this.fxOutputNode = ctx.createGain();

    this.fxDryGain = ctx.createGain();
    this.fxDryGain.gain.value = 1.0;

    this.fxWetGain = ctx.createGain();
    this.fxWetGain.gain.value = 0.0;

    this.fxDelay = ctx.createDelay(4.0);
    this.fxDelay.delayTime.value = 0.25;

    this.fxFeedback = ctx.createGain();
    this.fxFeedback.gain.value = 0.55;

    this.fxFilter = ctx.createBiquadFilter();
    this.fxFilter.type = "bandpass";
    this.fxFilter.frequency.value = 1400;
    this.fxFilter.Q.value = 0.7;

    this.fxGateGain = ctx.createGain();
    this.fxGateGain.gain.value = 1.0;

    this.fxShaper = ctx.createWaveShaper();
    this.fxShaper.curve = this._makeBitCrushCurve(1);

    // Dry path (goes through fxGateGain for TRANS effect)
    this.fxInputNode.connect(this.fxGateGain);
    this.fxGateGain.connect(this.fxDryGain);
    this.fxDryGain.connect(this.fxOutputNode);

    // Wet path
    this.fxInputNode.connect(this.fxDelay);
    this.fxDelay.connect(this.fxFilter);
    this.fxFilter.connect(this.fxFeedback);
    this.fxFeedback.connect(this.fxDelay);

    this.fxFilter.connect(this.fxShaper);
    this.fxShaper.connect(this.fxWetGain);
    this.fxWetGain.connect(this.fxOutputNode);
  }

  _makeBitCrushCurve(amount = 1) {
    const samples = 4096;
    const curve = new Float32Array(samples);
    const steps = Math.max(4, Math.floor(64 / (1 + amount * 8)));
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    return curve;
  }

  updateBeatFxParams() {
    const now = this.ctx.currentTime;
    const refDeck = this.beatFxChannel === "2" ? this.deck2 : this.deck1;
    const bpm = refDeck.getCurrentBpm() || 124;
    const beatSec = (60.0 / bpm) * this.beatFxBeats;

    if (!this.beatFxActive) {
      this.fxWetGain.gain.setTargetAtTime(0, now, 0.02);
      this.fxGateGain.gain.setTargetAtTime(1.0, now, 0.02);
      return;
    }

    const depth = this.beatFxDepth;
    switch (this.beatFxType) {
      case "echo":
        this.fxFilter.type = "bandpass";
        this.fxFilter.frequency.setTargetAtTime(1200, now, 0.02);
        this.fxDelay.delayTime.setTargetAtTime(Math.min(3.5, beatSec), now, 0.02);
        this.fxFeedback.gain.setTargetAtTime(0.62, now, 0.02);
        this.fxWetGain.gain.setTargetAtTime(depth * 0.85, now, 0.02);
        break;
      case "delay":
        this.fxFilter.type = "lowpass";
        this.fxFilter.frequency.setTargetAtTime(4500, now, 0.02);
        this.fxDelay.delayTime.setTargetAtTime(Math.min(3.5, beatSec), now, 0.02);
        this.fxFeedback.gain.setTargetAtTime(0.35, now, 0.02);
        this.fxWetGain.gain.setTargetAtTime(depth * 0.8, now, 0.02);
        break;
      case "reverb":
        this.fxFilter.type = "lowpass";
        this.fxFilter.frequency.setTargetAtTime(3000, now, 0.02);
        this.fxDelay.delayTime.setTargetAtTime(0.072, now, 0.02);
        this.fxFeedback.gain.setTargetAtTime(0.82, now, 0.02);
        this.fxWetGain.gain.setTargetAtTime(depth * 0.75, now, 0.02);
        break;
      case "flanger":
        this.fxFilter.type = "allpass";
        this.fxDelay.delayTime.setTargetAtTime(0.005, now, 0.02);
        this.fxFeedback.gain.setTargetAtTime(0.75, now, 0.02);
        this.fxWetGain.gain.setTargetAtTime(depth * 0.85, now, 0.02);
        break;
      case "phaser":
        this.fxFilter.type = "notch";
        this.fxFilter.frequency.setTargetAtTime(900, now, 0.02);
        this.fxDelay.delayTime.setTargetAtTime(0.002, now, 0.02);
        this.fxFeedback.gain.setTargetAtTime(0.65, now, 0.02);
        this.fxWetGain.gain.setTargetAtTime(depth * 0.85, now, 0.02);
        break;
      case "crush":
        this.fxShaper.curve = this._makeBitCrushCurve(depth * 1.5);
        this.fxDelay.delayTime.setTargetAtTime(0.001, now, 0.02);
        this.fxFeedback.gain.setTargetAtTime(0.1, now, 0.02);
        this.fxWetGain.gain.setTargetAtTime(depth * 0.9, now, 0.02);
        break;
      case "trans":
        this.fxWetGain.gain.setTargetAtTime(0, now, 0.02);
        break;
    }
  }

  _startLfoTimer() {
    let phase = 0;
    setInterval(() => {
      phase += 0.12;
      const now = this.ctx.currentTime;
      if (this.beatFxActive && this.beatFxType === "trans") {
        const refDeck = this.beatFxChannel === "2" ? this.deck2 : this.deck1;
        const bpm = refDeck.getCurrentBpm() || 124;
        const period = (60.0 / bpm) * this.beatFxBeats;
        const mod = (now % period) / period;
        const gate = mod < 0.55 ? 1.0 : 1.0 - this.beatFxDepth * 0.92;
        this.fxGateGain.gain.setTargetAtTime(gate, now, 0.008);
      } else if (this.beatFxActive && (this.beatFxType === "flanger" || this.beatFxType === "phaser")) {
        const lfo = (Math.sin(phase) + 1) * 0.5;
        if (this.beatFxType === "flanger") {
          this.fxDelay.delayTime.setTargetAtTime(0.0015 + lfo * 0.007, now, 0.02);
        } else {
          this.fxFilter.frequency.setTargetAtTime(350 + lfo * 2200, now, 0.02);
        }
      }
    }, 35);
  }

  // ==================== CROSSFADER & SMART FADER LOGIC ====================
  setCrossfader(pos) {
    // pos: -1 (Deck 1 full) .. 0 (Center) .. +1 (Deck 2 full)
    this.crossfaderPos = Math.max(-1, Math.min(1, pos));
    const now = this.ctx.currentTime;

    // Pioneer DJM Club Crossfader Curve (Full 1.0 gain on both decks at 0.0 center for punchy CH-fader mixing!)
    const norm = (this.crossfaderPos + 1) * 0.5; // 0 (Deck 1) .. 0.5 (Center) .. 1 (Deck 2)
    const gain1 = this.crossfaderPos <= 0 ? 1.0 : Math.cos(this.crossfaderPos * 0.5 * Math.PI);
    const gain2 = this.crossfaderPos >= 0 ? 1.0 : Math.cos(-this.crossfaderPos * 0.5 * Math.PI);

    this.deck1.xfaderGain.gain.setTargetAtTime(gain1, now, 0.015);
    this.deck2.xfaderGain.gain.setTargetAtTime(gain2, now, 0.015);

    if (this.smartFaderEnabled) {
      // DDJ-FLX4 SMART FADER:
      // 1. Real-time BPM interpolation between Deck 1 native BPM and Deck 2 native BPM
      const bpm1 = this.deck1.baseBpm * (1 + this.deck1.tempoSliderPos * this.deck1.tempoRange);
      const bpm2 = this.deck2.baseBpm * (1 + this.deck2.tempoSliderPos * this.deck2.tempoRange);
      const targetBpm = bpm1 * (1 - norm) + bpm2 * norm;
      this.deck1.smartFaderBpmOverride = targetBpm;
      this.deck2.smartFaderBpmOverride = targetBpm;

      // 2. Automatic Bass Swap (Cut LOW frequencies on outgoing deck so basslines never clash!)
      // When norm > 0.5, Deck 1 is outgoing -> cut Deck 1 bass up to -24dB
      // When norm < 0.5, Deck 2 is outgoing -> cut Deck 2 bass up to -24dB
      const bassCut1 = norm > 0.35 ? -((norm - 0.35) / 0.65) * 26 : 0;
      const bassCut2 = norm < 0.65 ? -((0.65 - norm) / 0.65) * 26 : 0;
      this.deck1.smartBassFilter.gain.setTargetAtTime(bassCut1, now, 0.02);
      this.deck2.smartBassFilter.gain.setTargetAtTime(bassCut2, now, 0.02);
    } else {
      this.deck1.smartFaderBpmOverride = null;
      this.deck2.smartFaderBpmOverride = null;
      this.deck1.smartBassFilter.gain.setTargetAtTime(0, now, 0.02);
      this.deck2.smartBassFilter.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  // Reset deck to 100% original song speed (+0.0%) with MASTER TEMPO active
  resetDeckToOriginalBpm(deckId) {
    const deck = deckId === 1 ? this.deck1 : this.deck2;
    deck.keyLock = true;
    deck.tempoRange = 0.08;
    deck.tempoSliderPos = 0;
  }

  // Smoothly set a deck's playback BPM relative to its true original baseBpm (preserving vocal pitch via keyLock)
  setDeckTargetBpm(deckId, targetBpm) {
    const deck = deckId === 1 ? this.deck1 : this.deck2;
    if (!deck.baseBpm || !targetBpm) return;
    deck.keyLock = true;
    const neededRatio = targetBpm / deck.baseBpm - 1.0;
    const absR = Math.abs(neededRatio);
    if (absR <= 0.08) {
      deck.tempoRange = 0.08;
    } else if (absR <= 0.16) {
      deck.tempoRange = 0.16;
    } else if (absR <= 0.50) {
      deck.tempoRange = 0.50;
    } else {
      deck.tempoRange = 0.85;
    }
    deck.tempoSliderPos = Math.max(-1, Math.min(1, neededRatio / deck.tempoRange));
  }

  // Optional 128 BPM Festival Lock (used only when user selects Fixed 128 BPM mode)
  lockDeckToTargetBpm(deckId, targetBpm = 128.0) {
    const deck = deckId === 1 ? this.deck1 : this.deck2;
    if (!deck.baseBpm) return;
    const danceBase = deck._normalizeBpmToDanceRange(deck.baseBpm);
    const ratio = targetBpm / danceBase;
    this.setDeckTargetBpm(deckId, deck.baseBpm * ratio);
  }

  // Find closest natural beat-grid relationship (1x, 0.5x half-time, or 2x double-time) so songs change speed as little as possible!
  getBestBeatGridMatch(referenceBpm, targetBaseBpm) {
    const ref = Number(referenceBpm) || 120.0;
    const base = Number(targetBaseBpm) || 120.0;
    const mults = [1.0, 0.5, 2.0];
    let bestMult = 1.0;
    let bestEff = base;
    let bestRel = Infinity;
    for (let i = 0; i < mults.length; i++) {
      const m = mults[i];
      const eff = base * m;
      const rel = Math.abs(eff - ref) / Math.max(40.0, ref);
      if (rel < bestRel) {
        bestRel = rel;
        bestMult = m;
        bestEff = eff;
      }
    }
    return {
      mult: bestMult,
      effectiveBaseBpm: bestEff,
      syncedPlaybackBpm: ref / bestMult,
      relDiff: bestRel,
    };
  }

  // Beat & Phrase Sync Deck A to Deck B (preserves true baseBpm, supports half/double-time beat grids, aligns 4-beat bar phase)
  syncDeckToOther(targetDeckId) {
    const target = targetDeckId === 1 ? this.deck1 : this.deck2;
    const master = targetDeckId === 1 ? this.deck2 : this.deck1;
    const masterBpm = master.getCurrentBpm();
    if (!target.baseBpm || !masterBpm) return;

    const match = this.getBestBeatGridMatch(masterBpm, target.baseBpm);
    this.setDeckTargetBpm(targetDeckId, match.syncedPlaybackBpm);

    // Align 4-beat bar phase in real wall-clock playback time relative to each track's firstBeatSec!
    const commonBeatSec = 60.0 / masterBpm;
    const barSec = commonBeatSec * 4.0;
    const mRate = Math.max(0.25, master.getEffectivePlaybackRate() || 1.0);
    const tRate = Math.max(0.25, target.getEffectivePlaybackRate() || 1.0);
    const mFirst = master.firstBeatSec || 0;
    const tFirst = target.firstBeatSec || 0;

    const masterWallPos = ((((master.playheadSec - mFirst) / mRate) % barSec) + barSec) % barSec;
    const targetWallPos = ((((target.playheadSec - tFirst) / tRate) % barSec) + barSec) % barSec;
    let diffWallSec = masterWallPos - targetWallPos;
    if (diffWallSec > barSec * 0.5) diffWallSec -= barSec;
    if (diffWallSec < -barSec * 0.5) diffWallSec += barSec;

    const diffTrackSec = diffWallSec * tRate;
    const isTargetAudible = target.isPlaying && target.xfaderGain.gain.value > 0.12;
    if (!isTargetAudible || Math.abs(diffWallSec) > 0.025) {
      const nextPos = Math.max(0, Math.min((target.duration || 60) - 2, target.playheadSec + diffTrackSec));
      target.seekTo(nextPos);
    }
  }

  // ==================== 8-PAD SYNTHESIZED DJ SAMPLER ====================
  triggerSamplerPad(padIdx) {
    this.resume();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    switch (padIdx) {
      case 0: { // AIR HORN (Classic Reggae/Club Dancehall Horn)
        const freqs = [440, 554.37, 659.25];
        freqs.forEach((f) => {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(f * 0.92, now);
          osc.frequency.exponentialRampToValueAtTime(f, now + 0.06);
          g.gain.setValueAtTime(0.22, now);
          g.gain.setValueAtTime(0.22, now + 0.45);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.75);
          osc.connect(g);
          g.connect(this.samplerGain);
          osc.start(now);
          osc.stop(now + 0.76);
        });
        break;
      }
      case 1: { // LASER ZAP
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(2400, now);
        osc.frequency.exponentialRampToValueAtTime(90, now + 0.28);
        g.gain.setValueAtTime(0.45, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.connect(g);
        g.connect(this.samplerGain);
        osc.start(now);
        osc.stop(now + 0.31);
        break;
      }
      case 2: { // CLUB SIREN
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.linearRampToValueAtTime(980, now + 0.3);
        osc.frequency.linearRampToValueAtTime(520, now + 0.6);
        osc.frequency.linearRampToValueAtTime(980, now + 0.9);
        g.gain.setValueAtTime(0.4, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
        osc.connect(g);
        g.connect(this.samplerGain);
        osc.start(now);
        osc.stop(now + 1.02);
        break;
      }
      case 3: { // SUB DROP (808 Bass Bomb)
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(130, now);
        osc.frequency.exponentialRampToValueAtTime(32, now + 1.1);
        g.gain.setValueAtTime(0.8, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
        osc.connect(g);
        g.connect(this.samplerGain);
        osc.start(now);
        osc.stop(now + 1.22);
        break;
      }
      case 4: { // SCRATCH HIT
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "bandpass";
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.exponentialRampToValueAtTime(950, now + 0.08);
        osc.frequency.exponentialRampToValueAtTime(220, now + 0.18);
        g.gain.setValueAtTime(0.4, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(g);
        g.connect(this.samplerGain);
        osc.start(now);
        osc.stop(now + 0.21);
        break;
      }
      case 5: { // SNARE BUILD (4 rapid hits)
        for (let k = 0; k < 4; k++) {
          const t = now + k * 0.09;
          this._triggerSynthSnare(t, 0.35);
        }
        break;
      }
      case 6: { // HAND CLAP
        this._triggerSynthSnare(now, 0.55);
        break;
      }
      case 7: { // CROWD YEAH / CHORD STAB
        [261.63, 329.63, 392.0, 523.25].forEach((f) => {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(f, now);
          g.gain.setValueAtTime(0.2, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
          osc.connect(g);
          g.connect(this.samplerGain);
          osc.start(now);
          osc.stop(now + 0.56);
        });
        break;
      }
    }
  }

  // ==================== NICKY ROMERO MAINSTAGE FX GENERATORS ====================
  triggerFestivalWhiteNoiseRiser(durationSec = 4.0) {
    this.resume();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = Math.max(1.5, Math.min(8.0, durationSec));

    // Key-neutral, silky Stereo Air Sweep (320Hz -> 6400Hz resonant filter sweep, blends cleanly with ANY song key!)
    const bufLen = Math.floor(ctx.sampleRate * dur);
    const noiseBuf = ctx.createBuffer(2, bufLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = noiseBuf.getChannelData(ch);
      let pink = 0;
      for (let i = 0; i < bufLen; i++) {
        const w = Math.random() * 2 - 1;
        pink = 0.88 * pink + 0.12 * w;
        data[i] = w * 0.55 + pink * 0.45;
      }
    }
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;

    const bpFilter = ctx.createBiquadFilter();
    bpFilter.type = "bandpass";
    bpFilter.Q.value = 2.2;
    bpFilter.frequency.setValueAtTime(340, now);
    bpFilter.frequency.exponentialRampToValueAtTime(6400, now + dur * 0.94);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.005, now);
    noiseGain.gain.linearRampToValueAtTime(0.18, now + dur * 0.88);
    noiseGain.gain.linearRampToValueAtTime(0.001, now + dur * 0.99);

    noiseSrc.connect(bpFilter);
    bpFilter.connect(noiseGain);
    noiseGain.connect(this.samplerGain);
    noiseSrc.start(now);
    noiseSrc.stop(now + dur);
  }

  triggerMainstageDropImpact(withPad5to8Fx = false) {
    this.resume();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // 1. Warm Club Sub-Bass Downbeat Punch (95Hz -> 36Hz)
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = "sine";
    subOsc.frequency.setValueAtTime(95, now);
    subOsc.frequency.exponentialRampToValueAtTime(36, now + 0.65);
    subGain.gain.setValueAtTime(withPad5to8Fx ? 0.42 : 0.30, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.78);
    subOsc.connect(subGain);
    subGain.connect(this.samplerGain);
    subOsc.start(now);
    subOsc.stop(now + 0.8);

    // 2. High-frequency Cymbal Noise Shimmer (Pad 8 FX) — ONLY when Pad 5-8 FX is explicitly ON
    if (!withPad5to8Fx) return;

    const crashLen = Math.floor(ctx.sampleRate * 1.1);
    const crashBuf = ctx.createBuffer(2, crashLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = crashBuf.getChannelData(ch);
      for (let i = 0; i < crashLen; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.32));
      }
    }
    const crashSrc = ctx.createBufferSource();
    crashSrc.buffer = crashBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 4200;
    const crashGain = ctx.createGain();
    crashGain.gain.value = 0.16;
    crashSrc.connect(hp);
    hp.connect(crashGain);
    crashGain.connect(this.samplerGain);
    crashSrc.start(now);
  }

  triggerTransitionRiser(durationSec = 1.6) {
    this.resume();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = Math.max(0.6, Math.min(3.2, durationSec));

    // Synthesize rising white noise sweep with bandpass filter (450Hz -> 8200Hz)
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(450, now);
    bp.frequency.exponentialRampToValueAtTime(8200, now + dur);
    bp.Q.setValueAtTime(2.2, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.24, now + dur * 0.92);
    gain.gain.linearRampToValueAtTime(0.001, now + dur);

    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.masterBus);

    src.start(now);
    src.stop(now + dur + 0.05);
  }

  _triggerSynthSnare(startTime, gainVal) {
    const ctx = this.ctx;
    const bufSize = Math.floor(ctx.sampleRate * 0.15);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.04));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = "highpass";
    filt.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.value = gainVal;
    src.connect(filt);
    filt.connect(g);
    g.connect(this.samplerGain);
    src.start(startTime);
  }

  // ==================== TOMORROWLAND 2019 MAINSTAGE (NICKY ROMERO) LIVE EDM ENGINE ====================
  triggerEdmRemixStep(
    stepInBar16,
    barInCycle,
    phaseMode,
    rootFreq = 55.0,
    beatSec = 0.46875,
    buildProgress = 0,
    cycleNumber = 0,
    pad5to8Fx = false
  ) {
    this.resume();
    const now = this.ctx.currentTime;
    const tonicSub = Math.max(43.65, Math.min(73.42, rootFreq || 55.0));
    const isElectroBounceChapter = cycleNumber % 2 === 1;
    const cleanMode = !pad5to8Fx;

    if (phaseMode === "vocal_spotlight") {
      // Iconic Tomorrowland 1-Beat Vocal Spotlight:
      // Release sidechain & cut EDM drums for 1 beat so the incoming song's raw vocal/hook shines at 100% clarity!
      this.deck1.edmSidechainGain.gain.setTargetAtTime(1.0, now, 0.02);
      this.deck2.edmSidechainGain.gain.setTargetAtTime(1.0, now, 0.02);
      if (pad5to8Fx && stepInBar16 === 12) {
        this._triggerEdmClap(now, 0.42);
      }
      return;
    }

    if (phaseMode === "buildup") {
      this.deck1.setEdmRemixMode(true, cleanMode);
      this.deck2.setEdmRemixMode(true, cleanMode);

      // When Pad 5-8 FX is OFF (default), skip harsh synthesized noise snares/claps so the song's natural CDJ loop & filter sweep stay super clean!
      if (!pad5to8Fx) {
        this.deck1.edmSidechainGain.gain.setTargetAtTime(1.0, now, 0.04);
        this.deck2.edmSidechainGain.gain.setTargetAtTime(1.0, now, 0.04);
        return;
      }

      // Tomorrowland Stadium Clap + Accelerating Snare Build (Quarter -> 8th -> 16th notes)
      if (buildProgress < 0.35) {
        if (stepInBar16 % 4 === 0) this._triggerEdmClap(now, 0.28);
        if (stepInBar16 % 2 === 0) this._triggerEdmSnareBuildHit(now, 0.16, 650);
      } else if (buildProgress < 0.72) {
        if (stepInBar16 % 2 === 0) {
          this._triggerEdmSnareBuildHit(now, 0.24, 950 + buildProgress * 1200);
        } else {
          this._triggerEdmSnareBuildHit(now, 0.13, 1200 + buildProgress * 1400);
        }
      } else {
        const vel = 0.20 + buildProgress * 0.22;
        this._triggerEdmSnareBuildHit(now, vel, 1100 + buildProgress * 2200);
      }
      return;
    }

    // "groove" or "mashup" phase
    this.deck1.setEdmRemixMode(true, cleanMode);
    this.deck2.setEdmRemixMode(true, cleanMode);

    // 1. 4-on-the-Floor Tomorrowland Mainstage Kick + Sidechain (Pads 1-4: Steps 0, 4, 8, 12)
    if (stepInBar16 % 4 === 0) {
      if (pad5to8Fx) {
        this._triggerEdmKick(now, 0.76, true);
        const pumpDepth = isElectroBounceChapter ? 0.74 : 0.66;
        this.deck1.triggerSidechainPump(beatSec, pumpDepth);
        this.deck2.triggerSidechainPump(beatSec, pumpDepth);
      } else {
        // Default Clean Mode: gentle warm sub-kick pulse (no harsh 1.6kHz click) & subtle musical sidechain
        this._triggerEdmKick(now, 0.46, false);
        this.deck1.triggerSidechainPump(beatSec, 0.36);
        this.deck2.triggerSidechainPump(beatSec, 0.36);
      }
    }

    // Pads 5, 6, 7, 8 Effects (Off-Beat Hi-Hat Noise, Synth Sub-Pulse & Noise Claps) — OFF by default!
    if (!pad5to8Fx) {
      return;
    }

    // 2. Tomorrowland Stadium Clap on Beats 2 & 4 + 4-Bar Phrase Turnaround Double-Clap Fill!
    if (stepInBar16 === 4 || stepInBar16 === 12) {
      this._triggerEdmClap(now, 0.30);
    } else if (barInCycle % 4 === 3 && (stepInBar16 === 14 || stepInBar16 === 15)) {
      this._triggerEdmClap(now, 0.22);
    }

    // 3. Off-Beat House Open Hi-Hat ("ts" on &) + Tonic Sub-Pulse (Pads 5, 6, 7, 8)
    if (stepInBar16 % 4 === 2) {
      this._triggerEdmHiHat(now, true, 0.17);
      this._triggerEdmSubPulse(now, tonicSub, beatSec * 0.44, isElectroBounceChapter ? 0.36 : 0.28);
    } else if (stepInBar16 % 2 === 1) {
      this._triggerEdmHiHat(now, false, 0.065);
      if (isElectroBounceChapter && (stepInBar16 === 7 || stepInBar16 === 15)) {
        this._triggerEdmSubPulse(now, tonicSub, beatSec * 0.20, 0.22);
      }
    }
  }

  _triggerEdmSubPulse(now, freq, durSec = 0.2, gainVal = 0.3) {
    const ctx = this.ctx;
    const subOsc = ctx.createOscillator();
    const g = ctx.createGain();
    subOsc.type = "sine";
    subOsc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(0.005, now);
    g.gain.linearRampToValueAtTime(gainVal, now + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, now + durSec);
    subOsc.connect(g);
    g.connect(this.samplerGain);
    subOsc.start(now);
    subOsc.stop(now + durSec + 0.01);
  }

  _triggerEdmKick(now, gainVal = 0.78, withClickTransient = true) {
    const ctx = this.ctx;
    // Sub/Body Oscillator (158Hz -> 46Hz punch)
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(158, now);
    osc.frequency.exponentialRampToValueAtTime(46, now + 0.062);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.24);

    g.gain.setValueAtTime(gainVal, now);
    g.gain.setValueAtTime(gainVal * 0.9, now + 0.07);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    osc.connect(g);
    g.connect(this.samplerGain);
    osc.start(now);
    osc.stop(now + 0.26);

    if (!withClickTransient) return;

    // Top Click Transient for Festival Kick Definition
    const clickOsc = ctx.createOscillator();
    const clickGain = ctx.createGain();
    clickOsc.type = "triangle";
    clickOsc.frequency.setValueAtTime(1600, now);
    clickOsc.frequency.exponentialRampToValueAtTime(140, now + 0.016);
    clickGain.gain.setValueAtTime(gainVal * 0.35, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.018);
    clickOsc.connect(clickGain);
    clickGain.connect(this.samplerGain);
    clickOsc.start(now);
    clickOsc.stop(now + 0.02);
  }

  _triggerEdmClap(now, gainVal = 0.32) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 0.16);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        // Multi-burst hand-clap envelope
        const burst =
          t < 0.01 ? 1.0 : t < 0.02 ? 0.85 : t < 0.03 ? 0.95 : Math.exp(-(t - 0.03) * 26);
        d[i] = (Math.random() * 2 - 1) * burst;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1350;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.value = gainVal;
    src.connect(bp);
    bp.connect(g);
    g.connect(this.samplerGain);
    src.start(now);
  }

  _triggerEdmHiHat(now, isOpen = true, gainVal = 0.18) {
    const ctx = this.ctx;
    const dur = isOpen ? 0.19 : 0.055;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    const decay = isOpen ? 16 : 55;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        d[i] = (Math.random() * 2 - 1) * Math.exp(-t * decay);
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 6800;
    const g = ctx.createGain();
    g.gain.value = gainVal;
    src.connect(hp);
    hp.connect(g);
    g.connect(this.samplerGain);
    src.start(now);
  }

  _triggerEdmBassNote(now, freq, durSec = 0.2, gainVal = 0.42) {
    const ctx = this.ctx;
    // Sub Sine + Electro Saw Harmonics through Low-Pass Envelope Filter
    const subOsc = ctx.createOscillator();
    const sawOsc = ctx.createOscillator();
    subOsc.type = "sine";
    sawOsc.type = "sawtooth";
    subOsc.frequency.setValueAtTime(freq, now);
    sawOsc.frequency.setValueAtTime(freq * 2.0, now);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 2.4;
    lp.frequency.setValueAtTime(620, now);
    lp.frequency.exponentialRampToValueAtTime(160, now + durSec * 0.9);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.01, now);
    g.gain.linearRampToValueAtTime(gainVal, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, now + durSec);

    const sawGain = ctx.createGain();
    sawGain.gain.value = 0.35;

    subOsc.connect(lp);
    sawOsc.connect(sawGain);
    sawGain.connect(lp);
    lp.connect(g);
    g.connect(this.samplerGain);

    subOsc.start(now);
    sawOsc.start(now);
    subOsc.stop(now + durSec + 0.01);
    sawOsc.stop(now + durSec + 0.01);
  }

  _triggerEdmSupersawStab(now, baseFreq, gainVal = 0.16) {
    const ctx = this.ctx;
    const dur = 0.21;
    // Power Chord + Octave (Root, Fifth 1.498x, Octave 2.0x) with subtle stereo detune
    const notes = [1.0, 1.005, 1.498, 2.0, 1.994];
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(4200, now);
    lp.frequency.exponentialRampToValueAtTime(1200, now + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.005, now);
    g.gain.linearRampToValueAtTime(gainVal / notes.length, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);

    lp.connect(g);
    g.connect(this.samplerGain);

    notes.forEach((ratio) => {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(baseFreq * ratio, now);
      osc.connect(lp);
      osc.start(now);
      osc.stop(now + dur + 0.01);
    });
  }

  _triggerEdmSnareBuildHit(now, gainVal = 0.22, hpFreq = 700) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 0.11);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.032));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = hpFreq;
    const g = ctx.createGain();
    g.gain.value = gainVal;
    src.connect(hp);
    hp.connect(g);
    g.connect(this.samplerGain);
    src.start(now);
  }

  // ==================== MICROPHONE & RECORDER ====================
  async toggleMicrophone() {
    this.resume();
    if (this.micActive) {
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => t.stop());
      }
      if (this.micSource) this.micSource.disconnect();
      this.micActive = false;
      this.masterBus.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.1);
      return false;
    }

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micSource = this.ctx.createMediaStreamSource(this.micStream);
      this.micGain = this.ctx.createGain();
      this.micGain.gain.value = 1.2;
      this.micSource.connect(this.micGain);
      this.micGain.connect(this.masterCompressor);
      this.micActive = true;
      // Talkover ducking
      this.masterBus.gain.setTargetAtTime(0.65, this.ctx.currentTime, 0.1);
      return true;
    } catch (err) {
      alert("マイクへのアクセスが許可されていないか、利用できません: " + err.message);
      return false;
    }
  }

  pickBestRecorderFormat(hasVideo = true) {
    if (typeof MediaRecorder === "undefined") {
      return { mimeType: "", blobType: hasVideo ? "video/mp4" : "audio/webm", ext: hasVideo ? "mp4" : "webm" };
    }
    const candidates = hasVideo
      ? [
          { mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", blob: "video/mp4", ext: "mp4" },
          { mime: "video/mp4;codecs=h264,aac", blob: "video/mp4", ext: "mp4" },
          { mime: "video/mp4", blob: "video/mp4", ext: "mp4" },
          { mime: "video/webm;codecs=vp9,opus", blob: "video/webm", ext: "webm" },
          { mime: "video/webm;codecs=vp8,opus", blob: "video/webm", ext: "webm" },
          { mime: "video/webm", blob: "video/webm", ext: "webm" }
        ]
      : [
          { mime: "audio/mp4;codecs=mp4a.40.2", blob: "audio/mp4", ext: "m4a" },
          { mime: "audio/mp4", blob: "audio/mp4", ext: "m4a" },
          { mime: "audio/webm;codecs=opus", blob: "audio/webm", ext: "webm" },
          { mime: "audio/webm", blob: "audio/webm", ext: "webm" }
        ];

    for (const c of candidates) {
      try {
        if (typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(c.mime)) {
          return { mimeType: c.mime, blobType: c.blob, ext: c.ext };
        }
      } catch (_) {}
    }
    return {
      mimeType: "",
      blobType: hasVideo ? "video/webm" : "audio/webm",
      ext: hasVideo ? "webm" : "webm"
    };
  }

  startRecordingSession({ videoStream = null, stopVideoTracksOnEnd = true, onComplete = null, onExternalStop = null } = {}) {
    this.resume();
    if (this.isRecording) return false;
    if (typeof MediaRecorder === "undefined") {
      alert("お使いのブラウザは録画・録音機能 (MediaRecorder) に対応していません。");
      return false;
    }

    const videoTracks = videoStream ? videoStream.getVideoTracks() : [];
    const hasVideo = videoTracks.length > 0;
    const audioTracks = this.recordDest.stream.getAudioTracks();
    const combinedStream = new MediaStream([...videoTracks, ...audioTracks]);

    const fmt = this.pickBestRecorderFormat(hasVideo);
    let recorder = null;
    try {
      const opts = {};
      if (fmt.mimeType) opts.mimeType = fmt.mimeType;
      if (hasVideo) {
        opts.videoBitsPerSecond = 4500000;
        opts.audioBitsPerSecond = 192000;
      } else {
        opts.audioBitsPerSecond = 192000;
      }
      recorder = new MediaRecorder(combinedStream, opts);
    } catch (_) {
      recorder = fmt.mimeType
        ? new MediaRecorder(combinedStream, { mimeType: fmt.mimeType })
        : new MediaRecorder(combinedStream);
    }

    this.recordedChunks = [];
    this.mediaRecorder = recorder;
    this._activeRecVideoStream = videoStream;
    this._stopVideoTracksOnEnd = stopVideoTracksOnEnd;

    if (videoTracks[0]) {
      videoTracks[0].addEventListener(
        "ended",
        () => {
          if (this.isRecording) {
            this.stopRecordingSession();
            if (typeof onExternalStop === "function") onExternalStop();
          }
        },
        { once: true }
      );
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
    };

    recorder.onstop = () => {
      if (this._activeRecVideoStream && this._stopVideoTracksOnEnd) {
        try {
          this._activeRecVideoStream.getTracks().forEach((t) => t.stop());
        } catch (_) {}
      }
      this._activeRecVideoStream = null;
      this.isRecording = false;

      const actualType = recorder.mimeType || fmt.blobType || (hasVideo ? "video/mp4" : "audio/webm");
      const isMp4 = actualType.includes("mp4");
      const ext = hasVideo ? (isMp4 ? "mp4" : "webm") : (isMp4 ? "m4a" : "webm");
      const blob = new Blob(this.recordedChunks, { type: actualType });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const prefix = hasVideo ? "DDJ_FLX4_Video" : "DDJ_FLX4_AudioMix";
      const filename = `${prefix}_${stamp}.${ext}`;

      if (typeof onComplete === "function") {
        onComplete({ url, blob, ext, mimeType: actualType, isVideo: hasVideo, filename });
      }
    };

    recorder.start(1000);
    this.isRecording = true;
    return true;
  }

  stopRecordingSession() {
    if (!this.isRecording || !this.mediaRecorder) return false;
    this.isRecording = false;
    try {
      if (this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.stop();
      }
    } catch (_) {}
    return true;
  }

  toggleRecording(onCompleteCallback) {
    if (this.isRecording) {
      this.stopRecordingSession();
      return false;
    }
    return this.startRecordingSession({
      videoStream: null,
      onComplete: (res) => {
        if (onCompleteCallback) onCompleteCallback(res.url, res);
      }
    });
  }

  // Built-in demo tracks removed per user request — 100% free user track selection
  _generateBuiltInDemoTracks() {
    return [];
  }
}

window.DDJFlx4AudioEngine = DDJFlx4AudioEngine;
