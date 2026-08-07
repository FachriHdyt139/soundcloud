const socket = io();

function startDownload() {
    const urlInput = document.getElementById('sc-url');
    const url = urlInput.value.trim();
    const statusMsg = document.getElementById('status-message');
    const progressContainer = document.getElementById('progress-container');
    const btn = document.getElementById('btn-download');

    if (!url) {
        statusMsg.innerText = "Masukkan link SoundCloud terlebih dahulu!";
        statusMsg.style.color = "#ff4444";
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Memproses...';
    statusMsg.innerText = "";
    progressContainer.classList.remove('hidden');
    document.getElementById('progress-bar').style.width = '0%';
    
    socket.emit('start_download', url);
}

socket.on('info', (msg) => {
    document.getElementById('track-title').innerText = msg;
});

socket.on('progress', (data) => {
    document.getElementById('track-title').innerText = data.title || "Mengunduh file...";
    document.getElementById('progress-bar').style.width = data.progress + '%';
    
    document.getElementById('speed').innerText = `${data.speedMBps} MB/s`;
    document.getElementById('eta').innerText = `${data.etaSec}s tersisa`;
    
    if (data.sizeMB && data.downloadedMB) {
        document.getElementById('size').innerText = `${data.downloadedMB} / ~${data.sizeMB} MB`;
    }
});

socket.on('done', (data) => {
    document.getElementById('track-title').innerText = "Selesai! Menyimpan file ke perangkat...";
    document.getElementById('btn-download').disabled = false;
    document.getElementById('btn-download').innerHTML = '<i class="fas fa-download"></i> Unduh Lagi';
    
    // Otomatis arahkan browser untuk menyimpan file
    window.location.href = data.downloadUrl;
});

socket.on('error', (msg) => {
    const statusMsg = document.getElementById('status-message');
    statusMsg.innerText = msg;
    statusMsg.style.color = "#ff4444";
    
    document.getElementById('progress-container').classList.add('hidden');
    document.getElementById('btn-download').disabled = false;
    document.getElementById('btn-download').innerHTML = '<i class="fas fa-download"></i> Unduh Now';
});