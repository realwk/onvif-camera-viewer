const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const onvif = require('onvif');
const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

let mainWindow;
let camera = null;
let ffmpegVideoProcess = null;
let ffmpegAudioProcess = null;
let wsServer = null;
let wsClients = new Set();
let audioWsServer = null;
let audioWsClients = new Set();
let historyFilePath = null;
let connectedCameras = [];
let ptzEndpoint = null;
let profileToken = null;

// ══════════════════════════════════════════════════════════
// История подключений
// ══════════════════════════════════════════════════════════
function getHistoryFilePath() {
    return path.join(app.getPath('userData'), 'cameras-history.json');
}

function loadHistory() {
    try {
        historyFilePath = getHistoryFilePath();
        if (fs.existsSync(historyFilePath)) {
            connectedCameras = JSON.parse(fs.readFileSync(historyFilePath, 'utf-8'));
        }
    } catch (err) {
        console.error('Ошибка загрузки истории:', err);
        connectedCameras = [];
    }
}

function saveHistory() {
    try {
        fs.writeFileSync(historyFilePath, JSON.stringify(connectedCameras, null, 2));
    } catch (err) {
        console.error('Ошибка сохранения истории:', err);
    }
}

// ══════════════════════════════════════════════════════════
// Окно приложения
// ══════════════════════════════════════════════════════════
function createWindow() {
    Menu.setApplicationMenu(null);
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.loadFile('src/index.html');
}

app.whenReady().then(() => {
    loadHistory();
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    disconnectCamera();
    if (process.platform !== 'darwin') app.quit();
});

// ══════════════════════════════════════════════════════════
// Подключение к камере
// ══════════════════════════════════════════════════════════
ipcMain.handle('connect-camera', async (event, connectionString) => {
    try {
        const config = parseConnectionString(connectionString);

        return new Promise((resolve, reject) => {
            camera = new onvif.Cam({
                hostname: config.hostname,
                username: config.username,
                password: config.password,
                port: config.port || 80,
                timeout: 10000
            }, async (err) => {
                if (err) {
                    reject(new Error(`Ошибка ONVIF подключения: ${err.message}`));
                    return;
                }
                try {
                    const streamUri = await new Promise((res, rej) => {
                        camera.getStreamUri((err, data) => {
                            if (err) rej(err);
                            else res(data.uri);
                        });
                    });
                    console.log('RTSP URI:', streamUri);

                    await getPTZInfo();
                    await startStream(streamUri);

                    if (!connectedCameras.includes(connectionString)) {
                        connectedCameras.unshift(connectionString);
                        if (connectedCameras.length > 20) {
                            connectedCameras = connectedCameras.slice(0, 20);
                        }
                        saveHistory();
                    }
                    resolve({ success: true, streamUri });
                } catch (err) {
                    reject(new Error(`Ошибка получения потока: ${err.message}`));
                }
            });
        });
    } catch (err) {
        throw new Error(`Ошибка парсинга подключения: ${err.message}`);
    }
});

async function getPTZInfo() {
    return new Promise((resolve) => {
        camera.getProfiles((err, profiles) => {
            if (err || !profiles || profiles.length === 0) {
                profileToken = 'Profile_1';
                ptzEndpoint = '/onvif/ptz_service';
                resolve();
                return;
            }
            const profile = profiles[0];
            profileToken = profile.token
                || (profile.$ && profile.$.token)
                || profile.Name
                || 'Profile_1';
            ptzEndpoint = (camera.uris && camera.uris.PTZ) || '/onvif/ptz_service';
            console.log('PTZ endpoint:', ptzEndpoint, '| Profile:', profileToken);
            resolve();
        });
    });
}

// ══════════════════════════════════════════════════════════
// Отключение
// ══════════════════════════════════════════════════════════
ipcMain.handle('disconnect-camera', async () => {
    disconnectCamera();
    return { success: true };
});

// ══════════════════════════════════════════════════════════
// PTZ управление
// ══════════════════════════════════════════════════════════
ipcMain.handle('ptz-control', async (event, command) => {
    if (!camera) throw new Error('Камера не подключена');

    const options = { x: 0, y: 0, zoom: 0 };
    switch (command.direction) {
        case 'left':     options.x = -0.5; break;
        case 'right':    options.x =  0.5; break;
        case 'up':       options.y =  0.5; break;
        case 'down':     options.y = -0.5; break;
        case 'zoom-in':  options.zoom =  0.5; break;
        case 'zoom-out': options.zoom = -0.5; break;
        case 'stop':     return await sendPTZStop();
        default:         throw new Error('Неизвестная команда PTZ');
    }
    return await sendPTZMove(options);
});

