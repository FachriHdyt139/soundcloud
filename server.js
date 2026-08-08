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

const RAPID_API_KEY = process.env.RAPID_API_KEY || '4ae8cf984dmshddf06cb87ec7b8ep19e86...'; 

app.get('/api/stats', (req, res) => {
    res.json({ totalDownloads });
});

io.on('connection', (socket) => {
    console.log('🔗 Client terhubung:', socket.id);

    socket.on('start_download', async ({ url: inputUrl, platform, format }) => {
        let filePath = '';

        try {
            if (!inputUrl) {
                return socket.emit('error', 'URL tidak boleh kosong!');
            }

            let url = inputUrl.trim();
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

            // Auto-detect platform berdasarkan link
            if (url.includes('soundcloud.com') || url.includes('on.soundcloud.com')) {
                platform = 'soundcloud';
            } else if (url.includes('tiktok.com') || url.includes('vt.tiktok.com')) {
                platform = 'tiktok';
            } else if (url.includes('instagram.com') || url.includes('instagr.am')) {
                platform = 'instagram';
            } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
                platform = 'youtube';
            }

            // ==========================================
            // 1. SOUNDCLOUD DOWNLOADER
            // ==========================================
            if (platform === 'soundcloud') {
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

                const trackInfo = await scdl.getInfo(finalUrl);
                const title = (trackInfo.title || 'SoundCloud_Audio').replace(/[^a-zA-Z0-9_\-\s]/g, "").trim();
                const coverUrl = trackInfo.artwork_url || 'https://i.scdn.co/image/ab67616d0000b273a04449a78531778971f11e95';

                socket.emit('preview', { title, coverUrl });

                const fileName = `${title}_${Date.now()}.mp3`;
                filePath = path.join(DOWNLOAD_DIR, fileName);

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
                    const etaSec = ((estimatedSize - downloaded) / speedBps).toFixed(0);
                    
                    socket.emit('progress', { progress, speedMBps, etaSec, title });
                });

                stream.pipe(fileStream);
                fileStream.on('finish', () => {
                    totalDownloads++;
                    io.emit('update_counter', { totalDownloads });
                    socket.emit('progress', { progress: 100, speedMBps: "0.00", etaSec: 0, title });
                    socket.emit('done', { downloadUrl: `/download-file/${encodeURIComponent(fileName)}`, fileName, title, coverUrl });
                });

            } 
            // ==========================================
            // 2. TIKTOK DOWNLOADER
            // ==========================================
            else if (platform === 'tiktok') {
                socket.emit('info', 'Menghubungkan ke server TikTok...');
                const apiRes = await fetch(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`);
                const resJson = await apiRes.json();

                if (!resJson || resJson.code !== 0 || !resJson.data) {
                    return socket.emit('error', 'Gagal mengambil video TikTok. Pastikan link publik.');
                }

                const videoData = resJson.data;
                const title = (videoData.title || 'TikTok Video').trim();
                const coverUrl = videoData.cover || videoData.origin_cover;
                let downloadSourceUrl = format === 'mp3' && videoData.music ? videoData.music : videoData.play;
                let fileExt = format === 'mp3' ? 'mp3' : 'mp4';

                socket.emit('preview', { title, coverUrl });

                const cleanTitle = title.replace(/[^a-zA-Z0-9_\-\s]/g, "").substring(0, 30);
                const fileName = `${cleanTitle}_${Date.now()}.${fileExt}`;
                filePath = path.join(DOWNLOAD_DIR, fileName);

                const mediaRes = await fetch(downloadSourceUrl);
                const fileStream = fs.createWriteStream(filePath);
                const totalLength = parseInt(mediaRes.headers.get('content-length') || '5000000');
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
            // 3. INSTAGRAM & YOUTUBE (Diperbarui dengan Query URL)
            // ==========================================
            else if (platform === 'instagram' || platform === 'youtube') {
                socket.emit('info', `Menghubungkan ke API ${platform.toUpperCase()}...`);
                
                const apiHost = 'all-media-downloader4.p.rapidapi.com';
                // Menggunakan parameter url universal agar cocok dengan endpoint RapidAPI
                const endpointUrl = `https://${apiHost}/api/${platform}/download?url=${encodeURIComponent(url)}`;

                const apiRes = await fetch(endpointUrl, {
                    method: 'GET',
                    headers: {
                        'x-rapidapi-key': RAPID_API_KEY,
                        'x-rapidapi-host': apiHost
                    }
                });

                const resJson = await apiRes.json();

                if (!resJson || (!resJson.url && !resJson.data && !resJson.link && !resJson.video)) {
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
                socket.emit('error', 'Platform atau format link tidak dikenali.');
            }

        } catch (error) {
            console.error('❌ Error:', error);
            socket.emit('error', 'Gagal memproses media.');
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
    console.log(`🚀 Server aktif di port ${PORT}`);
});
