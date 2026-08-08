const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const scdl = require('soundcloud-downloader').default;
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

let totalDownloads = 1241;

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
            // CASE 1: SOUNDCLOUD DOWNLOADER
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
            // CASE 2: YOUTUBE MP3 (MULTI-INSTANCE FALLBACK)
            // ==========================================
            else if (url.includes('youtube.com') || url.includes('youtu.be')) {
                socket.emit('info', 'Menghubungkan ke server YouTube...');

                let videoId = '';
                if (url.includes('youtu.be/')) {
                    videoId = url.split('youtu.be/')[1]?.split('?')[0];
                } else if (url.includes('watch?v=')) {
                    videoId = url.split('watch?v=')[1]?.split('&')[0];
                }

                if (!videoId) {
                    return socket.emit('error', 'Link YouTube tidak valid.');
                }

                socket.emit('info', 'Mencari jalur server stabil...');
                socket.emit('progress', { progress: 30, speedMBps: "1.00", etaSec: "3", title: "YouTube Audio" });

                // Daftar server publik cadangan (Piped Instances) yang aman & aktif
                const pipedInstances = [
                    'https://pipedapi.kavin.rocks',
                    'https://pipedapi.yt.privacydev.net',
                    'https://pipedapi.adminforge.de',
                    'https://api.piped.privacy.com.de'
                ];

                let apiData = null;
                for (const instance of pipedInstances) {
                    try {
                        const res = await fetch(`${instance}/streams/${videoId}`);
                        if (res.ok) {
                            const data = await res.json();
                            if (data.audioStreams && data.audioStreams.length > 0) {
                                apiData = data;
                                break; // Berhenti mencari jika salah satu server berhasil merespons
                            }
                        }
                    } catch (err) {
                        console.log(`⚠️ Server ${instance} sibuk, mencoba server berikutnya...`);
                    }
                }

                if (!apiData || !apiData.audioStreams) {
                    return socket.emit('error', 'Semua server YouTube sedang sibuk atau video dibatasi. Coba beberapa saat lagi.');
                }

                const audioStreamInfo = apiData.audioStreams.sort((a, b) => b.bitrate - a.bitrate)[0];
                const audioUrl = audioStreamInfo.url;
                
                const title = (apiData.title || 'YouTube_Audio').replace(/[^a-zA-Z0-9_\-\s]/g, "").trim();
                const fileName = `${title}_${Date.now()}.mp3`;
                filePath = path.join(DOWNLOAD_DIR, fileName);

                socket.emit('info', `Mengunduh: ${title}...`);

                const audioRes = await fetch(audioUrl);
                const fileStream = fs.createWriteStream(filePath);
                
                const totalLength = parseInt(audioRes.headers.get('content-length') || '5000000');
                let downloaded = 0;
                const startTime = Date.now();

                const reader = audioRes.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    fileStream.write(value);
                    downloaded += value.length;

                    const elapsedTime = (Date.now() - startTime) / 1000 || 0.001;
                    const speedBps = downloaded / elapsedTime;
                    const speedMBps = (speedBps / (1024 * 1024)).toFixed(2);
                    const progress = Math.min((downloaded / totalLength) * 100, 99).toFixed(1);
                    const etaSec = ((totalLength - downloaded) / speedBps).toFixed(0);

                    socket.emit('progress', {
                        progress, speedMBps, etaSec,
                        downloadedMB: (downloaded / (1024 * 1024)).toFixed(2),
                        sizeMB: (totalLength / (1024 * 1024)).toFixed(2),
                        title
                    });
                }

                fileStream.end();

                fileStream.on('finish', () => {
                    totalDownloads++;
                    io.emit('update_counter', { totalDownloads });
                    socket.emit('progress', { progress: 100, speedMBps: "0.00", etaSec: 0, title });
                    socket.emit('done', { downloadUrl: `/download-file/${encodeURIComponent(fileName)}`, fileName });
                });

            } else {
                socket.emit('error', 'Link tidak dikenali! Masukkan link SoundCloud atau YouTube.');
            }

        } catch (error) {
            console.error('❌ Error:', error);
            socket.emit('error', 'Gagal memproses media. Pastikan link publik.');
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
    console.log(`🚀 Server Multi-Instance aktif di port ${PORT}`);
});
