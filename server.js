const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const scdl = require('soundcloud-downloader').default;
const youtubedl = require('youtube-dl-exec');
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

let totalDownloads = 1240;

app.get('/api/stats', (req, res) => {
    res.json({ totalDownloads });
});

io.on('connection', (socket) => {
    console.log('🔗 Client terhubung:', socket.id);

    socket.on('start_download', async (inputUrl) => {
        let filePath = '';

        try {
            if (!inputUrl) {
                return socket.emit('error', 'URL tidak boleh kosong!');
            }

            let url = inputUrl.trim();
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

            // ==========================================
            // CASE 1: DOWNLOAD SOUNDCLOUD
            // ==========================================
            if (url.includes('soundcloud.com') || url.includes('on.soundcloud.com')) {
                socket.emit('info', 'Memproses link SoundCloud...');
                
                let finalUrl = url;
                if (finalUrl.includes('on.soundcloud.com')) {
                    const response = await fetch(finalUrl, { method: 'GET', redirect: 'follow' });
                    finalUrl = response.url;
                }
                finalUrl = finalUrl.replace('m.soundcloud.com', 'soundcloud.com').split('?')[0];

                if (!scdl.isValidUrl(finalUrl)) {
                    return socket.emit('error', 'Format URL SoundCloud tidak valid.');
                }

                socket.emit('info', 'Mengambil metadata lagu...');
                const trackInfo = await scdl.getInfo(finalUrl);
                const title = (trackInfo.title || 'SoundCloud_Audio').replace(/[^a-zA-Z0-9_\-\s]/g, "").trim();
                const fileName = `${title}_${Date.now()}.mp3`;
                filePath = path.join(DOWNLOAD_DIR, fileName);

                socket.emit('info', `Mengunduh: ${title}...`);
                const stream = await scdl.downloadFormat(finalUrl, scdl.FORMATS.MP3);
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
                    
                    socket.emit('progress', {
                        progress, speedMBps, etaSec,
                        downloadedMB: (downloaded / (1024 * 1024)).toFixed(2),
                        sizeMB: (estimatedSize / (1024 * 1024)).toFixed(2),
                        title
                    });
                });

                stream.pipe(fileStream);

                fileStream.on('finish', () => {
                    totalDownloads++;
                    io.emit('update_counter', { totalDownloads });
                    socket.emit('progress', { progress: 100, speedMBps: "0.00", etaSec: 0, title });
                    socket.emit('done', { downloadUrl: `/download-file/${encodeURIComponent(fileName)}`, fileName });
                });

                stream.on('error', () => {
                    socket.emit('error', 'Gagal memproses audio SoundCloud.');
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                });

            } 
            // ==========================================
            // CASE 2: DOWNLOAD & CONVERT YOUTUBE TO MP3
            // ==========================================
            else if (url.includes('youtube.com') || url.includes('youtu.be')) {
                socket.emit('info', 'Menghubungkan ke server YouTube...');

                // Ambil info video dulu untuk mendapatkan Judul
                const info = await youtubedl(url, { dumpSingleJson: true, noCheckCertificates: true });
                const title = (info.title || 'YouTube_Audio').replace(/[^a-zA-Z0-9_\-\s]/g, "").trim();
                const fileName = `${title}_${Date.now()}.mp3`;
                filePath = path.join(DOWNLOAD_DIR, fileName);

                socket.emit('info', `Mengonversi ke MP3: ${title}...`);
                socket.emit('progress', { progress: 50, speedMBps: "2.50", etaSec: "5", title });

                // Opsi menggunakan cookies jika file cookies.txt tersedia di server
                const cookiePath = path.join(__dirname, 'cookies.txt');
                const ytOptions = {
                    extractAudio: true,
                    audioFormat: 'mp3',
                    output: path.join(DOWNLOAD_DIR, `${fileName}`),
                    noCheckCertificates: true,
                    noWarnings: true,
                    preferFreeFormats: true,
                };
                if (fs.existsSync(cookiePath)) {
                    ytOptions.cookies = cookiePath;
                }

                // Jalankan proses download & konversi via yt-dlp
                await youtubedl(url, ytOptions);

                // Cek apakah file benar-benar jadi
                if (fs.existsSync(filePath)) {
                    totalDownloads++;
                    io.emit('update_counter', { totalDownloads });

                    socket.emit('progress', { progress: 100, speedMBps: "0.00", etaSec: 0, title });
                    socket.emit('done', { downloadUrl: `/download-file/${encodeURIComponent(fileName)}`, fileName });
                } else {
                    throw new Error('Gagal menghasilkan file MP3.');
                }

            } else {
                socket.emit('error', 'Link tidak dikenali! Masukkan link SoundCloud atau YouTube yang valid.');
            }

        } catch (error) {
            console.error('❌ Error:', error);
            socket.emit('error', 'Gagal memproses media. Pastikan link publik dan tidak dibatasi.');
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    });
});

app.get('/download-file/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(DOWNLOAD_DIR, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath, fileName, (err) => {
            if (err) console.error("Error mengirim file:", err);
            fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr) console.error("⚠️ Gagal menghapus file temp:", unlinkErr);
            });
        });
    } else {
        res.status(404).send('File sudah kadaluarsa atau tidak ditemukan.');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Multi-Downloader Server aktif di port ${PORT}`);
});
