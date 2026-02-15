// ─── Protobuf Setup ──────────────────────────────────────────────────
const PROTO_DEF = `
syntax = "proto3";
package pipecat;
message TextFrame {
  uint64 id = 1;
  string name = 2;
  string text = 3;
}
message AudioRawFrame {
  uint64 id = 1;
  string name = 2;
  bytes audio = 3;
  uint32 sample_rate = 4;
  uint32 num_channels = 5;
}
message TranscriptionFrame {
  uint64 id = 1;
  string name = 2;
  string text = 3;
  string user_id = 4;
  string timestamp = 5;
}
message MessageFrame {
  string data = 1;
}
message Frame {
  oneof frame {
    TextFrame text = 1;
    AudioRawFrame audio = 2;
    TranscriptionFrame transcription = 3;
    MessageFrame message = 4;
  }
}`;

const root = protobuf.parse(PROTO_DEF).root;
const FrameMsg = root.lookupType("pipecat.Frame");

// ─── DOM ─────────────────────────────────────────────────────────────
const startBtn    = document.getElementById("startBtn");
const muteBtn     = document.getElementById("muteBtn");
const volumeEl    = document.getElementById("volume");
const connDot     = document.getElementById("connDot");
const connLabel   = document.getElementById("connLabel");
const stateLabel  = document.getElementById("stateLabel");
const transcriptEl = document.getElementById("transcript");
const canvas      = document.getElementById("visualizer");
const ctx         = canvas.getContext("2d");

// ─── State ───────────────────────────────────────────────────────────
let ws          = null;
let running     = false;
let muted       = false;
let stream      = null;
let audioCtx    = null;
let analyser    = null;   // Playback analyser (connected to destination)
let micAnalyser = null;   // Mic analyser (visualization only, never to speakers)
let sourceNode  = null;
let workletNode = null;
let currentState = "idle";
let nativeSampleRate = 48000;

// Playback queue
let playbackQueue   = [];
let isPlaying       = false;
let activeSource    = null;
let bargeInTime     = 0;  // Timestamp of last barge-in to ignore trailing server audio

// ─── Audio Worklet Processor (inline) ────────────────────────────────
const workletCode = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.sendSize = Math.floor(sampleRate / 10);  // ~100ms chunks
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this.buffer.push(ch[i]);
    }
    while (this.buffer.length >= this.sendSize) {
      const chunk = this.buffer.splice(0, this.sendSize);
      const int16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        let s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);
