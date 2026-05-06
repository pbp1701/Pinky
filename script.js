const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const convertBtn = document.getElementById('convert-btn');
const clearBtn = document.getElementById('clear-btn');
const bitrateSelect = document.getElementById('bitrate');
const fileList = document.getElementById('file-list');

let selectedFiles = [];

function updateButtons() {
  const hasFiles = selectedFiles.length > 0;
  convertBtn.disabled = !hasFiles;
  clearBtn.disabled = !hasFiles;
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function createFileCard(file) {
  const card = document.createElement('div');
  card.className = 'file-card';

  const title = document.createElement('strong');
  title.textContent = file.name;

  const meta = document.createElement('div');
  meta.className = 'file-meta';
  meta.textContent = `${formatBytes(file.size)} · ${file.type || getFallbackType(file)}`;

  const status = document.createElement('div');
  status.className = 'file-meta';
  status.textContent = 'Ready to convert';

  const link = document.createElement('a');
  link.href = '#';
  link.textContent = 'Download MP3';
  link.style.display = 'none';
  link.target = '_blank';

  card.append(title, meta, status, link);
  return { card, status, link };
}

function showFiles(files) {
  fileList.innerHTML = '';
  selectedFiles = Array.from(files).filter(isSupportedInputFile);

  selectedFiles = selectedFiles.map((file) => {
    const fileView = createFileCard(file);
    fileList.appendChild(fileView.card);
    return { file, ...fileView };
  });

  updateButtons();
}

function isSupportedInputFile(file) {
  const fileName = file.name.toLowerCase();
  return (
    file.type === 'audio/wav'
    || file.type === 'audio/mp4'
    || file.type === 'video/mp4'
    || fileName.endsWith('.wav')
    || fileName.endsWith('.mp4')
    || fileName.endsWith('.m4v')
  );
}

function getFallbackType(file) {
  const fileName = file.name.toLowerCase();
  if (fileName.endsWith('.wav')) return 'audio/wav';
  if (fileName.endsWith('.mp4') || fileName.endsWith('.m4v')) return 'video/mp4';
  return 'audio file';
}

function getOutputFileName(fileName) {
  return fileName.replace(/\.(wav|mp4|m4v)$/i, '.mp3');
}

async function parseWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.getUint32(0, false) !== 0x52494646) throw new Error('Invalid WAV file');
  if (view.getUint32(8, false) !== 0x57415645) throw new Error('Invalid WAV file');

  let offset = 12;
  let audioFormat, numChannels, sampleRate, bitsPerSample, dataChunkOffset, dataChunkSize;

  while (offset < view.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === 0x666d7420) {
      audioFormat = view.getUint16(chunkDataOffset, true);
      numChannels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
    }

    if (chunkId === 0x64617461) {
      dataChunkOffset = chunkDataOffset;
      dataChunkSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize;
  }

  if (audioFormat !== 1) throw new Error('Only PCM WAV is supported');
  if (!dataChunkOffset) throw new Error('Missing data chunk');
  if (bitsPerSample !== 16) throw new Error('Only 16-bit WAV is supported');

  const totalSamples = dataChunkSize / 2;
  const channelSampleCount = totalSamples / numChannels;
  const samples = new Int16Array(arrayBuffer, dataChunkOffset, totalSamples);
  const left = new Int16Array(channelSampleCount);
  const right = numChannels === 2 ? new Int16Array(channelSampleCount) : null;

  for (let i = 0, j = 0; i < samples.length; i += numChannels, j += 1) {
    left[j] = samples[i];
    if (numChannels === 2 && right) {
      right[j] = samples[i + 1];
    }
  }

  return {
    sampleRate,
    numChannels,
    left,
    right,
  };
}

function convertFloat32ToInt16(float32Samples) {
  const int16Samples = new Int16Array(float32Samples.length);

  for (let i = 0; i < float32Samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Samples[i]));
    int16Samples[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return int16Samples;
}

async function decodeMediaFile(arrayBuffer) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error('This browser does not support MP4 audio decoding');
  }

  const audioContext = new AudioContextClass();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  await audioContext.close();

  const numChannels = Math.min(audioBuffer.numberOfChannels, 2);
  const left = convertFloat32ToInt16(audioBuffer.getChannelData(0));
  const right = numChannels === 2 ? convertFloat32ToInt16(audioBuffer.getChannelData(1)) : null;

  return {
    sampleRate: audioBuffer.sampleRate,
    numChannels,
    left,
    right,
  };
}

async function decodeInputFile(file, arrayBuffer) {
  if (file.name.toLowerCase().endsWith('.wav') || file.type === 'audio/wav') {
    return parseWav(arrayBuffer);
  }

  return decodeMediaFile(arrayBuffer);
}

function encodeMp3(audioData, bitrate) {
  const mp3Encoder = new lamejs.Mp3Encoder(audioData.numChannels, audioData.sampleRate, bitrate);
  const left = audioData.left;
  const right = audioData.right;
  const blockSize = 1152;
  const mp3Data = [];

  for (let i = 0; i < left.length; i += blockSize) {
    const leftChunk = left.subarray ? left.subarray(i, i + blockSize) : left.slice(i, i + blockSize);
    let mp3buf;
    if (audioData.numChannels === 2 && right) {
      const rightChunk = right.subarray ? right.subarray(i, i + blockSize) : right.slice(i, i + blockSize);
      mp3buf = mp3Encoder.encodeBuffer(leftChunk, rightChunk);
    } else {
      mp3buf = mp3Encoder.encodeBuffer(leftChunk);
    }
    if (mp3buf.length > 0) mp3Data.push(mp3buf);
  }

  const tail = mp3Encoder.flush();
  if (tail.length > 0) mp3Data.push(tail);
  return new Blob(mp3Data, { type: 'audio/mpeg' });
}

async function convertFiles() {
  convertBtn.disabled = true;
  const bitrate = Number(bitrateSelect.value);

  for (const fileEntry of selectedFiles) {
    const { file, status, link } = fileEntry;
    status.textContent = 'Converting…';

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioData = await decodeInputFile(file, arrayBuffer);
      const mp3Blob = encodeMp3(audioData, bitrate);

      const url = URL.createObjectURL(mp3Blob);
      link.href = url;
      link.download = getOutputFileName(file.name);
      link.style.display = 'inline-block';
      status.textContent = 'Conversion complete';
    } catch (error) {
      status.textContent = `Conversion failed: ${error.message}`;
      console.error(error);
    }
  }

  convertBtn.disabled = false;
}

function handleDrop(event) {
  event.preventDefault();
  dropZone.classList.remove('dragover');
  const items = event.dataTransfer.files;
  if (items.length) {
    showFiles(items);
  }
}

fileInput.addEventListener('change', (event) => {
  if (event.target.files.length) showFiles(event.target.files);
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', handleDrop);

convertBtn.addEventListener('click', convertFiles);
clearBtn.addEventListener('click', () => {
  selectedFiles = [];
  fileList.innerHTML = '';
  fileInput.value = '';
  updateButtons();
});
