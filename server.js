const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const scdl = require('soundcloud-downloader').default; // MENGGUNAKAN LIBRARY BARU
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

// Fungsi untuk bypass Shortlink & Mobile URL
async function getRealUrl(inputUrl) {
    let finalUrl = inputUrl;
    if (finalUrl.includes('on.soundcloud.com')) {
        try {
            const response = await fetch(finalUrl, { method: 'GET', redirect: 'follow' });
            finalUrl = response.url;
        } catch (err) {
            console.error("Gagal resolve shortlink:", err);
            throw new Error("Gagal membaca shortlink.");
        }
    }
    // Ubah link mobile ke desktop dan bersihkan parameter tracking
    return finalUrl.replace('m.soundcloud.com', 'soundcloud.com').split('?')[0];
}

io.on('connection', (socket) => {
    console.log('🔗 Client terhubung:', socket.id);

    socket.on('start_download', async (inputUrl) => {
        let filePath = '';

        try {
            if (!inputUrl) {
                return socket.emit('error', 'URL tidak boleh kosong!');
            }

            socket.emit('info', 'Memverifikasi link SoundCloud...');

            // Bersihkan & Pastikan ada HTTPS
            let url = inputUrl.trim();
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

            // Dapatkan URL Asli
            const finalUrl = await getRealUrl(url);
            console.log('🔄 Link siap diproses:', finalUrl);

            // Cek apakah URL benar-benar valid format SoundCloud-nya
            if (!scdl.isValidUrl(finalUrl)) {
                return socket.emit('error', 'Format URL tidak valid. Pastikan itu link lagu SoundCloud.');
            }

            socket.emit('info', 'Mengambil metadata lagu...');

            // Ambil Info Lagu menggunakan Engine Baru
            const trackInfo = await scdl.getInfo(finalUrl);
            if (!trackInfo || !trackInfo.title) {
                return socket.emit('error', 'Lagu tidak ditemukan atau diset Private.');
            }

            // Bersihkan nama file dari karakter aneh
            const title = trackInfo.title.replace(/[^a-zA-Z0-9_\-\s]/g, "").trim();
            const fileName = `${title}_${Date.now()}.mp3`;
            filePath = path.join(DOWNLOAD_DIR, fileName);

            socket.emit('info', `Mengunduh: ${title}...`);

            // Mulai Proses Download
            const stream = await scdl.downloadFormat(finalUrl, scdl.FORMATS.MP3);
            const fileStream = fs.createWriteStream(filePath);

            const durationSec = (trackInfo.duration || 0) / 1000;
            // Estimasi ukuran file
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
                console.log(`✅ Sukses mengunduh: ${fileName}`);
                socket.emit('progress', { progress: 100, speedMBps: "0.00", etaSec: 0, title });
                socket.emit('done', {
                    downloadUrl: `/download-file/${encodeURIComponent(fileName)}`,
                    fileName
                });
            });

            stream.on('error', (err) => {
                console.error('❌ Stream error:', err);
                socket.emit('error', 'Terjadi kesalahan saat memproses audio SoundCloud.');
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            });

        } catch (error) {
            console.error('❌ System Error:', error.message);
            socket.emit('error', 'Gagal memproses lagu. API mungkin sedang rate-limited. Coba beberapa saat lagi.');
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    });
});

// Route pengiriman file
app.get('/download-file/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(DOWNLOAD_DIR, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath, fileName, (err) => {
            if (err) console.error("❌ Error mengirim file:", err);
            fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr) console.error("⚠️ Gagal menghapus file sementara:", unlinkErr);
            });
        });
    } else {
        res.status(404).send('File tidak ditemukan atau sudah kadaluarsa.');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server SoundCloud Downloader (V2) aktif di port ${PORT}`);
});
