const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const SoundCloud = require("soundcloud-scraper");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const sc = new SoundCloud.Client();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

let totalDownloads = 1257;

app.get('/api/stats', (req, res) => {
    res.json({ totalDownloads });
});

io.on('connection', (socket) => {
    console.log('Client terhubung:', socket.id);

    socket.on('start_download', async ({ url, platform }) => {
        let filePath = '';

        try {
            if (!url) return socket.emit('error', 'URL tidak boleh kosong!');

            // ==========================================
            // 1. SOUNDCLOUD
            // ==========================================
            if (platform === 'soundcloud') {
                socket.emit('info', 'Memproses link SoundCloud...');
                
                const songData = await sc.getSongInfo(url).catch(err => {
                    console.error("SC Scraper Error:", err);
                    return null;
                });

                if (!songData || !songData.url) {
                    return socket.emit('error', 'Gagal mengambil audio SoundCloud. Pastikan link publik.');
                }

                const title = songData.title || 'SoundCloud Audio';
                const coverUrl = songData.thumbnail || 'https://images.unsplash.com/photo-1611162617474-5b21e879e113';
                
                socket.emit('preview', { title: title.substring(0, 40), coverUrl });

                const stream = await sc.downloadTrack(url).catch(() => null);
                if (!stream) {
                    return socket.emit('error', 'Gagal mengunduh stream audio SoundCloud.');
                }

                const cleanTitle = title.replace(/[^a-zA-Z0-9_\-\s]/g, "");
                const fileName = `soundcloud_${cleanTitle}_${Date.now()}.mp3`;
                filePath = path.join(DOWNLOAD_DIR, fileName);

                socket.emit('info', 'Menyimpan file SoundCloud...');
                const fileStream = fs.createWriteStream(filePath);
                
                stream.pipe(fileStream);

                let downloaded = 0;
                const startTime = Date.now();

                stream.on('data', (chunk) => {
                    downloaded += chunk.length;
                    const elapsedTime = (Date.now() - startTime) / 1000 || 0.001;
                    const speedBps = downloaded / elapsedTime;
                    const speedMBps = (speedBps / (1024 * 1024)).toFixed(2);
                    const progress = Math.min((downloaded / 10000000) * 100, 95).toFixed(1);
                    const etaSec = 5;

                    socket.emit('progress', { progress, speedMBps, etaSec, title });
                });

                fileStream.on('finish', () => {
                    totalDownloads++;
                    io.emit('update_counter', { totalDownloads });
                    socket.emit('progress', { progress: 100, speedMBps: "0.00", etaSec: 0, title });
                    socket.emit('done', { downloadUrl: `/download-file/${encodeURIComponent(fileName)}`, fileName, title, coverUrl });
                });

                stream.on('error', (err) => {
                    console.error("Stream error:", err);
                    socket.emit('error', 'Terjadi kesalahan saat mengunduh stream.');
                });
            } 
            // ==========================================
            // 2. TIKTOK
            // ==========================================
            else if (platform === 'tiktok') {
                socket.emit('info', 'Memproses link TikTok...');
                
                const apiRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
                const resJson = await apiRes.json();

                if (!resJson || !resJson.data || !resJson.data.play) {
                    return socket.emit('error', 'Gagal mengambil video TikTok.');
                }

                const downloadSourceUrl = resJson.data.play;
                const title = (resJson.data.title || 'TikTok Video').substring(0, 40).trim();
                const coverUrl = resJson.data.cover || 'https://images.unsplash.com/photo-1611162617474-5b21e879e113';

                socket.emit('preview', { title, coverUrl });

                const cleanTitle = title.replace(/[^a-zA-Z0-9_\-\s]/g, "");
                const fileName = `tiktok_${cleanTitle}_${Date.now()}.mp4`;
                filePath = path.join(DOWNLOAD_DIR, fileName);

                socket.emit('info', 'Mengunduh file TikTok...');
                const mediaRes = await fetch(downloadSourceUrl);
                
                if (!mediaRes.ok) return socket.emit('error', 'Gagal menyambung ke server video.');

                const fileStream = fs.createWriteStream(filePath);
                const totalLength = parseInt(mediaRes.headers.get('content-length') || '10000000');
                let downloaded = 0;
                const startTime = Date.now();

                const reader = mediaRes.body.getReader();
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

                    socket.emit('progress', { progress, speedMBps, etaSec, title });
                }

                fileStream.end();
                fileStream.on('finish', () => {
                    totalDownloads++;
                    io.emit('update_counter', { totalDownloads });
                    socket.emit('progress', { progress: 100, speedMBps: "0.00", etaSec: 0, title });
                    socket.emit('done', { downloadUrl: `/download-file/${encodeURIComponent(fileName)}`, fileName, title, coverUrl });
                });
            }

        } catch (error) {
            console.error('Error:', error);
            socket.emit('error', 'Terjadi kesalahan internal.');
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    });
});

app.get('/download-file/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(DOWNLOAD_DIR, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath, (err) => {
            if (err) console.error("Error:", err);
            fs.unlink(filePath, () => {});
        });
    } else {
        res.status(404).send('File tidak ditemukan.');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server aktif di port ${PORT}`);
});
