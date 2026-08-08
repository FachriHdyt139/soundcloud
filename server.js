const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const scdl = require('scdl-core');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

let isScdlConnected = false;
async function initScdl() {
    try {
        await scdl.connect();
        isScdlConnected = true;
        console.log('Berhasil terhubung ke SoundCloud API');
    } catch (err) {
        console.error('Gagal inisialisasi Client ID SoundCloud:', err);
    }
}
initScdl();

io.on('connection', (socket) => {
    console.log('Client terhubung:', socket.id);

    socket.on('start_download', async (inputUrl) => {
        try {
            if (!inputUrl) {
                return socket.emit('error', 'URL tidak boleh kosong!');
            }

            let url = inputUrl.trim();
            if (!/^https?:\/\//i.test(url)) {
                url = 'https://' + url;
            }

            let finalUrl = url;

            // [FITUR BARU] Mengekstrak link on.soundcloud.com menjadi link asli
            if (url.includes('on.soundcloud.com')) {
                socket.emit('info', 'Mengekstrak link pendek...');
                try {
                    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
                    finalUrl = response.url; // Mendapatkan link panjang aslinya
                    
                    // Membersihkan parameter tambahan (misal: ?si=xxx)
                    finalUrl = finalUrl.split('?')[0]; 
                    console.log('Link berhasil diekstrak menjadi:', finalUrl);
                } catch (err) {
                    console.error('Gagal mengekstrak link:', err);
                    return socket.emit('error', 'Gagal memproses link pendek. Coba copy link panjangnya langsung.');
                }
            }

            // Validasi link panjang (wajib soundcloud.com/...)
            const scRegex = /^(https?:\/\/)?(www\.)?soundcloud\.com\/.+\/.+$/i;
            if (!scRegex.test(finalUrl)) {
                return socket.emit('error', 'Format URL SoundCloud tidak dikenali!');
            }

            socket.emit('info', 'Mengambil data lagu...');

            if (!isScdlConnected) {
                await scdl.connect();
                isScdlConnected = true;
            }

            // Gunakan finalUrl yang sudah berupa link panjang
            const trackInfo = await scdl.getInfo(finalUrl);
            const title = (trackInfo.title || 'SoundCloud_Track').replace(/[^a-zA-Z0-9_\-\s]/g, "");
            const fileName = `${title}_${Date.now()}.mp3`;
            const filePath = path.join(DOWNLOAD_DIR, fileName);

            const stream = await scdl.download(finalUrl);
            const fileStream = fs.createWriteStream(filePath);

            const durationSec = (trackInfo.duration || 0) / 1000;
            const estimatedSize = durationSec > 0 ? (128 * 1000 * durationSec) / 8 : 5 * 1024 * 1024;

            let downloaded = 0;
            const startTime = Date.now();

            stream.on('data', (chunk) => {
                downloaded += chunk.length;
                const elapsedTime = (Date.now() - startTime) / 1000 || 0.001;
                
                const speedBps = downloaded / elapsedTime;
                const speedMBps = (speedBps / (1024 * 1024)).toFixed(2);
                
                const progress = Math.min((downloaded / estimatedSize) * 100, 99).toFixed(1);
                const remainingBytes = estimatedSize - downloaded;
                const etaSec = remainingBytes > 0 && speedBps > 0 ? (remainingBytes / speedBps).toFixed(0) : 0;
                
                const sizeMB = (estimatedSize / (1024 * 1024)).toFixed(2);
                const downloadedMB = (downloaded / (1024 * 1024)).toFixed(2);

                socket.emit('progress', {
                    progress,
                    speedMBps,
                    etaSec,
                    downloadedMB,
                    sizeMB,
                    title: trackInfo.title || title
                });
            });

            stream.pipe(fileStream);

            fileStream.on('finish', () => {
                socket.emit('progress', { 
                    progress: 100, 
                    speedMBps: "0.00", 
                    etaSec: 0, 
                    title: trackInfo.title || title 
                });
                
                socket.emit('done', {
                    downloadUrl: `/download-file/${encodeURIComponent(fileName)}`,
                    fileName
                });
            });

            stream.on('error', (err) => {
                console.error('Stream error:', err);
                socket.emit('error', 'Gagal memproses lagu (Kemungkinan akses dibatasi).');
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            });

        } catch (error) {
            console.error('Download error detail:', error);
            socket.emit('error', 'Gagal mengambil data lagu. Coba link SoundCloud lain.');
        }
    });
});

app.get('/download-file/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(DOWNLOAD_DIR, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath, fileName, (err) => {
            if (err) console.error("Error sending file:", err);
            fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr) console.error("Gagal menghapus file temp:", unlinkErr);
            });
        });
    } else {
        res.status(404).send('File sudah kadaluarsa atau tidak ditemukan.');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server SoundCloud Downloader aktif pada port ${PORT}`);
});
