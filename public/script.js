const socket = io();

const tabBtns = document.querySelectorAll('.tab-btn');
const urlInput = document.getElementById('url-input');
const inputLabel = document.getElementById('input-label');
const downloadBtn = document.getElementById('download-btn');
const statusBox = document.getElementById('status-box');
const statusText = document.getElementById('status-text');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const speedEl = document.getElementById('speed');
const etaEl = document.getElementById('eta');
const previewBox = document.getElementById('preview-box');
const previewImg = document.getElementById('preview-img');
const previewTitle = document.getElementById('preview-title');
const downloadLinkBtn = document.getElementById('download-link-btn');
const totalDownloadsEl = document.getElementById('total-downloads');
const pasteBtn = document.getElementById('paste-btn');

let currentPlatform = 'soundcloud';

// Fetch statistik awal
fetch('/api/stats')
    .then(res => res.json())
    .then(data => {
        totalDownloadsEl.textContent = data.totalDownloads;
    });

// Ganti Tab Platform
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPlatform = btn.getAttribute('data-platform');
        
        if (currentPlatform === 'soundcloud') {
            inputLabel.textContent = 'Tempel Link SOUNDCLOUD:';
            urlInput.placeholder = 'https://soundcloud.com/...';
        } else if (currentPlatform === 'tiktok') {
            inputLabel.textContent = 'Tempel Link TIKTOK:';
            urlInput.placeholder = 'https://www.tiktok.com/...';
        }
        previewBox.classList.add('hidden');
        statusBox.classList.add('hidden');
    });
});

// Fitur Paste Otomatis
pasteBtn.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        urlInput.value = text;
    } catch (err) {
        alert('Gagal membaca clipboard. Izinkan akses atau paste secara manual.');
    }
});

// Aksi Klik Tombol Unduh
downloadBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) {
        alert('Harap masukkan URL terlebih dahulu!');
        return;
    }

    // Reset Tampilan Status
    statusBox.classList.remove('hidden');
    previewBox.classList.add('hidden');
    statusText.textContent = 'Menghubungkan ke server...';
    progressBar.style.width = '0%';

    socket.emit('start_download', { url, platform: currentPlatform });
});

// Socket Listeners
socket.on('info', (msg) => {
    statusText.textContent = msg;
});

socket.on('preview', (data) => {
    previewBox.classList.remove('hidden');
    previewTitle.textContent = data.title;
    previewImg.src = data.coverUrl;
});

socket.on('progress', (data) => {
    progressBar.style.width = data.progress + '%';
    speedEl.textContent = data.speedMBps;
    etaEl.textContent = data.etaSec + 's';
});

socket.on('done', (data) => {
    statusBox.classList.add('hidden');
    downloadLinkBtn.href = data.downloadUrl;
    previewBox.classList.remove('hidden');
});

socket.on('error', (errMsg) => {
    statusBox.classList.add('hidden');
    alert(errMsg);
});

socket.on('update_counter', (data) => {
    totalDownloadsEl.textContent = data.totalDownloads;
});