`;

// ─── Visualizer ──────────────────────────────────────────────────────
let animId = null;
const W = canvas.width, H = canvas.height;
const CX = W / 2, CY = H / 2;
const BASE_R = 80;

function drawVisualizer() {
  animId = requestAnimationFrame(drawVisualizer);
  ctx.clearRect(0, 0, W, H);

  let dataArray;
  let avg = 0;
  // Use playback analyser when speaking, mic analyser otherwise
  const activeAnalyser = isPlaying ? analyser : micAnalyser;
  if (activeAnalyser) {
    dataArray = new Uint8Array(activeAnalyser.frequencyBinCount);
    activeAnalyser.getByteFrequencyData(dataArray);
    for (let i = 0; i < dataArray.length; i++) avg += dataArray[i];
    avg /= dataArray.length;
  }

  const pulse = avg / 255;
  const r = BASE_R + pulse * 40;
  const bars = 64;

  const grad = ctx.createRadialGradient(CX, CY, r * 0.5, CX, CY, r + 30);
  let color;
  switch (currentState) {
    case "listening":  color = "52, 211, 153"; break;
    case "processing": color = "251, 191, 36"; break;
    case "speaking":   color = "167, 139, 250"; break;
    default:           color = "108, 99, 255";
  }
  grad.addColorStop(0, `rgba(${color}, 0.15)`);
  grad.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.beginPath();
  ctx.arc(CX, CY, r, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${color}, 0.6)`;
  ctx.lineWidth = 2;
  ctx.stroke();

  if (dataArray) {
    const step = Math.floor(dataArray.length / bars);
    for (let i = 0; i < bars; i++) {
      const val = dataArray[i * step] / 255;
      const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const len = 4 + val * 30;
      const x1 = CX + Math.cos(angle) * (r + 4);
      const y1 = CY + Math.sin(angle) * (r + 4);
      const x2 = CX + Math.cos(angle) * (r + 4 + len);
      const y2 = CY + Math.sin(angle) * (r + 4 + len);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = `rgba(${color}, ${0.3 + val * 0.7})`;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.stroke();
    }
  }

  ctx.beginPath();
  ctx.arc(CX, CY, 4 + pulse * 3, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${color}, 0.8)`;
  ctx.fill();
}

// ─── Protobuf encode/decode ──────────────────────────────────────────
function encodeAudioFrame(pcmBuffer, sampleRate) {
  const frame = FrameMsg.create({
    audio: {
      id: 0,
      name: "audio",
      audio: new Uint8Array(pcmBuffer),
      sampleRate: sampleRate,
      numChannels: 1,
    }
  });
  return FrameMsg.encode(frame).finish();
}

function decodeFrame(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  try {
    const frame = FrameMsg.decode(data);
    if (frame.audio && frame.audio.audio && frame.audio.audio.length > 0) {
      return { type: "audio", audio: frame.audio };
    } else if (frame.transcription && frame.transcription.text) {
      return { type: "transcription", text: frame.transcription.text, userId: frame.transcription.userId };
    } else if (frame.text && frame.text.text) {
      return { type: "text", text: frame.text.text };
    } else if (frame.message && frame.message.data) {
      try {
        return { type: "message", data: JSON.parse(frame.message.data) };
      } catch {
        return { type: "message", data: frame.message.data };
      }
    }
    return null;
  } catch(e) {
    console.error("[DECODE] Protobuf decode error:", e);
    return null;
  }
}

// ─── Audio Playback ──────────────────────────────────────────────────
function queueAudioForPlayback(audioFrame) {
  // After barge-in, discard trailing server audio for 2 seconds
  if (Date.now() - bargeInTime < 2000) return;

  const bytes = audioFrame.audio;
  // Copy to aligned buffer (protobufjs may return unaligned Uint8Array)
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  const int16 = new Int16Array(aligned.buffer);
  const sampleRate = audioFrame.sampleRate || 24000;

  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  playbackQueue.push({ samples: float32, sampleRate });
  if (!isPlaying) playNextChunk();
}

function playNextChunk() {
  if (!audioCtx || playbackQueue.length === 0) {
    isPlaying = false;
    activeSource = null;
    if (currentState === "speaking") {
      currentState = "idle";
      updateStateUI("idle");
    }
    return;
  }

  isPlaying = true;
  if (currentState !== "speaking") {
    currentState = "speaking";
    updateStateUI("speaking");
  }

  const { samples, sampleRate } = playbackQueue.shift();
  const buf = audioCtx.createBuffer(1, samples.length, sampleRate);
  buf.getChannelData(0).set(samples);

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  activeSource = src;

  const vol = audioCtx.createGain();
  vol.gain.value = parseFloat(volumeEl.value);
  src.connect(vol);
  vol.connect(analyser);
  analyser.connect(audioCtx.destination);

  src.onended = () => playNextChunk();
  src.start();
}

function stopPlayback() {
  playbackQueue = [];
  bargeInTime = Date.now();  // Mark barge-in time to ignore trailing server audio
  if (activeSource) {
    try { activeSource.stop(); } catch(e) {}
    activeSource = null;
  }
  isPlaying = false;
  if (currentState === "speaking") {
    currentState = "idle";
    updateStateUI("idle");
  }
}

// ─── WebSocket ───────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    connDot.classList.add("connected");
    connLabel.textContent = "Connected";
    stateLabel.textContent = "Ready";
    stateLabel.className = "state-label";
  };

  ws.onclose = () => {
    connDot.classList.remove("connected");
    connLabel.textContent = "Disconnected";
    if (running) setTimeout(connectWS, 2000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const decoded = decodeFrame(ev.data);
    if (!decoded) return;

    switch (decoded.type) {
      case "audio":
        queueAudioForPlayback(decoded.audio);
        break;
      case "transcription":
        if (decoded.text) {
          // User transcription from STT
          addMessage("user", decoded.text);
        }
        break;
      case "text":
        if (decoded.text) {
          // Assistant response text
          addMessage("assistant", decoded.text);
        }
        break;
      case "message":
        console.log("Message from server:", decoded.data);
        break;
    }
  };
}

// ─── UI ──────────────────────────────────────────────────────────────
function updateStateUI(state) {
  stateLabel.className = "state-label " + state;
  const labels = {
    idle: "Ready",
    listening: "Listening…",
    processing: "Thinking…",
    speaking: "Speaking…",
  };
  stateLabel.textContent = labels[state] || state;
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const roleSpan = document.createElement("span");
  roleSpan.className = "role";
  roleSpan.textContent = role === "user" ? "You" : role === "assistant" ? "AI" : "System";
  div.appendChild(roleSpan);
  div.appendChild(document.createTextNode(text));
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ─── Start / Stop ────────────────────────────────────────────────────
async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (e) {
    alert("Microphone permission denied");
    return;
  }

  audioCtx = new AudioContext();
  nativeSampleRate = audioCtx.sampleRate;
  console.log("Native sample rate:", nativeSampleRate);

  // Playback analyser — routes TTS audio to speakers
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;

  // Mic analyser — visualization only, NEVER connected to destination
  micAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 256;

  sourceNode = audioCtx.createMediaStreamSource(stream);
  sourceNode.connect(micAnalyser);

  const blob = new Blob([workletCode], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await audioCtx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  workletNode = new AudioWorkletNode(audioCtx, "pcm-processor");
  sourceNode.connect(workletNode);

  let bargeInCount = 0;
  const BARGE_IN_THRESHOLD = 5000;  // Int16 amplitude threshold (well above echo level)
  const BARGE_IN_CHUNKS = 3;        // Consecutive loud chunks to trigger

  workletNode.port.onmessage = (ev) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || muted) return;

    const inputInt16 = new Int16Array(ev.data);

    // Measure max amplitude for barge-in detection
    let maxAmp = 0;
    for (let i = 0; i < inputInt16.length; i += 16) {
      const v = Math.abs(inputInt16[i]);
      if (v > maxAmp) maxAmp = v;
    }

    // While bot is speaking: DON'T send audio to server (prevents false VAD triggers)
    // But DO check for genuine user barge-in
    if (isPlaying) {
      if (maxAmp > BARGE_IN_THRESHOLD) {
        bargeInCount++;
        if (bargeInCount >= BARGE_IN_CHUNKS) {
          // User is genuinely speaking - stop playback and let audio through
          stopPlayback();
          bargeInCount = 0;
        }
      } else {
        bargeInCount = 0;
      }
      // Don't send audio to server while bot is speaking - prevents echo→VAD→garbage STT
      return;
    }

    bargeInCount = 0;

    // After barge-in, skip audio for 500ms to let speaker echo die down
    if (Date.now() - bargeInTime < 500) return;

    // Resample from native rate (e.g. 48kHz) to 16kHz for Pipecat VAD/STT
    const TARGET_RATE = 16000;
    const ratio = nativeSampleRate / TARGET_RATE;
    const outputLen = Math.floor(inputInt16.length / ratio);
    const outputInt16 = new Int16Array(outputLen);
    for (let i = 0; i < outputLen; i++) {
      const srcIdx = i * ratio;
      const idx = Math.floor(srcIdx);
      const frac = srcIdx - idx;
      if (idx + 1 < inputInt16.length) {
        outputInt16[i] = Math.round(inputInt16[idx] * (1 - frac) + inputInt16[idx + 1] * frac);
      } else {
        outputInt16[i] = inputInt16[idx];
      }
    }
    const encoded = encodeAudioFrame(outputInt16.buffer, TARGET_RATE);
    ws.send(encoded);
  };

  running = true;
  connectWS();
  drawVisualizer();

  startBtn.textContent = "Stop";
  startBtn.classList.add("active");
  muteBtn.disabled = false;
}

function stop() {
  running = false;

  if (ws) { ws.close(); ws = null; }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  stopPlayback();
  if (audioCtx) { audioCtx.close(); audioCtx = null; analyser = null; micAnalyser = null; }
  if (animId) { cancelAnimationFrame(animId); animId = null; }

  ctx.clearRect(0, 0, W, H);
  startBtn.textContent = "Start";
  startBtn.classList.remove("active");
  muteBtn.disabled = true;
  connDot.classList.remove("connected");
  connLabel.textContent = "Disconnected";
  stateLabel.textContent = "Press Start";
  stateLabel.className = "state-label";
}

// ─── Event listeners ─────────────────────────────────────────────────
startBtn.addEventListener("click", () => running ? stop() : start());

muteBtn.addEventListener("click", () => {
  muted = !muted;
  muteBtn.classList.toggle("muted", muted);
  muteBtn.title = muted ? "Unmute" : "Mute";
});
