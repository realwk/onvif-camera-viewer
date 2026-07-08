document.addEventListener('DOMContentLoaded', () => {
    // DOM элементы
    const canvas = document.getElementById('videoCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    const cameraInput = document.getElementById('cameraInput');
    const cameraHistory = document.getElementById('cameraHistory');
    const connectBtn = document.getElementById('connectBtn');
    const statusMessage = document.getElementById('statusMessage');
    const ptzButtons = document.querySelectorAll('.ptz-btn');
    const muteBtn = document.getElementById('muteBtn');

    if (!canvas || !ctx) {
        console.error('ОШИБКА: canvas не найден!');
        return;
    }

    let isConnected = false;
    let ws = null;
    let ptzInterval = null;
    let reconnectTimer = null;

    // ══════════════════════════════════════════════════════════
    // Аудио (AudioWorkletNode — современный подход)
    // ══════════════════════════════════════════════════════════
    let audioContext = null;
    let audioWs = null;
    let audioGainNode = null;
    let audioWorkletNode = null;
    let muted = false;

    const AUDIO_SAMPLE_RATE = 44100;
    const MAX_QUEUE_SECONDS = 1.5;
    const MAX_QUEUE_SAMPLES = AUDIO_SAMPLE_RATE * MAX_QUEUE_SECONDS;

    // ══════════════════════════════════════════════════════════
    // Worklet-код (загружается как Blob URL)
    // Работает в отдельном потоке — не блокирует UI
    // ══════════════════════════════════════════════════════════
    const WORKLET_CODE = `
        class AudioQueueProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this.queue = [];
                this.queueSamples = 0;
                this.maxSamples = ${MAX_QUEUE_SAMPLES};
                
                this.port.onmessage = (e) => {
                    const msg = e.data;
                    if (msg.type === 'audio') {
                        // Принятый Float32Array — добавляем в очередь
                        const chunk = new Float32Array(msg.samples);
                        this.queue.push(chunk);
                        this.queueSamples += chunk.length;
                        
                        // Защита от накопления буфера (сброс старых чанков)
                        while (this.queueSamples > this.maxSamples && this.queue.length > 1) {
                            const dropped = this.queue.shift();
                            this.queueSamples -= dropped.length;
                        }
                    } else if (msg.type === 'clear') {
                        this.queue = [];
                        this.queueSamples = 0;
                    }
                };
            }
            
            process(inputs, outputs, parameters) {
                const output = outputs[0][0];
                let written = 0;
                
                // Заполняем выходной буфер из очереди
                while (written < output.length && this.queue.length > 0) {
                    const chunk = this.queue[0];
                    const remaining = output.length - written;
                    
                    if (chunk.length <= remaining) {
                        // Весь чанк помещается
                        output.set(chunk, written);
                        written += chunk.length;
                        this.queueSamples -= chunk.length;
                        this.queue.shift();
                    } else {
                        // Чанк больше, чем осталось места — берём часть
                        output.set(chunk.subarray(0, remaining), written);
                        this.queue[0] = chunk.subarray(remaining);
                        this.queueSamples -= remaining;
                        written += remaining;
                    }
                }
                
                // Если очередь пуста — заполняем тишиной
                if (written < output.length) {
                    output.fill(0, written);
                }
                
                return true; // продолжаем работу
            }
        }
        
        registerProcessor('audio-queue-processor', AudioQueueProcessor);
    `;

    // ══════════════════════════════════════════════════════════
    // Инициализация
    // ══════════════════════════════════════════════════════════
    drawPlaceholder();
    loadSavedCameras();

    // ══════════════════════════════════════════════════════════
    // Обработчики событий
    // ══════════════════════════════════════════════════════════
    if (connectBtn) connectBtn.addEventListener('click', toggleConnection);
    if (muteBtn) muteBtn.addEventListener('click', onMute);

    if (cameraInput) {
        cameraInput.addEventListener('change', (e) => {
            if (e.target.value === '✕ Очистить историю') {
                clearHistory();
                e.target.value = '';
            }
        });
        cameraInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !isConnected) {
                e.preventDefault();
                toggleConnection();
            }
        });
    }

    ptzButtons.forEach(btn => {
        const direction = btn.dataset.direction;
        if (!direction) return;
        btn.addEventListener('mousedown', () => {
            if (isConnected) { btn.classList.add('active'); startPTZ(direction); }
        });
        btn.addEventListener('mouseup', () => { btn.classList.remove('active'); stopPTZ(); });
        btn.addEventListener('mouseleave', () => { btn.classList.remove('active'); stopPTZ(); });
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (isConnected) { btn.classList.add('active'); startPTZ(direction); }
        });
        btn.addEventListener('touchend', (e) => {
            e.preventDefault();
            btn.classList.remove('active');
            stopPTZ();
        });
    });

    const keyMap = {
        'ArrowLeft': 'left', 'a': 'left', 'A': 'left', 'ф': 'left', 'Ф': 'left',
        'ArrowRight': 'right', 'd': 'right', 'D': 'right', 'в': 'right', 'В': 'right',
        'ArrowUp': 'up', 'w': 'up', 'W': 'up', 'ц': 'up', 'Ц': 'up',
        'ArrowDown': 'down', 's': 'down', 'S': 'down', 'ы': 'down', 'Ы': 'down',
        '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', '_': 'zoom-out'
    };

    document.addEventListener('keydown', (e) => {
        if (!isConnected || document.activeElement.tagName === 'INPUT') return;
        if (keyMap[e.key]) { e.preventDefault(); startPTZ(keyMap[e.key]); }
    });
    document.addEventListener('keyup', (e) => {
        if (keyMap[e.key]) { e.preventDefault(); stopPTZ(); }
    });

    // ══════════════════════════════════════════════════════════
    // Подключение / Отключение
    // ══════════════════════════════════════════════════════════
    async function toggleConnection() {
        if (isConnected) await disconnect();
        else await connect();
    }

    function onMute() {
        muted = !muted;
        muteBtn.textContent = muted ? '🔊' : '🔈';

        // Плавное изменение громкости за 50мс — убирает щелчок
        if (audioContext && audioGainNode) {
            const now = audioContext.currentTime;
            audioGainNode.gain.cancelScheduledValues(now);
            audioGainNode.gain.setValueAtTime(audioGainNode.gain.value, now);
            audioGainNode.gain.linearRampToValueAtTime(muted ? 0 : 1, now + 0.05);
        }
    }

    async function connect() {
        const connectionString = cameraInput.value.trim();
        if (!connectionString) {
            showStatus('Введите адрес камеры', 'error');
            return;
        }
        try {
            showStatus('Подключение...', 'info');
            connectBtn.disabled = true;
            const result = await window.electronAPI.connectCamera(connectionString);
            if (result && result.success) {
                isConnected = true;
                connectBtn.textContent = '■ Отключить';
                connectBtn.classList.add('disconnect');
                cameraInput.disabled = true;
                ptzButtons.forEach(b => b.disabled = false);
                loadSavedCameras();
                connectWebSocket();
                await initAudio();
                connectAudioStream();
                showStatus('Подключено', 'success');
            }
        } catch (err) {
            showStatus(`Ошибка: ${err.message}`, 'error');
            console.error(err);
        } finally {
            connectBtn.disabled = false;
        }
    }

    async function disconnect() {
        try {
            await window.electronAPI.disconnectCamera();
            if (ws) { ws.close(); ws = null; }
            if (audioWs) { audioWs.close(); audioWs = null; }
            
            // Очищаем очередь в worklet и отключаем узел
            if (audioWorkletNode) {
                audioWorkletNode.port.postMessage({ type: 'clear' });
                audioWorkletNode.disconnect();
                audioWorkletNode = null;
            }
            if (audioContext) {
                await audioContext.close();
                audioContext = null;
            }
            audioGainNode = null;
            
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

            isConnected = false;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            drawPlaceholder();
            connectBtn.textContent = '▶ Подключить';
            connectBtn.classList.remove('disconnect');
            cameraInput.disabled = false;
            ptzButtons.forEach(b => b.disabled = true);
            showStatus('Отключено', 'info');
        } catch (err) {
            showStatus(`Ошибка отключения: ${err.message}`, 'error');
        }
    }

    // ══════════════════════════════════════════════════════════
    // Аудио: AudioWorkletNode (современный подход)
    // Worklet работает в отдельном потоке — не блокирует UI
    // ══════════════════════════════════════════════════════════
    async function initAudio() {
        if (audioContext) return;

        try {
            // Нативный sample rate — без ресемплинга
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.log('AudioContext created, native sample rate:', audioContext.sampleRate);

            // GainNode — плавное управление громкостью (убирает щелчки)
            audioGainNode = audioContext.createGain();
            audioGainNode.gain.value = 0;
            audioGainNode.connect(audioContext.destination);

            // Загружаем worklet-скрипт через Blob URL
            const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
            const workletUrl = URL.createObjectURL(blob);
            await audioContext.audioWorklet.addModule(workletUrl);
            URL.revokeObjectURL(workletUrl);

            // Создаём AudioWorkletNode
            audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-queue-processor');
            audioWorkletNode.connect(audioGainNode);

            // Браузеры требуют user gesture для старта AudioContext
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            // Плавный fade-in за 100мс при подключении
            const now = audioContext.currentTime;
            audioGainNode.gain.cancelScheduledValues(now);
            audioGainNode.gain.setValueAtTime(0, now);
            audioGainNode.gain.linearRampToValueAtTime(muted ? 0 : 1, now + 0.1);

            console.log('AudioWorkletNode created and connected');

        } catch (err) {
            console.error('Failed to create AudioContext/Worklet:', err);
        }
    }

    function connectAudioStream() {
        if (audioWs) { audioWs.close(); audioWs = null; }

        // Очищаем очередь в worklet
        if (audioWorkletNode) {
            audioWorkletNode.port.postMessage({ type: 'clear' });
        }

        audioWs = new WebSocket('ws://localhost:9998');
        audioWs.binaryType = 'arraybuffer';

        audioWs.onopen = () => {
            console.log('Audio WebSocket connected');
        };

        audioWs.onmessage = (event) => {
            if (!audioWorkletNode) return;

            if (event.data instanceof ArrayBuffer && event.data.byteLength > 0) {
                // PCM 16-bit → Float32
                const int16 = new Int16Array(event.data);
                const float32 = new Float32Array(int16.length);
                for (let i = 0; i < int16.length; i++) {
                    float32[i] = int16[i] / 32768.0;
                }

                // Отправляем чанк в worklet через port
                audioWorkletNode.port.postMessage({
                    type: 'audio',
                    samples: float32
                });
            }
        };

        audioWs.onerror = (err) => console.error('Audio WebSocket error:', err);

        audioWs.onclose = () => {
            if (isConnected) {
                setTimeout(() => {
                    if (isConnected) connectAudioStream();
                }, 2000);
            }
        };
    }

    // ══════════════════════════════════════════════════════════
    // WebSocket видеопоток
    // ══════════════════════════════════════════════════════════
    function connectWebSocket() {
        if (ws) { ws.close(); ws = null; }
        ws = new WebSocket('ws://localhost:9999');
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => showStatus('Видеопоток активен', 'success');

        ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer && event.data.byteLength > 0) {
                const blob = new Blob([event.data], { type: 'image/jpeg' });
                const url = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.drawImage(img, 0, 0);
                    URL.revokeObjectURL(url);
                };
                img.onerror = () => URL.revokeObjectURL(url);
                img.src = url;
            }
        };

        ws.onerror = () => showStatus('Ошибка видеопотока', 'error');

        ws.onclose = () => {
            if (isConnected) {
                showStatus('Видеопоток отключен', 'error');
                reconnectTimer = setTimeout(() => {
                    if (isConnected) connectWebSocket();
                }, 2000);
            }
        };
    }

    // ══════════════════════════════════════════════════════════
    // PTZ управление
    // ══════════════════════════════════════════════════════════
    function startPTZ(direction) {
        if (ptzInterval) clearInterval(ptzInterval);
        sendPTZCommand(direction);
        ptzInterval = setInterval(() => sendPTZCommand(direction), 200);
    }

    function stopPTZ() {
        if (ptzInterval) {
            clearInterval(ptzInterval);
            ptzInterval = null;
        }
        sendPTZCommand('stop');
    }

    async function sendPTZCommand(direction) {
        try {
            await window.electronAPI.ptzControl({ direction });
        } catch (err) {
            console.error('PTZ error:', err);
        }
    }

    // ══════════════════════════════════════════════════════════
    // История подключений
    // ══════════════════════════════════════════════════════════
    async function loadSavedCameras() {
        try {
            const cameras = await window.electronAPI.getSavedCameras();
            updateCameraHistory(cameras);
        } catch (err) {
            console.error('Error loading cameras:', err);
        }
    }

    function updateCameraHistory(cameras) {
        if (!cameraHistory) return;
        cameraHistory.innerHTML = '';
        cameras.forEach(cam => {
            const option = document.createElement('option');
            option.value = cam;
            cameraHistory.appendChild(option);
        });
        const clearOption = document.createElement('option');
        clearOption.value = '✕ Очистить историю';
        cameraHistory.appendChild(clearOption);
    }

    async function clearHistory() {
        if (confirm('Очистить историю подключений?')) {
            await window.electronAPI.clearHistory();
            loadSavedCameras();
        }
    }

    // ══════════════════════════════════════════════════════════
    // UI утилиты
    // ══════════════════════════════════════════════════════════
    let showStatusTimeout = null;
    function showStatus(message, type) {
        if (!statusMessage) return;
        statusMessage.hidden = false;
        statusMessage.textContent = message;
        statusMessage.className = 'status-message';
        switch (type) {
            case 'success': statusMessage.style.background = 'rgba(72, 187, 120, 0.9)'; break;
            case 'error':   statusMessage.style.background = 'rgba(245, 101, 101, 0.9)'; break;
            default:        statusMessage.style.background = 'rgba(0, 0, 0, 0.8)';
        }

        if (showStatusTimeout)
            clearTimeout(showStatusTimeout);

        showStatusTimeout = setTimeout(()=>{
            statusMessage.hidden = true;
        }, 2000)
    }

    function drawPlaceholder() {
        canvas.width = 800;
        canvas.height = 450;
        ctx.fillStyle = '#1a202c';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#4a5568';
        ctx.beginPath(); ctx.arc(canvas.width / 2, canvas.height / 2 - 30, 80, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1a202c';
        ctx.beginPath(); ctx.arc(canvas.width / 2 - 25, canvas.height / 2 - 40, 10, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(canvas.width / 2 + 25, canvas.height / 2 - 40, 10, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#1a202c'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(canvas.width / 2, canvas.height / 2 - 20, 40, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
        ctx.fillStyle = '#718096'; ctx.font = '20px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Видео будет здесь', canvas.width / 2, canvas.height - 30);
    }
});