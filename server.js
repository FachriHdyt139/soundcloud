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

// Fungsi memastikan koneksi Client ID
async function ensureScdlConnection() {
    try {
        await scdl.connect();
        return true;
    } catch (err) {
        console.error('Gagal menghubungkan ke SoundCloud API:', err.message);
        return false;
    }
}
ensureScdlConnection().then(success => {
    if (success) console.log('✅ Berhasil terhubung ke SoundCloud API');
});

// Fungsi Ekstraktor URL Tingkat Lanjut (Bypass Mobile URL)
async function resolveAndFormatUrl(shortUrl) {
    try {
        // Ambil URL tujuan asli
        const response = await fetch(shortUrl, { method: 'GET', redirect: 'follow' });
        let finalUrl = response.url;
        
        // [KUNCI PERBAIKAN]: Paksa ubah m.soundcloud (mobile) jadi versi desktop
        finalUrl = finalUrl.replace('m.soundcloud.com', 'soundcloud.com');
        
        // Hapus parameter pelacakan (seperti ?si=...)
        return finalUrl.split('?')[0]; 
    } catch (err) {
        throw new Error('Gagal mengekstrak URL');
    }
}

io.on('connection', (socket) => {
    console.log('🔗 Client terhubung:', socket.id);

    socket.on('start_download', async (inputUrl) => {
        let finalUrl = '';
        let filePath = '';

        try {
            if (!inputUrl) {
                return socket.emit('error', 'URL tidak boleh kosong!');
            }

            socket.emit('info', 'Memverifikasi link...');

            let url = inputUrl.trim();
            if (!/^https?:\/\//i.test(url)) {
                url = 'https://' + url;
            }

            // Ekstrak jika itu link pendek, jika tidak langsung format
            if (url.includes('on.soundcloud.com')) {
                socket.emit('info', 'Mengekstrak link pendek...');
                try {
                    finalUrl = await resolveAndFormatUrl(url);
                    console.log('🔄 Link terekstrak & diformat menjadi:', finalUrl);
                } catch (err) {
                    return socket.emit('error', 'Gagal memproses link pendek. Coba gunakan link panjang dari browser.');
                }
            } else {
                // Walau bukan link pendek, tetap paksa ubah mobile ke desktop
                finalUrl = url.replace('m.soundcloud.com', 'soundcloud.com').split('?')[0];
            }

            // Regex baru yang lebih toleran namun tetap aman
            const scRegex = /^https?:\/\/(www\.)?soundcloud\.com\/[\w-]+\/.+/i;
            if (!scRegex.test(finalUrl)) {
                return socket.emit('error', 'Format link SoundCloud tidak valid atau tidak dikenali.');
            }

            socket.emit('info', 'Menghubungkan ke server SoundCloud...');
            await ensureScdlConnection();

            let trackInfo;
            try {
                // Ambil info menggunakan URL Desktop yang bersih
                trackInfo = await scdl.getInfo(finalUrl);
            } catch (infoErr) {
                console.error('❌ Gagal ambil info:', infoErr);
                return socket.emit('error', 'Gagal mengambil lagu dari server SoundCloud. Link mungkin kadaluarsa atau koneksi API diblokir sementara.');
            }

            const title = (trackInfo.title || 'SoundCloud_Audio').replace(/[^a-zA-Z0-9_\-\s]/g, "").trim();
            const fileName = `${title}_${Date.now()}.mp3`;
            filePath = path.join(DOWNLOAD_DIR, fileName);

            socket.emit('info', `Mulai mengunduh: ${title}...`);

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
                    progress, speedMBps, etaSec, downloadedMB, sizeMB, title
                });
            });

            stream.pipe(fileStream);

            fileStream.on('finish', () => {
                console.log(`✅ Unduhan selesai: ${fileName}`);
                socket.emit('progress', { progress: 100, speedMBps: "0.00", etaSec: 0, title });
                socket.emit('done', {
                    downloadUrl: `/download-file/${encodeURIComponent(fileName)}`,
                    fileName
                });
            });

            stream.on('error', (err) => {
                console.error('❌ Stream error:', err);
                socket.emit('error', 'Terjadi kesalahan jaringan saat mengunduh audio.');
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            });

        } catch (error) {
            console.error('❌ Fatal Error:', error);
            socket.emit('error', 'Sistem gagal memproses permintaan Anda saat ini.');
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    });
});

app.get('/download-file/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(DOWNLOAD_DIR, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath, fileName, (err) => {
            if (err) console.error("❌ Error mengirim file:", err);
            fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr) console.error("⚠️ Gagal menghapus file:", unlinkErr);
            });
        });
    } else {
        res.status(404).send('File sudah kadaluarsa atau tidak ditemukan.');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server berjalan stabil pada port ${PORT}`);
});
