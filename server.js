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

let totalDownloads = 1255;

// API Key RapidAPI Anda yang sudah dimasukkan
const RAPID_API_KEY = process.env.RAPID_API_KEY || '4ae8cf984dmshddf06cb87ec7b8ep19e868jsna99694e67dd6';

app.get('/api/stats', (req, res) => {
    res.json({ totalDownloads });
});

io.on('connection', (socket) => {
    console.log('Client terhubung:', socket.id);

    socket.on('start_download', async ({ url, inputUrl, platform, format }) => {
        let filePath = '';

        try {
            if (!url) {
                return socket.emit('error', 'URL tidak boleh kosong!');
            }

            if (!/(https:\/\/|www\.)/.test(url)) {
                return socket.emit('error', 'URL tidak valid!');
            }

            // ==========================================
            // 1. SOUNDCLOUD
            // ==========================================
            if (platform === 'soundcloud') {
                socket.emit('info', 'Memproses link SoundCloud...');
                
                const finalUrl = await scdl.getInfo(url).then(() => url).catch(() => null);
                if (!finalUrl) {
                    return socket.emit('error', 'Gagal memproses link SoundCloud.');
                }

                const trackInfo = await scdl.getInfo(finalUrl);
                const title = trackInfo.title.substring(0, 40).trim();
                const coverUrl = trackInfo.artwork_url || 'https://images.unsplash.com/photo-1611162617474-5b21e879e113';

                socket.emit('preview', { title, coverUrl });

                const cleanTitle = title.replace(/[^a-zA-Z0-9_\-\s]/g, "");
                const fileName = `soundcloud_${cleanTitle}_${Date.now()}.mp3`;
                filePath = path.join(DOWNLOAD_DIR, fileName);

                socket.emit('info', 'Mengunduh file SoundCloud...');
                const stream = await scdl.download(finalUrl);
                
                const fileStream = fs.createWriteStream(filePath);
                stream.pipe(fileStream);

                let downloaded = 0;
                const startTime = Date.now();
                const totalLength = trackInfo.duration || 10000000;

                stream.on('data', (chunk) => {
                    downloaded += chunk.length;
                    const elapsedTime = (Date.now() - startTime) / 1000 || 0.001;
                    const speedBps = downloaded / elapsedTime;
                    const speedMBps = (speedBps / (1024 * 1024)).toFixed(2);
                    const progress = Math.min((downloaded / (totalLength * 1000)) * 100, 99).toFixed(1);
                    const etaSec = ((totalLength - downloaded) / speedBps).toFixed(0);

                    socket.emit('progress', { progress, speedMBps, etaSec, title });
                });

                stream.on('end', () => {
                    totalDownloads++;
                    io.emit('update_counter', { totalDownloads });
                    socket.emit('progress', { progress: 100, speedMBps: "0.00", etaSec: 0, title });
                    socket.emit('done', { downloadUrl: `/download-file/${encodeURIComponent(fileName)}`, fileName, title, coverUrl });
                });

                stream.on('error', (err) => {
                    console.error('Error stream:', err);
                    socket.emit('error', 'Gagal mengunduh file.');
                });
            } 
            // ==========================================
            // 2. TIKTOK
            // ==========================================
            else if (platform === 'tiktok') {
                socket.emit('info', 'Memproses link TikTok...');
                
                const apiHost = 'all-media-downloader4.p.rapidapi.com';
                const apiRes = await fetch(`https://${apiHost}/api/tiktok/download?url=${encodeURIComponent(url)}`, {
                    method: 'GET',
                    headers: {
                        'x-rapidapi-key': RAPID_API_KEY,
                        'x-rapidapi-host': apiHost
                    }
                });

                const resJson = await apiRes.json();
                if (!resJson || (!resJson.url && !resJson.link && !resJson.video)) {
                    return socket.emit('error', 'Gagal mengambil media TikTok.');
                }

                const downloadSourceUrl = resJson.url || resJson.link || resJson.video;
                const title = (resJson.title || 'TikTok Video').substring(0, 40).trim();
                const coverUrl = resJson.thumbnail || 'https://images.unsplash.com/photo-1611162617474-5b21e879e113';

                socket.emit('preview', { title, coverUrl });

                const cleanTitle = title.replace(/[^a-zA-Z0-9_\-\s]/g, "");
                const fileName = `tiktok_${cleanTitle}_${Date.now()}.mp4`;
                filePath = path.join(DOWNLOAD_DIR, fileName);

                socket.emit('info', 'Mengunduh file TikTok...');
                const mediaRes = await fetch(downloadSourceUrl);
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
            // ==========================================
            // 3. INSTAGRAM & YOUTUBE (Fix Endpoint)
            // ==========================================
            else if (platform === 'instagram' || platform === 'youtube') {
                socket.emit('info', `Menghubungkan ke API ${platform.toUpperCase()}...`);
                
                const apiHost = 'all-media-downloader4.p.rapidapi.com';
                let endpointUrl = '';
                if (platform === 'youtube') {
                    endpointUrl = `https://${apiHost}/api/youtube/download?url=${encodeURIComponent(url)}`;
                } else {
                    endpointUrl = `https://${apiHost}/api/instagram/download?url=${encodeURIComponent(url)}`;
                }

                const apiRes = await fetch(endpointUrl, {
                    method: 'GET',
                    headers: {
                        'x-rapidapi-key': RAPID_API_KEY,
                        'x-rapidapi-host': apiHost
                    }
                });

                const resJson = await apiRes.json();
                if (!resJson || (!resJson.url && !resJson.link && !resJson.video && !resJson.data)) {
                    return socket.emit('error', `Gagal mengambil media ${platform}. Periksa kembali link.`);
                }

                const downloadSourceUrl = resJson.url || resJson.link || resJson.video || (resJson.data && resJson.data.url);
                const title = (resJson.title || resJson.caption || `${platform} Media`).substring(0, 40).trim();
                const coverUrl = resJson.thumbnail || resJson.cover || 'https://images.unsplash.com/photo-1611162617474-5b21e879e113';

                socket.emit('preview', { title, coverUrl });

                const cleanTitle = title.replace(/[^a-zA-Z0-9_\-\s]/g, "");
                const fileName = `${platform}_${cleanTitle}_${Date.now()}.mp4`;
                filePath = path.join(DOWNLOAD_DIR, fileName);

                socket.emit('info', `Mengunduh file ${platform.toUpperCase()}...`);
                const mediaRes = await fetch(downloadSourceUrl);
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
            } else {
                socket.emit('error', 'Platform atau format link tidak didukung.');
            }

        } catch (error) {
            console.error('Error:', error);
            socket.emit('error', 'Gagal memproses media.');
            if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    });
});

app.get('/download-file/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(DOWNLOAD_DIR, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath, (err) => {
            if (err) console.error("Error mengirim file:", err);
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
    console.log(`Server aktif di port ${PORT}`);
});