function sendPTZMove(options) {
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
    <s:Body>
        <tptz:ContinuousMove>
            <tptz:ProfileToken>${profileToken}</tptz:ProfileToken>
            <tptz:Velocity>
                <tt:PanTilt x="${options.x}" y="${options.y}"/>
                <tt:Zoom x="${options.zoom}"/>
            </tptz:Velocity>
        </tptz:ContinuousMove>
    </s:Body>
</s:Envelope>`;
    return sendSOAPRequest(soapBody, 'ContinuousMove');
}

function sendPTZStop() {
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
    <s:Body>
        <tptz:ContinuousMove>
            <tptz:ProfileToken>${profileToken}</tptz:ProfileToken>
            <tptz:Velocity>
                <tt:PanTilt x="0" y="0"/>
                <tt:Zoom x="0"/>
            </tptz:Velocity>
            <tptz:Timeout>PT0.1S</tptz:Timeout>
        </tptz:ContinuousMove>
    </s:Body>
</s:Envelope>`;
    return sendSOAPRequest(soapBody, 'Stop');
}

function sendSOAPRequest(soapBody, action) {
    return new Promise((resolve, reject) => {
        let endpointPath = ptzEndpoint;
        if (endpointPath.startsWith('http')) {
            endpointPath = new URL(endpointPath).pathname;
        }
        const options = {
            hostname: camera.hostname,
            port: camera.port || 80,
            path: endpointPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'Content-Length': Buffer.byteLength(soapBody),
                'Authorization': 'Basic ' + Buffer.from(`${camera.username}:${camera.password}`).toString('base64')
            }
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ success: true });
                } else {
                    reject(new Error(`${action} failed: ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        req.write(soapBody);
        req.end();
    });
}

// ══════════════════════════════════════════════════════════
// История подключений (IPC)
// ══════════════════════════════════════════════════════════
ipcMain.handle('get-saved-cameras', () => connectedCameras);
ipcMain.handle('remove-camera', (event, connectionString) => {
    connectedCameras = connectedCameras.filter(c => c !== connectionString);
    saveHistory();
    return { success: true };
});
ipcMain.handle('clear-history', () => {
    connectedCameras = [];
    saveHistory();
    return { success: true };
});

// ══════════════════════════════════════════════════════════
// Вспомогательные функции
// ══════════════════════════════════════════════════════════
function parseConnectionString(str) {
    const match = str.match(/^(?:(.+?):(.+?)@)?([^:@]+)(?::(\d+))?$/);
    if (!match) throw new Error('Неверный формат строки подключения');
    return {
        username: match[1] || 'admin',
        password: match[2] || 'admin',
        hostname: match[3],
        port: parseInt(match[4]) || 80
    };
}

// ══════════════════════════════════════════════════════════
// Стриминг: ДВА ОТДЕЛЬНЫХ ПРОЦЕССА FFMPEG
// (видео и аудио раздельно — нет смешивания с логами)
// ══════════════════════════════════════════════════════════
async function startStream(rtspUri) {
    // Останавливаем предыдущие процессы
    if (ffmpegVideoProcess) { try { ffmpegVideoProcess.kill(); } catch (e) {} ffmpegVideoProcess = null; }
    if (ffmpegAudioProcess) { try { ffmpegAudioProcess.kill(); } catch (e) {} ffmpegAudioProcess = null; }
    if (wsServer) { try { wsServer.close(); } catch (e) {} wsServer = null; }
    if (audioWsServer) { try { audioWsServer.close(); } catch (e) {} audioWsServer = null; }

    // WebSocket для видео (порт 9999)
    wsServer = new WebSocket.Server({ port: 9999 });
    wsServer.on('connection', (ws) => {
        wsClients.add(ws);
        ws.on('close', () => wsClients.delete(ws));
        ws.on('error', () => wsClients.delete(ws));
    });

    // WebSocket для аудио (порт 9998)
    audioWsServer = new WebSocket.Server({ port: 9998 });
    audioWsClients = new Set();
    audioWsServer.on('connection', (ws) => {
        audioWsClients.add(ws);
        ws.on('close', () => audioWsClients.delete(ws));
        ws.on('error', () => audioWsClients.delete(ws));
    });

    // ══════════════════════════════════════════════════════
    // ПРОЦЕСС 1: ВИДЕО (stdout → MJPEG)
    // ══════════════════════════════════════════════════════
    const videoArgs = [
        '-loglevel', 'error',
        '-i', rtspUri,
        '-map', '0:v',
        '-f', 'mjpeg',
        '-c:v', 'mjpeg',
        '-q:v', '8',
        '-r', '15',
        '-vf', 'scale=1280:720',
        '-pix_fmt', 'yuvj420p',
        '-'
    ];

    console.log('Starting video FFmpeg...');

    let ffmpegPath = ffmpegStatic;
    // В собранном приложении ffmpeg-static лежит в resources
    if (app.isPackaged) {
        // Пробуем разные возможные пути
        const possiblePaths = [
            path.join(process.resourcesPath, 'ffmpeg-static', 'ffmpeg.exe'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
            path.join(__dirname, '..', '..', 'ffmpeg-static', 'ffmpeg.exe')
        ];
        
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                ffmpegPath = p;
                break;
            }
        }
        
        console.log('Packaged app, FFmpeg path:', ffmpegPath);
        console.log('FFmpeg exists:', fs.existsSync(ffmpegPath));
    } else {
        console.log('Dev mode, FFmpeg path:', ffmpegPath);
    }

    ffmpegVideoProcess = spawn(ffmpegPath, videoArgs);

    let videoBuffer = Buffer.alloc(0);
    ffmpegVideoProcess.stdout.on('data', (data) => {
        videoBuffer = Buffer.concat([videoBuffer, data]);
        while (true) {
            const startIdx = videoBuffer.indexOf(Buffer.from([0xFF, 0xD8]));
            if (startIdx === -1) break;
            const endIdx = videoBuffer.indexOf(Buffer.from([0xFF, 0xD9]), startIdx);
            if (endIdx === -1) break;
            const jpegFrame = videoBuffer.slice(startIdx, endIdx + 2);
            videoBuffer = videoBuffer.slice(endIdx + 2);
            wsClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(jpegFrame);
                }
            });
        }
    });

    ffmpegVideoProcess.stderr.on('data', (data) => {
        console.error('FFmpeg Video Error:', data.toString().trim());
    });

    ffmpegVideoProcess.on('error', (err) => console.error('FFmpeg Video process error:', err));
    ffmpegVideoProcess.on('close', (code) => {
        if (code !== null) console.log(`FFmpeg Video exited with code ${code}`);
    });

    // ══════════════════════════════════════════════════════
    // ПРОЦЕСС 2: АУДИО (stdout → PCM 16-bit 44100Hz mono)
    // Отдельный процесс — нет смешивания с логами FFmpeg!
    // ══════════════════════════════════════════════════════
    const audioArgs = [
        '-loglevel', 'error',
        '-i', rtspUri,
        '-map', '0:a?',          // '?' — опционально, если аудио нет — не падает
        '-vn',                   // без видео
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        '-ar', '44100',          // 44100 Hz — нативный для AudioContext
        '-ac', '1',              // mono
        '-'
    ];

    console.log('Starting audio FFmpeg...');
    ffmpegAudioProcess = spawn(ffmpegPath, audioArgs);

    ffmpegAudioProcess.stdout.on('data', (data) => {
        // Отправляем чистые PCM-данные всем аудио-клиентам
        audioWsClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    });

    ffmpegAudioProcess.stderr.on('data', (data) => {
        const errText = data.toString().trim();
        if (errText.length > 0) {
            // Если аудио-потока нет — это не ошибка
            if (errText.includes('matches no streams') || errText.includes('Output file #0 does not contain any stream')) {
                console.log('No audio stream on camera (this is OK)');
            } else {
                console.error('FFmpeg Audio Error:', errText);
            }
        }
    });

    ffmpegAudioProcess.on('error', (err) => console.error('FFmpeg Audio process error:', err));
    ffmpegAudioProcess.on('close', (code) => {
        if (code !== null && code !== 0) {
            console.log(`FFmpeg Audio exited with code ${code}`);
        }
    });
}

function disconnectCamera() {
    if (ffmpegVideoProcess) { try { ffmpegVideoProcess.kill(); } catch (e) {} ffmpegVideoProcess = null; }
    if (ffmpegAudioProcess) { try { ffmpegAudioProcess.kill(); } catch (e) {} ffmpegAudioProcess = null; }
    if (wsServer) { try { wsServer.close(); } catch (e) {} wsServer = null; }
    if (audioWsServer) { try { audioWsServer.close(); } catch (e) {} audioWsServer = null; }
    wsClients.clear();
    audioWsClients.clear();
    camera = null;
    ptzEndpoint = null;
    profileToken = null;
}

app.on('will-quit', () => disconnectCamera());