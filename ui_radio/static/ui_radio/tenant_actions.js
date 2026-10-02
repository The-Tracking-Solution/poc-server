(() => {
    "use strict";

    const tenant = window.RADIO_TENANT || "";
    const AUDIO_SAMPLE_RATE = 16000;
    const EMERGENCY_OPEN_MIC_MS = 15000;
    const PTT_HEARTBEAT_MS = 750;
    const STATUS_HEARTBEAT_MS = 5000;
    const TELEMETRY_REPORT_MS = 60000;

    /*
     * Tijdelijk uitgeschakeld:
     * de volledige channel-presence logica blijft bestaan, maar wordt niet
     * meer aangeroepen in het kritieke PTT-pad.
     *
     * Later kan deze flag weer op true of kan checkChannelPresence()
     * vanuit een andere presence-flow worden aangeroepen.
     */
    const ENABLE_PTT_PRESENCE_CHECK = false;
    const T9_TIMEOUT_MS = 900;
    const WS_PING_INTERVAL_MS = 10000;
    const WS_PONG_TIMEOUT_MS = 15000;
    const CONTROL_RECONNECT_INTERVAL_MS = 10000;
    const CONTROL_CONNECT_TIMEOUT_MS = 8000;
    const CONNECTION_UNAVAILABLE_ANNOUNCE_MS = 60000;
    const T9_MAP = {
        "0": " ", "1": "1", "2": "ABC", "3": "DEF", "4": "GHI",
        "5": "JKL", "6": "MNO", "7": "PQRS", "8": "TUV", "9": "WXYZ",
        "*": "*", "#": "#",
    };

    const state = {
        initialized: false,
        identity: { display_name: window.RADIO_USER?.name || "Radio", user_slug: "" },
        channels: [],
        channelIndex: -1,
        statuses: [],
        statusIndex: -1,
        currentStatus: null,
        defaultTxPriority: 0,
        txPermissionMode: "conservative",
        channelEmergency: false,
        emergencyUsers: [],
        channelPresence: { radios: 0, dispatchers: 0, other_users: 0, linked: false, linked_channel_count: 1, linked_channel_names: [] },
        priority99Blocked: false,
        emergencyAccepted: false,
        priority: null,
        wsSessionId: null,
        wsAccessToken: "",
        webrtcTokenUrl: "",
        opusBitrateKbps: 20,
        opusDtx: true,
        opusRed: false,
        livekit: null,
        ws: null,
        wsReady: false,
        wsReconnectTimer: null,
        wsReconnectCountdownTimer: null,
        wsReconnectDueAt: 0,
        wsConnectTimeoutTimer: null,
        reconnectAttempt: 0,
        connectionLost: false,
        connectionUnavailableAnnouncementTimer: null,
        connectionLostAt: 0,
        mediaTransition: Promise.resolve(),
        controlGeneration: 0,
        wsPingTimer: null,
        wsPendingPingId: null,
        wsPendingPingStartedAt: 0,
        lastRoundtripMs: null,
        lastPongAt: null,
        wsClosingIntentionally: false,
        intentionalSockets: new WeakSet(),
        reconnectInFlight: false,
        connectionAttemptAnnounced: false,
        channelSwitchInFlight: false,
        channelSwitchSource: "",
        channelSwitchTargetSlug: "",
        channelSwitchQueue: Promise.resolve(),
        announcementQueue: Promise.resolve(),
        pttPressed: false,
        pttGranted: false,
        pttOptimistic: false,
        pttRequestId: 0,
        floorToken: "",
        pttHeartbeatTimer: null,
        pttAcquirePromise: null,
        floorWakeResolver: null,
        pttDeniedTonePlayed: false,
        pttBusyBuzzPlayed: false,
        busyBuzzOscillator: null,
        busyBuzzGain: null,
        busyBuzzTimer: null,
        pttBlocked: false,
        receivingSpeaker: null,
        micPermissionPending: false,
        audioContext: null,
        outputGain: null,
        micStream: null,
        micSource: null,
        micProcessor: null,
        micReadyPromise: null,
        audioTransmitActive: false,
        micRingBuffer: [],
        micRingBufferBytes: 0,
        playbackTime: 0,
        playbackSources: new Set(),
        playbackGeneration: 0,
        numericValue: "",
        t9Value: "",
        t9LastKey: null,
        t9LastAt: 0,
        t9CycleIndex: 0,
        volume: Math.max(0, Math.min(100, Number(localStorage.getItem("radio-volume") || 80))),
        handlers: {},
        emergencyStatusActive: false,
        emergencyAutoRunning: false,
        emergencyPhase: "idle",
        emergencyAutoTimer: null,
        emergencyCaptureActive: false,
        emergencyCaptureFrames: [],
        emergencyCaptureSamples: 0,
        errorOscillator: null,
        errorGain: null,
        keyHeld: false,
        androidAudioDiagnostics: {},
        lastHeartbeatTelemetry: null,
        lastDetailedTelemetryAt: 0,
    };

    function emit(name, detail = {}) {
        document.dispatchEvent(new CustomEvent(`ui_radio:${name}`, { detail }));
    }

    function feedback(message, kind = "info") {
        emit("feedback", { message, kind });
        state.handlers.feedback?.(message, kind);
        if(kind==="error"&&state.keyHeld)void startErrorTone();
    }

    function emitConnectionState() {
        const retryInSeconds = state.connectionLost && state.wsReconnectDueAt
            ? Math.max(0, Math.ceil((state.wsReconnectDueAt - Date.now()) / 1000))
            : 0;

        emit("connection", {
            lost: state.connectionLost,
            connected: !state.connectionLost,
            attempt: state.reconnectAttempt,
            retry_in_seconds: retryInSeconds,
            lost_at_ms: state.connectionLostAt || null,
        });
    }

    function stopReconnectCountdown() {
        if (state.wsReconnectCountdownTimer) {
            window.clearInterval(state.wsReconnectCountdownTimer);
        }
        state.wsReconnectCountdownTimer = null;
        state.wsReconnectDueAt = 0;
    }

    function startReconnectCountdown() {
        if (state.wsReconnectCountdownTimer) return;
        emitConnectionState();
        state.wsReconnectCountdownTimer = window.setInterval(() => {
            if (!state.connectionLost) {
                stopReconnectCountdown();
                return;
            }
            emitConnectionState();
        }, 250);
    }

    function stopUnavailableAnnouncements() {
        if (state.connectionUnavailableAnnouncementTimer) {
            window.clearInterval(state.connectionUnavailableAnnouncementTimer);
        }
        state.connectionUnavailableAnnouncementTimer = null;
    }

    function markConnectionLost(reason = "network") {
        if (!state.connectionLost) {
            state.connectionLost = true;
            state.connectionLostAt = Date.now();
            state.reconnectAttempt = Math.max(1, state.reconnectAttempt || 1);
            emitConnectionState();
            void queueLocalAnnouncement("Verbinding verloren");

            stopUnavailableAnnouncements();
            state.connectionUnavailableAnnouncementTimer = window.setInterval(() => {
                if (!state.connectionLost) return;
                void queueLocalAnnouncement("Verbinding niet beschikbaar");
            }, CONNECTION_UNAVAILABLE_ANNOUNCE_MS);
        }

        emit("audio", {
            state: "closed",
            reason,
            message: "Verbinding verloren",
        });
    }

    function markConnectionRestored() {
        const wasLost = state.connectionLost;

        state.connectionLost = false;
        state.connectionLostAt = 0;
        state.reconnectAttempt = 0;

        if (state.wsReconnectTimer) window.clearTimeout(state.wsReconnectTimer);
        state.wsReconnectTimer = null;
        stopReconnectCountdown();
        stopUnavailableAnnouncements();
        emitConnectionState();

        if (wasLost) {
            void queueLocalAnnouncement("Verbinding hersteld");
            emit("audio", {
                state: "connected",
                reason: "reconnect",
                message: "Verbinding hersteld",
            });
        }
    }

    // Legacy entry point kept for code paths that still call it.
    function setConnectionLost(lost, reconnecting = false) {
        if (lost) {
            markConnectionLost(reconnecting ? "reconnecting" : "network");
        } else {
            markConnectionRestored();
        }
    }


    function api(path, method = "GET", body, options = {}) {
        if (!window.RadioApi) throw new Error("RadioApi is niet geladen.");
        return window.RadioApi.request(path, method, body, options);
    }


    function channel() {
        return state.channels[state.channelIndex] || { slug: "", name: "—" };
    }

    function usesWebRtc() { return true; }

    async function ensureLiveKitChannel(channelSlug = channel().slug) {
        if (!window.PocLiveKitMedia) throw new Error("WebRTC media-engine is niet geladen.");
        if (!state.livekit) {
            state.livekit = new window.PocLiveKitMedia({
                tokenUrl: state.webrtcTokenUrl,
                accessToken: state.wsAccessToken,
                sessionId: state.wsSessionId,
                bitrateKbps: state.opusBitrateKbps,
                prepublishMicrophone: true,
                getOutputVolume: () => state.volume / 100,
                onState: connectionState => emit("webrtc", { state: connectionState }),
                onParrotFloorRequest: async () => {
                    for (let attempt = 0; attempt < 12; attempt += 1) {
                        try {
                            const result = await api("parrot/start/", "POST", {});
                            if (result?.started) return true;
                        } catch (_) {}
                        await new Promise(resolve => window.setTimeout(resolve, 100));
                    }
                    return false;
                },
                onParrotFloorRelease: async () => {
                    await api("parrot/stop/", "POST", {}).catch(() => {});
                },
                onEchoPlayback: (active, detail = {}) => {
                    const name = String(detail.name || "parrot");
                    if (active) {
                        state.receivingSpeaker = {
                            slug: "parrot", name, emergency: false, effective_priority: 0, simulated: true,
                        };
                        emit("receive", { state: "active", ...state.receivingSpeaker });
                    } else if (state.receivingSpeaker?.simulated && state.receivingSpeaker?.slug === "parrot") {
                        const previous = state.receivingSpeaker;
                        state.receivingSpeaker = null;
                        emit("receive", { state: "idle", ...previous });
                    }
                },
            });
        } else if (state.livekit.options) {
            // Bootstrap kan na een server-restart een nieuwe radio-sessie/token geven.
            // Houd het bestaande media-object daarom altijd gelijk aan de actuele
            // control/bootstrap credentials. Anders blijft LiveKit na een succesvolle
            // control-reconnect met oude autorisatie werken.
            state.livekit.options.tokenUrl = state.webrtcTokenUrl;
            state.livekit.options.accessToken = state.wsAccessToken;
            state.livekit.options.sessionId = state.wsSessionId;
            state.livekit.options.bitrateKbps = state.opusBitrateKbps;
        }
        await state.livekit.connect(channelSlug);
        return state.livekit;
    }

    function queueMediaTransition(operation) {
        state.mediaTransition = state.mediaTransition
            .catch(() => {})
            .then(operation);
        return state.mediaTransition;
    }



    function networkSnapshot() {
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
        return {
            online: navigator.onLine !== false,
            type: connection?.type || null,
            effective_type: connection?.effectiveType || null,
            downlink_mbps: Number.isFinite(Number(connection?.downlink)) ? Number(connection.downlink) : null,
            rtt_ms: Number.isFinite(Number(connection?.rtt)) ? Number(connection.rtt) : null,
            save_data: connection?.saveData === true,
        };
    }

    function heartbeatStatus() {
        const currentChannel = channel();
        const network = networkSnapshot();
        // Compact radio -> server liveness payload. Names/labels are already known server-side.
        return {
            r: Number.isFinite(Number(state.lastRoundtripMs)) ? Math.round(Number(state.lastRoundtripMs)) : null,
            n: network.online ? 1 : 0,
            nt: network.effective_type || network.type || null,
            c: currentChannel?.slug || null,
            s: state.currentStatus?.slug || null,
            tx: state.pttGranted === true || state.audioTransmitActive === true ? 1 : 0,
        };
    }

    function heartbeatTelemetry() {
        const raw = state.livekit
            ? state.livekit.takeTelemetry()
            : { transport: "webrtc", provider: "livekit", connection_state: "disconnected", samples: 0 };
        const webrtc = {
            transport: raw.transport || "webrtc",
            provider: raw.provider || "livekit",
            codec: raw.codec || "opus",
            connection_state: raw.connection_state || "unknown",
            samples: Number(raw.samples || 0),
            rtt_ms: raw.rtt_ms ?? null,
            jitter_ms: raw.jitter_ms ?? null,
            rx_loss_percent: raw.rx_loss_percent ?? null,
            tx_loss_percent: raw.tx_loss_percent ?? null,
            rx_bitrate_kbps: raw.rx_bitrate_kbps ?? null,
            tx_bitrate_kbps: raw.tx_bitrate_kbps ?? null,
            concealment_events_delta: raw.concealment_events_delta ?? null,
            remote_audio_tracks: Number(raw.remote_audio_tracks || 0),
            audio_elements: Number(raw.audio_elements || 0),
            active_remote_participant: raw.active_remote_participant || null,
            transmitting: raw.transmitting === true,
            receive_enabled: raw.receive_enabled !== false,
            native_audio: raw.native_audio === true,
            native_last_reason: raw.native_last_reason || null,
        };
        const telemetry = {
            webrtc,
            android_audio: state.androidAudioDiagnostics || {},
        };
        state.lastHeartbeatTelemetry = telemetry;
        return telemetry;
    }

    function heartbeatPayload() {
        const now = Date.now();
        const payload = { status: heartbeatStatus() };
        if (!state.lastDetailedTelemetryAt || now - state.lastDetailedTelemetryAt >= TELEMETRY_REPORT_MS) {
            payload.telemetry = heartbeatTelemetry();
            payload.telemetry_interval_ms = TELEMETRY_REPORT_MS;
            state.lastDetailedTelemetryAt = now;
        }
        return payload;
    }

    async function refreshRuntimeConfig(domains = []) {
        const data = await api("bootstrap/");
        const previousChannel = channel();
        const nextChannels = Array.isArray(data.channels) ? data.channels : state.channels;
        const nextStatuses = Array.isArray(data.statuses) ? data.statuses : state.statuses;
        state.identity = data.identity || state.identity;
        state.channels = nextChannels;
        state.statuses = nextStatuses;
        state.defaultTxPriority = Number(data.default_tx_priority ?? state.defaultTxPriority ?? 0);
        state.webrtcTokenUrl = data.audio?.webrtc_token_url || state.webrtcTokenUrl;
        state.opusBitrateKbps = Number(data.audio?.opus_bitrate_kbps || state.opusBitrateKbps || 20);
        state.opusDtx = data.audio?.opus_dtx !== false;
        state.opusRed = data.audio?.opus_red === true;
        const nextSlug = data.current_channel_slug || previousChannel.slug || "";
        state.channelIndex = state.channels.findIndex((item) => item.slug === nextSlug);
        if (state.channelIndex < 0 && state.channels.length) state.channelIndex = 0;
        state.statusIndex = state.statuses.findIndex((item) => item.slug === data.current_status_slug);
        state.currentStatus = state.statusIndex >= 0 ? { ...state.statuses[state.statusIndex] } : null;
        emit("config", { domains, identity: state.identity, channels: state.channels, statuses: state.statuses });
        emit("channel", { ...channel(), external: true, config_refresh: true });
        emit("status", state.currentStatus || {});
        if (previousChannel.slug !== channel().slug) connectControlSocket("channel-switch");
    }

    function handleConfigChanged(message) {
        if (!message || message.type !== "config_changed") return false;
        const domains = Array.isArray(message.domains) ? message.domains : [];
        // Alleen echte layout/hardware-wijzigingen vereisen een harde pagina-reload.
        // Contacts/identity/profile zijn runtime-data en worden hieronder via
        // bootstrap ververst. Daardoor kan een achtergrondservice (zoals
        // test-clock) nooit meer tenant-breed alle radio-pagina's reloaden.
        if (domains.some((item) => item === "screens" || item === "hardware")) {
            window.clearTimeout(state.configReloadTimer);
            state.configReloadTimer = window.setTimeout(() => window.location.reload(), 150);
            return true;
        }
        window.clearTimeout(state.configRefreshTimer);
        state.configRefreshTimer = window.setTimeout(() => {
            void refreshRuntimeConfig(domains).catch(() => {});
        }, 100);
        return true;
    }

    function setVolume(next) {
        state.volume = Math.max(0, Math.min(100, Math.round(next)));
        localStorage.setItem("radio-volume", String(state.volume));
        if (state.outputGain) state.outputGain.gain.value = state.volume / 100;
        document.querySelectorAll("audio,video").forEach((media) => { media.volume = state.volume / 100; });
        try { state.livekit?.setOutputVolume?.(state.volume / 100); } catch (_) {}
        emit("volume", { value: state.volume });
        feedback(`Volume ${state.volume}%`);
        return state.volume;
    }

    async function ensureAudioContext() {
        if (!state.audioContext) {
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            state.outputGain = state.audioContext.createGain();
            state.outputGain.gain.value = state.volume / 100;
            state.outputGain.connect(state.audioContext.destination);
            state.playbackTime = state.audioContext.currentTime;
        }
        if (state.audioContext.state === "suspended") await state.audioContext.resume();
        return state.audioContext;
    }

    function wait(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function waitForFloorWake(ms = 1000) {
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                if (state.floorWakeResolver === finish) state.floorWakeResolver = null;
                window.clearTimeout(timer);
                resolve();
            };
            const timer = window.setTimeout(finish, ms);
            state.floorWakeResolver = finish;
        });
    }

    async function playUiTone(frequency, durationMs, startDelayMs = 0, gainValue = 0.18) {
        const context = await ensureAudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const startAt = context.currentTime + (startDelayMs / 1000);
        const stopAt = startAt + (durationMs / 1000);

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(gainValue, startAt + 0.008);
        gain.gain.setValueAtTime(gainValue, Math.max(startAt + 0.008, stopAt - 0.025));
        gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);

        oscillator.connect(gain);
        gain.connect(state.outputGain || context.destination);
        oscillator.start(startAt);
        oscillator.stop(stopAt + 0.005);
        oscillator.onended = () => {
            try { oscillator.disconnect(); } catch (_) {}
            try { gain.disconnect(); } catch (_) {}
        };
        return stopAt;
    }

    async function playTransmitGrantedTone() {
        // Twee korte oplopende tonen zodra de backend de spreekvloer toekent.
        await ensureAudioContext();
        await Promise.all([
            playUiTone(660, 75, 0, 0.16),
            playUiTone(880, 75, 105, 0.16),
        ]);
        await wait(190);
    }

    async function playTransmitDeniedTone() {
        // Eén lage toon bij definitieve weigering of verlies van zendtoegang.
        await playUiTone(240, 190, 0, 0.20);
    }

    function stopBusyBuzz() {
        if (state.busyBuzzTimer) window.clearTimeout(state.busyBuzzTimer);
        state.busyBuzzTimer = null;
        try { state.busyBuzzOscillator?.stop(); } catch (_) {}
        try { state.busyBuzzOscillator?.disconnect(); } catch (_) {}
        try { state.busyBuzzGain?.disconnect(); } catch (_) {}
        state.busyBuzzOscillator = null;
        state.busyBuzzGain = null;
    }

    async function startBusyBuzz() {
        // Lage bezet-brom: maximaal 1 seconde en altijd direct stoppen op PTT-up.
        if (state.busyBuzzOscillator || !state.pttPressed) return;
        const context = await ensureAudioContext();
        if (!state.pttPressed) return;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = 190;
        gain.gain.value = 0.18;
        oscillator.connect(gain);
        gain.connect(state.outputGain || context.destination);
        state.busyBuzzOscillator = oscillator;
        state.busyBuzzGain = gain;
        oscillator.start();
        state.busyBuzzTimer = window.setTimeout(stopBusyBuzz, 1000);
    }

    async function speakLocalAnnouncement(message) {
        emit("audio-message", { state: "active", message });
        if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
            emit("audio-message", { state: "idle", message });
            return false;
        }
        const played = await new Promise((resolve) => {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(message);
            utterance.lang = "nl-NL";
            utterance.rate = 0.95;
            utterance.volume = state.volume / 100;
            utterance.onend = () => resolve(true);
            utterance.onerror = () => resolve(false);
            window.speechSynthesis.speak(utterance);
        });
        emit("audio-message", { state: "idle", message });
        return played;
    }

    function queueLocalAnnouncement(message) {
        const queued = state.announcementQueue
            .catch(() => false)
            .then(() => speakLocalAnnouncement(message));
        state.announcementQueue = queued;
        return queued;
    }

    async function playMorseLetter(pattern, frequency = 760) {
        const unit = 110;
        for (let index = 0; index < pattern.length; index += 1) {
            const duration = pattern[index] === "-" ? unit * 3 : unit;
            await playUiTone(frequency, duration, 0, 0.18);
            await wait(duration + (index < pattern.length - 1 ? unit : 0));
        }
    }

    const playLocalMorseK = () => playMorseLetter("-.-");
    const playLocalMorseR = () => playMorseLetter(".-.");
    const playEmergencyWaitBeep = () => playUiTone(520, 180, 0, 0.18);
    async function startErrorTone(){
        if(state.errorOscillator)return;
        const context=await ensureAudioContext(),oscillator=context.createOscillator(),gain=context.createGain();
        oscillator.frequency.value=190;gain.gain.value=.18;oscillator.connect(gain);gain.connect(state.outputGain||context.destination);oscillator.start();state.errorOscillator=oscillator;state.errorGain=gain;
    }
    function stopErrorTone(){
        try{state.errorOscillator?.stop()}catch(_){}try{state.errorOscillator?.disconnect()}catch(_){}try{state.errorGain?.disconnect()}catch(_){}state.errorOscillator=null;state.errorGain=null;
    }
    function keyTone(event){
        const kind=event.detail?.kind;
        if(kind==="press"){state.keyHeld=true;void playUiTone(720,55,0,.14)}
        if(kind==="long")void Promise.all([playUiTone(720,55,0,.14),playUiTone(720,55,90,.14)]);
        if(kind==="error-start"){state.keyHeld=true;void startErrorTone()}
        if(kind==="release"||kind==="error-stop"){state.keyHeld=false;stopErrorTone()}
    }

    function resetPlayback() {
        state.playbackGeneration += 1;
        for (const source of state.playbackSources) {
            try { source.stop(); } catch (_) {}
            try { source.disconnect(); } catch (_) {}
        }
        state.playbackSources.clear();
        state.playbackTime = state.audioContext ? state.audioContext.currentTime : 0;
    }


    function controlWebsocketUrl() {
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        const params = new URLSearchParams({
            session_id: state.wsSessionId,
            access_token: state.wsAccessToken,
        });
        return `${scheme}://${location.host}/poc/ws/v1/control/${encodeURIComponent(tenant)}/${encodeURIComponent(channel().slug)}/?${params}`;
    }

    function stopControlPing() {
        if (state.wsPingTimer) window.clearInterval(state.wsPingTimer);
        state.wsPingTimer = null;
        state.wsPendingPingId = null;
        state.wsPendingPingStartedAt = 0;
    }

    function sendControlPing(ws) {
        if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) return;

        // Stuur nooit een nieuwe ping over een nog onbeantwoorde ping heen.
        // Anders kan een half-open TCP/WebSocket eindeloos als OPEN blijven staan
        // zonder dat de reconnect-flow ooit wordt gestart.
        if (state.wsPendingPingId && state.wsPendingPingStartedAt) {
            const pendingMs = performance.now() - state.wsPendingPingStartedAt;
            if (pendingMs >= WS_PONG_TIMEOUT_MS) {
                try { ws.close(4001, "pong-timeout"); } catch (_) {}
                return;
            }
            return;
        }

        const pingId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        state.wsPendingPingId = pingId;
        state.wsPendingPingStartedAt = performance.now();
        try {
            ws.send(JSON.stringify({ type: "ping", ping_id: pingId }));
        } catch (_) {
            try { ws.close(4002, "ping-send-failed"); } catch (_) {}
        }
    }

    function startControlPing(ws) {
        stopControlPing();
        sendControlPing(ws);
        state.wsPingTimer = window.setInterval(() => sendControlPing(ws), WS_PING_INTERVAL_MS);
    }

    function handleControlPong(message) {
        if (!message || message.type !== "pong") return false;
        if (message.ping_id && message.ping_id === state.wsPendingPingId && state.wsPendingPingStartedAt) {
            state.lastRoundtripMs = Math.max(0, Math.round(performance.now() - state.wsPendingPingStartedAt));
            state.lastPongAt = new Date().toISOString();
            state.wsPendingPingId = null;
            state.wsPendingPingStartedAt = 0;
            emit("audio-roundtrip", {
                roundtrip_ms: state.lastRoundtripMs,
                last_pong_at: state.lastPongAt,
                server_timestamp_ms: message.timestamp_ms ?? null,
            });
        }
        return true;
    }

    function applyBootstrapConnectionData(data) {
        if (!data || typeof data !== "object") return;
        const nextChannels = Array.isArray(data.channels) ? data.channels : state.channels;
        const wantedSlug = data.current_channel_slug || channel().slug || "";
        state.channels = nextChannels;
        state.channelIndex = state.channels.findIndex((item) => item.slug === wantedSlug);
        if (state.channelIndex < 0 && state.channels.length) state.channelIndex = 0;
        state.wsSessionId = data.audio?.session_id || state.wsSessionId || null;
        state.wsAccessToken = data.audio?.access_token || state.wsAccessToken || "";
        state.webrtcTokenUrl = data.audio?.webrtc_token_url || state.webrtcTokenUrl;
        state.opusBitrateKbps = Number(data.audio?.opus_bitrate_kbps || state.opusBitrateKbps || 20);
        state.opusDtx = data.audio?.opus_dtx !== false;
        state.opusRed = data.audio?.opus_red === true;
    }

    async function reconnectFromFreshBootstrap() {
        if (state.reconnectInFlight || !state.connectionLost) return;
        state.reconnectInFlight = true;
        let retryNeeded = false;
        try {
            const data = await api("bootstrap/", "GET", undefined, { cache: "no-store" });
            if (!state.connectionLost) return;
            applyBootstrapConnectionData(data);
            if (!channel().slug || !state.wsSessionId || !state.wsAccessToken) {
                throw new Error("Bootstrap bevat geen bruikbare radioverbinding.");
            }
            connectControlSocket("reconnect");
        } catch (error) {
            if (!state.connectionLost) return;
            state.reconnectAttempt = Math.max(1, state.reconnectAttempt + 1);
            retryNeeded = true;
            emit("connection", {
                lost: true,
                connected: false,
                attempt: state.reconnectAttempt,
                retry_in_seconds: Math.ceil(CONTROL_RECONNECT_INTERVAL_MS / 1000),
                connecting: false,
            });
        } finally {
            state.reconnectInFlight = false;
            // Pas plannen nadat reconnectInFlight is vrijgegeven. In de oude code
            // werd scheduleControlReconnect() vanuit catch aangeroepen terwijl deze
            // flag nog true was, waardoor de retry-keten kon stoppen.
            if (retryNeeded && state.connectionLost) {
                scheduleControlReconnect();
            }
        }
    }

    function scheduleControlReconnect(delayMs = CONTROL_RECONNECT_INTERVAL_MS) {
        if (!state.connectionLost) return;
        if (state.wsReconnectTimer) return;

        if (state.reconnectAttempt < 1) state.reconnectAttempt = 1;
        const delay = Math.max(0, Number(delayMs) || 0);
        state.wsReconnectDueAt = Date.now() + delay;
        startReconnectCountdown();

        state.wsReconnectTimer = window.setTimeout(() => {
            state.wsReconnectTimer = null;
            stopReconnectCountdown();
            if (!state.connectionLost) return;
            if (state.reconnectInFlight) {
                // Een vorige HTTP/bootstrap-poging is nog bezig. Niet de retry kwijt
                // raken: probeer kort daarna opnieuw.
                scheduleControlReconnect(500);
                return;
            }
            emit("connection", {
                lost: true,
                connected: false,
                attempt: state.reconnectAttempt,
                retry_in_seconds: 0,
                connecting: true,
            });
            void reconnectFromFreshBootstrap();
        }, delay);
    }

    function disconnectCurrentChannelControl(reason = "channel-switch") {
        if (reason !== "reconnect" && state.wsReconnectTimer) {
            window.clearTimeout(state.wsReconnectTimer);
            state.wsReconnectTimer = null;
        }
        if (reason !== "reconnect") stopReconnectCountdown();
        state.wsReady = false;
        stopControlPing();
        if (state.wsConnectTimeoutTimer) {
            window.clearTimeout(state.wsConnectTimeoutTimer);
            state.wsConnectTimeoutTimer = null;
        }
        resetPlayback();

        if (state.receivingSpeaker) {
            const previous = state.receivingSpeaker;
            state.receivingSpeaker = null;
            emit("receive", { state: "idle", ...previous, reason });
        }

        if (state.livekit) {
            void queueMediaTransition(() => state.livekit?.close?.() || Promise.resolve());
        }
        const previousSocket = state.ws;
        state.ws = null;
        if (previousSocket) {
            state.intentionalSockets.add(previousSocket);
            // Geen enkel laat frame van het oude kanaal mag nog worden
            // verwerkt nadat de gebruiker de kanaalwissel heeft gestart.
            previousSocket.onmessage = null;
            previousSocket.onerror = null;
            try { previousSocket.close(1000, reason); } catch (_) {}
        }
    }

    async function prepareChannelSwitch(source = "channel-switch", targetSlug = "") {
        // Kanaalwissel is een gecontroleerde handover, geen netwerkstoring.
        // Houd de bestaande control/media-verbinding zo lang mogelijk in stand.
        // Dit voorkomt een onnodige offline-gap terwijl de server de selectie verwerkt.
        state.channelSwitchInFlight = true;
        state.channelSwitchSource = source;
        state.channelSwitchTargetSlug = targetSlug || "";

        if (state.wsReconnectTimer) window.clearTimeout(state.wsReconnectTimer);
        state.wsReconnectTimer = null;
        stopReconnectCountdown();

        emit("audio", {
            state: "connecting",
            reason: "channel-switch",
            message: "Activeren",
            announce: false,
        });

        // Geef een eventueel actieve floor eerst netjes vrij via de nog werkende
        // oude controlverbinding. Sluit die socket hier bewust nog NIET.
        if (state.pttPressed || state.pttGranted || state.floorToken) {
            await pttRelease(source);
        } else {
            stopAudioTransmission();
        }
    }

    function finishChannelSwitch() {
        state.channelSwitchInFlight = false;
        state.channelSwitchSource = "";
        state.channelSwitchTargetSlug = "";
    }

    function queueChannelSwitch(operation) {
        // Rotary/hardware-input kan meerdere acties zeer snel achter elkaar sturen.
        // Serializeer handovers zodat twee kanaalwissels nooit tegelijk sockets,
        // bootstrap-data en LiveKit rooms kunnen vervangen.
        const run = state.channelSwitchQueue
            .catch(() => {})
            .then(operation);
        state.channelSwitchQueue = run.catch(() => {});
        return run;
    }

    function connectControlSocket(reason = "channel-switch") {
        const channelSlug = channel().slug;
        const channelName = channel().name;
        const generation = ++state.controlGeneration;
        const isReconnect = reason === "reconnect";
        const isStartup = reason === "startup";

        disconnectCurrentChannelControl(reason);
        if (!channelSlug || !state.wsSessionId || !state.wsAccessToken) return;

        if (isStartup && !state.connectionAttemptAnnounced) {
            state.connectionAttemptAnnounced = true;
            emit("audio", {
                state: "connecting",
                reason,
                message: "Activeren",
                announce: false,
            });
        }

        let ws;
        try {
            ws = new WebSocket(controlWebsocketUrl());
        } catch (error) {
            if (generation !== state.controlGeneration) return;
            markConnectionLost("socket-create");
            if (isReconnect) state.reconnectAttempt += 1;
            scheduleControlReconnect();
            return;
        }

        state.ws = ws;

        // Een WebSocket kan bij een server-restart in CONNECTING blijven hangen
        // zonder tijdig onclose te geven. Forceer dan een nieuwe verse bootstrap.
        state.wsConnectTimeoutTimer = window.setTimeout(() => {
            if (generation !== state.controlGeneration || state.ws !== ws) return;
            if (ws.readyState === WebSocket.OPEN) return;
            state.wsConnectTimeoutTimer = null;
            try { ws.close(); } catch (_) {}
            state.ws = null;
            state.wsReady = false;
            if (state.channelSwitchInFlight) finishChannelSwitch();
            markConnectionLost("socket-open-timeout");
            state.reconnectAttempt = Math.max(1, state.reconnectAttempt + 1);
            scheduleControlReconnect();
        }, CONTROL_CONNECT_TIMEOUT_MS);

        ws.onopen = () => {
            if (generation !== state.controlGeneration || state.ws !== ws) return;

            if (state.wsConnectTimeoutTimer) {
                window.clearTimeout(state.wsConnectTimeoutTimer);
                state.wsConnectTimeoutTimer = null;
            }
            state.wsReady = true;
            state.connectionAttemptAnnounced = false;
            startControlPing(ws);

            if (reason === "channel-switch") {
                finishChannelSwitch();
            }

            // De control-WebSocket is de bron voor de algemene verbindingsstatus.
            // Een tijdelijke WebRTC/LiveKit-fout mag deze werkende verbinding niet
            // meer sluiten of als "Verbinding verloren" markeren.
            markConnectionRestored();

            void queueMediaTransition(async () => {
                if (generation !== state.controlGeneration || state.ws !== ws) return;
                await ensureLiveKitChannel(channelSlug);
                if (generation !== state.controlGeneration || state.ws !== ws) return;

                emit("audio", {
                    state: "connected",
                    reason: "media-connect",
                    message: "Audioverbinding gereed",
                });

                // Kanaalnaam alleen uitspreken als deze verbinding nog bij dit kanaal hoort.
                if (channel().slug === channelSlug) {
                    void queueLocalAnnouncement(channelName);
                }
            }).catch(error => {
                if (generation !== state.controlGeneration || state.ws !== ws) return;
                feedback(`WebRTC verbinden mislukt: ${error.message}`, "error");
                emit("audio", {
                    state: "error",
                    reason: "media-connect",
                    message: "Audioverbinding niet beschikbaar",
                });
                // Laat de control-WebSocket open. LiveKit kan bij een volgende
                // media-actie opnieuw verbinden zonder het hele radiokanaal af te breken.
            });
        };

        ws.onclose = event => {
            if (generation !== state.controlGeneration || state.ws !== ws) return;

            state.ws = null;
            state.wsReady = false;
            stopControlPing();
            if (state.wsConnectTimeoutTimer) {
                window.clearTimeout(state.wsConnectTimeoutTimer);
                state.wsConnectTimeoutTimer = null;
            }

            if (state.intentionalSockets.has(ws)) return;
            // De server kan de oude controlsocket zelf sluiten zodra de kanaalselectie
            // is verwerkt. Tijdens een gecontroleerde handover is dat verwacht gedrag.
            if (state.channelSwitchInFlight) return;

            markConnectionLost(`socket-close-${event.code}`);
            if (isReconnect || state.reconnectAttempt > 0) {
                state.reconnectAttempt = Math.max(1, state.reconnectAttempt + 1);
            } else {
                state.reconnectAttempt = 1;
            }
            scheduleControlReconnect();
        };

        ws.onerror = () => {
            if (generation !== state.controlGeneration || state.ws !== ws) return;
            if (state.channelSwitchInFlight) return;
            emit("audio", { state: "error" });
        };

        ws.onmessage = async event => {
            if (generation !== state.controlGeneration || state.ws !== ws) return;
            if (typeof event.data === "string") {
                try {
                    const message = JSON.parse(event.data);
                    if (handleControlPong(message)) return;
                    if (handleConfigChanged(message)) return;
                    emit("audio", message);
                    handleChannelControl(message);
                } catch (_) {}
                return;
            }
            try {
                ws.close(4400, "Binary media is niet toegestaan; gebruik WebRTC/Opus.");
            } catch (_) {}
        };
    }

    function reconnectControl() {
        markConnectionLost("manual-reconnect");
        if (state.wsReconnectTimer) window.clearTimeout(state.wsReconnectTimer);
        state.wsReconnectTimer = null;
        stopReconnectCountdown();
        disconnectCurrentChannelControl("manual-reconnect");
        if (state.reconnectAttempt < 1) state.reconnectAttempt = 1;
        scheduleControlReconnect(0);
    }

    async function waitForSocket(timeoutMs = 2000) {
        if (state.wsReady && state.ws?.readyState === WebSocket.OPEN) return true;
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (state.wsReady && state.ws?.readyState === WebSocket.OPEN) return true;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
    }



    async function ensureMicrophoneReady() { await ensureLiveKitChannel(); }

    async function startAudioTransmission() {
        if (!(await waitForSocket())) throw new Error("Controlverbinding is niet gereed.");
        const media = await ensureLiveKitChannel();
        await media.setTransmit(true);
        state.audioTransmitActive = true;
    }

    function finishEmergencyCapture() {
        state.emergencyCaptureActive = false;
    }

    function startEmergencyCapture() {
        state.emergencyCaptureFrames = [];
        state.emergencyCaptureSamples = 0;
        state.emergencyCaptureActive = true;
    }


    async function forwardEmergencyCapture() { throw new Error("Raw PCM is verwijderd; WebRTC/Opus is de enige media-engine."); }


    async function sendEmergencySos() { throw new Error("Raw PCM is verwijderd; WebRTC/Opus is de enige media-engine."); }

    async function startEmergencyAudioTransmission(maxTxDurationMs = EMERGENCY_OPEN_MIC_MS) {
        if (!(await waitForSocket())) throw new Error("Controlverbinding is niet gereed.");
        const media = await ensureLiveKitChannel();
        await media.setTransmit(true);
        state.audioTransmitActive = true;
        emit("ptt", {
            state: "active",
            source: "emergency-auto",
            max_tx_duration_ms: Number(maxTxDurationMs || EMERGENCY_OPEN_MIC_MS),
        });
        await wait(EMERGENCY_OPEN_MIC_MS);
        if (state.pttPressed && state.pttGranted) {
            stopAudioTransmission();
            await playLocalMorseR();
            await pttRelease("emergency-capture-complete");
            state.emergencyPhase = "standby";
            emit("sos", { state: "standby", message: "cancel? druk kort op noodknop" });
        }
    }

    function stopAudioTransmission() {
        const wasActive = state.audioTransmitActive;
        state.audioTransmitActive = false;
        if (wasActive && state.livekit) void state.livekit.setTransmit(false).catch(() => {});
    }

    function stopPttHeartbeat() {
        if (state.pttHeartbeatTimer) window.clearInterval(state.pttHeartbeatTimer);
        state.pttHeartbeatTimer = null;
    }

    function effectiveTxPriority(source = "ui") {
        if (source === "emergency-auto") return 99;
        if (Number(state.currentStatus?.call_request_priority) === 1) return 90;
        return Number(state.defaultTxPriority || 0);
    }

    function waitingMessage(reason = "waiting", source = "ui") {
        const messages = {
            requesting: `Zendtoestemming aanvragen (${effectiveTxPriority(source)})`,
            proactive: "Direct zenden · servercontrole",
            waiting: "Wachten op zendtoestemming",
            server_wait: "Wachten op serverresponse",
        };
        return messages[reason] || "Wachten op zendtoestemming";
    }

    function blockedMessage(reason = "denied", fallback = "") {
        if (fallback) return fallback;
        const messages = {
            denied: "Zendtoestemming geweigerd",
            floor_revoked: "Zendtoestemming ingetrokken",
            heartbeat_rejected: "Zendtoestemming ingetrokken",
            no_channel: "Geen zendtoestemming op dit kanaal",
            connection_lost: "Verbinding met server verloren",
        };
        return messages[reason] || "Zendtoestemming niet beschikbaar";
    }

    function emitWaitingPtt(source = "ui", reason = "waiting") {
        emit("ptt", {
            state: "waiting",
            source,
            reason,
            message: waitingMessage(reason, source),
        });
    }

    async function notifyTransmitDenied(source = "ui", reason = "denied", message = "") {
        state.pttBlocked = true;
        if (!state.pttDeniedTonePlayed) {
            state.pttDeniedTonePlayed = true;
            try { await playTransmitDeniedTone(); } catch (_) {}
        }
        if(state.keyHeld)void startErrorTone();
        emit("ptt", {
            state: "blocked",
            source,
            reason,
            message: blockedMessage(reason, message),
        });
    }

    function clearGrantedPttState() {
        stopPttHeartbeat();
        stopAudioTransmission();
        state.pttGranted = false;
        state.pttOptimistic = false;
        state.floorToken = "";
        if (state.emergencyAutoTimer) window.clearTimeout(state.emergencyAutoTimer);
        state.emergencyAutoTimer = null;
        state.emergencyAutoRunning = false;
        if (state.emergencyCaptureActive) finishEmergencyCapture();
    }

    async function handleTransmitLost(reason = "floor_revoked", source = "server") {
        if (!state.pttPressed) {
            clearGrantedPttState();
            state.pttBlocked = false;
            emit("ptt", { state: "idle", source, reason });
            return;
        }

        const priorityPreemption = reason === "priority_91_99_preemption" || reason === "higher_priority_hold_preemption";
        clearGrantedPttState();
        if (priorityPreemption) {
            // De fysieke PTT is nog ingedrukt: na preëmptie niet blokkeren,
            // maar direct opnieuw als waiter aansluiten achter de nieuwe TX.
            state.pttBlocked = false;
            state.pttBusyBuzzPlayed = false;
            void startBusyBuzz();
            emitWaitingPtt(source, "waiting");
            void acquirePttWhilePressed(source);
            return;
        }

        // Andere revokes (beheer, heartbeat, verbinding) blijven definitief
        // geblokkeerd tot de gebruiker de PTT loslaat.
        await notifyTransmitDenied(source, reason);
    }

    function startPttHeartbeat() {
        stopPttHeartbeat();
        state.pttHeartbeatTimer = window.setInterval(async () => {
            if (!state.pttPressed || !state.pttGranted) return stopPttHeartbeat();
            try {
                await api("ptt/heartbeat/", "POST", {});
            } catch (error) {
                feedback(error.message, "error");
                await handleTransmitLost("heartbeat_rejected", "server");
            }
        }, PTT_HEARTBEAT_MS);
    }

    function handleChannelControl(message = {}) {
        const ownSlug = state.identity?.user_slug || "";
        const ownSession = Number(state.wsSessionId || 0);

        if (message.type === "channel_links_changed") {
            // Link/unlink heeft twee onafhankelijke effecten:
            // 1) de presence/link-indicator in de titelbalk moet direct uit de
            //    actuele database worden vernieuwd;
            // 2) alleen de media-room moet opnieuw aansluiten. De control-WS
            //    blijft gewoon open.
            //
            // Presence bewust BUITEN de media-transition uitvoeren. Als een
            // LiveKit reconnect faalt, mag de oude flowchart nooit blijven
            // hangen in het display.
            void refreshChannelPresence();

            void queueMediaTransition(async () => {
                if (state.livekit) {
                    try { await state.livekit.close(); } catch (_) {}
                    state.livekit = null;
                }
                if (state.wsReady && channel().slug) {
                    await ensureLiveKitChannel(channel().slug);
                }
            }).then(() => {
                // Na het aansluiten nogmaals ophalen zodat de titelbalk en
                // aantallen exact overeenkomen met de nieuwe linkgroep.
                void refreshChannelPresence();
            }).catch(() => {
                // Ook bij een mediafout de linkstatus nogmaals verversen.
                void refreshChannelPresence();
            });

            // Een tweede korte retry vangt snelle opeenvolgende link/unlink
            // transacties op zonder op de normale heartbeat te wachten.
            window.setTimeout(() => { void refreshChannelPresence(); }, 400);
            window.setTimeout(() => { void refreshChannelPresence(); }, 1200);
            return;
        }

        if (message.type === "control_ready" && Number(message.effective_priority) === 99) {
            state.emergencyAccepted = message.emergency_accepted === true;
            state.priority99Blocked = !state.emergencyAccepted;
            if (state.priority99Blocked) emit("emergency-block", {
                active: true, channel: channel().name,
                message: `Geblokkeerd door noodoproep: [${channel().name}]`,
            });
        }

        if (message.type === "floor_available" && Number(message.session_id || 0) === ownSession) {
            // Server heeft deze sessie als beste waiter gekozen na release.
            // Maak de polling-wacht direct wakker zodat de floor vrijwel
            // onmiddellijk geclaimd wordt, zonder agressieve HTTP-polling.
            state.floorWakeResolver?.();
            return;
        }

        if (message.type === "floor_granted") {
            if (Number(message.session_id || 0) !== ownSession) {
                if (message.emergency === true && Number(message.effective_priority) === 99) {
                    state.priority99Blocked = true;
                    state.emergencyAccepted = false;
                    if (state.pttPressed || state.pttGranted) void pttRelease("priority-99-block");
                    emit("emergency-block", {
                        active: true,
                        channel: channel().name,
                        message: `Geblokkeerd door noodoproep: [${channel().name}]`,
                    });
                }
                state.receivingSpeaker = {
                    slug: message.speaker_slug || "",
                    name: message.speaker_name || message.speaker_slug || "Radio",
                    emergency: message.emergency === true,
                    effective_priority: Number(message.effective_priority || 0),
                };
                emit("receive", { state: "active", ...state.receivingSpeaker });
            }
            return;
        }

        if (message.type === "channel_emergency") {
            state.channelEmergency = message.active === true;
            state.emergencyUsers = Array.isArray(message.users) ? message.users : [];
            emit("channel-emergency", {
                active: state.channelEmergency,
                users: state.emergencyUsers,
            });
            return;
        }

        if (message.type === "emergency_accepted") {
            state.emergencyAccepted = true;
            state.priority99Blocked = false;
            emit("emergency-block", { active: false, channel: channel().name });
            return;
        }



        if (message.type === "floor_released") {
            if (state.priority99Blocked) {
                state.priority99Blocked = false;
                emit("emergency-block", { active: false, channel: channel().name });
            }
            if (state.receivingSpeaker && (!message.speaker_slug || message.speaker_slug === state.receivingSpeaker.slug)) {
                const previous = state.receivingSpeaker;
                state.receivingSpeaker = null;
                emit("receive", { state: "idle", ...previous });
            }
            return;
        }

        if (message.type === "floor_revoked" && Number(message.session_id || 0) === ownSession) {
            void handleTransmitLost(message.reason || "floor_revoked", "server");
        }
    }

    async function refreshChannelPresence() {
        try {
            const presence = await api("channel-presence/");
            state.channelPresence = {
                radios: Number(presence.radios || 0),
                dispatchers: Number(presence.dispatchers || 0),
                other_users: Number(presence.other_users || 0),
                linked: presence.linked === true,
                linked_channel_count: Math.max(1, Number(presence.linked_channel_count || 1)),
                linked_channel_names: Array.isArray(presence.linked_channel_names)
                    ? presence.linked_channel_names.map(String)
                    : [],
            };
            emit("presence", {
                ...state.channelPresence,
                channel_slug: presence.channel_slug || channel().slug || "",
            });
            return state.channelPresence;
        } catch (_) {
            // Presence is informatief en mag radio/PTT nooit blokkeren.
            return state.channelPresence;
        }
    }

    async function checkChannelPresenceForPtt(source, requestId) {
        try {
            const presence = await api("channel-presence/");

            if (!state.pttPressed || requestId !== state.pttRequestId) {
                return { ok: false, cancelled: true };
            }

            if (Number(presence.other_users || 0) < 1) {
                const message = "U bent de enige gebruiker op dit kanaal";
                emit("ptt", { state: "waiting", source, reason: "only_user", message });
                feedback(message, "info");
                await speakLocalAnnouncement(message);

                if (!state.pttPressed || requestId !== state.pttRequestId) {
                    return { ok: false, cancelled: true };
                }
            }

            return { ok: true, presence };
        } catch (error) {
            if (!state.pttPressed || requestId !== state.pttRequestId) {
                return { ok: false, cancelled: true };
            }

            state.pttPressed = false;
            state.pttRequestId += 1;
            feedback(`Aanwezigheidscontrole mislukt: ${error.message}`, "error");
            emit("ptt", { state: "idle", source, reason: "presence_error" });
            return { ok: false, error };
        }
    }

    async function acquirePttWhilePressed(source = "ui") {
        if (state.pttAcquirePromise) return state.pttAcquirePromise;
        if (!state.pttPressed || state.pttBlocked) return false;
        const requestId = state.pttRequestId;
        // Automatische noodoproep houdt de bestaande, conservatieve SOS-flow.
        // Normale PTT volgt de tenant-brede toestemmingmodus.
        const proactive = state.txPermissionMode === "proactive" && source !== "emergency-auto";

        state.pttAcquirePromise = (async () => {
            emitWaitingPtt(source, proactive ? "proactive" : "requesting");
            try {
                let waitedForFloor = false;
                if (proactive) {
                    // Optimistic floor: de reeds gepubliceerde/muted LiveKit-track
                    // wordt lokaal direct geopend. De servercontrole loopt parallel.
                    await startAudioTransmission();
                    if (!state.pttPressed || requestId !== state.pttRequestId) {
                        stopAudioTransmission();
                        return false;
                    }
                    state.pttOptimistic = true;
                    state.pttDeniedTonePlayed = false;
                    await playTransmitGrantedTone();
                    emit("ptt", { state: "active", source, optimistic: true });
                }

                let data;
                let pttLocationAttached = false;
                while (state.pttPressed && requestId === state.pttRequestId) {
                    const controller = new AbortController();
                    const timeout = window.setTimeout(() => controller.abort(), 2000);
                    try {
                        data = await api(
                            "ptt/start/",
                            "POST",
                            {
                                automatic_emergency: source === "emergency-auto",
                                ...(!pttLocationAttached && locationEnabled && lastLocationPayload
                                    ? { location: lastLocationPayload }
                                    : {}),
                            },
                            { signal: controller.signal },
                        );
                        if (locationEnabled && lastLocationPayload) pttLocationAttached = true;
                    } catch (error) {
                        if (error.name === "AbortError") throw new Error("Verbinding niet binnen 2 seconden beschikbaar.");
                        throw error;
                    } finally {
                        window.clearTimeout(timeout);
                    }
                    if (!data.waiting) break;
                    waitedForFloor = true;
                    // De optimistic TX mag alleen lopen tot de server meldt dat
                    // het kanaal bezet is. Daarna direct mute en in de queue blijven.
                    if (state.pttOptimistic) {
                        stopAudioTransmission();
                        state.pttOptimistic = false;
                    }
                    if (!state.pttBusyBuzzPlayed && source !== "emergency-auto") {
                        state.pttBusyBuzzPlayed = true;
                        void startBusyBuzz();
                    }
                    emitWaitingPtt(source, data.remaining_hold_ms != null ? "priority-hold" : "waiting");
                    // Hogere normale prioriteit moet de 3 s hold nauwkeurig
                    // kunnen volmaken. Gewone queue-wachters slapen langer en
                    // worden bij floor_release via floor_available wakker.
                    const retryMs = data.remaining_hold_ms != null
                        ? Math.max(50, Math.min(200, Number(data.remaining_hold_ms) || 200))
                        : 1000;
                    await waitForFloorWake(retryMs);
                }
                if (!data || data.waiting) return false;
                if (!state.pttPressed || requestId !== state.pttRequestId) {
                    await api("ptt/stop/", "POST", {}).catch(() => {});
                    stopAudioTransmission();
                    state.pttOptimistic = false;
                    return false;
                }

                stopBusyBuzz();
                state.pttGranted = true;
                state.pttOptimistic = false;
                state.pttBlocked = false;
                state.floorToken = data.floor_token || "";
                state.pttDeniedTonePlayed = false;

                if (source === "emergency-auto" && !data.emergency) {
                    await api("ptt/stop/", "POST", {}).catch(() => {});
                    clearGrantedPttState();
                    return false;
                }

                if (!proactive && source !== "emergency-auto") await playTransmitGrantedTone();
                if (!state.pttPressed || requestId !== state.pttRequestId) {
                    await api("ptt/stop/", "POST", {}).catch(() => {});
                    clearGrantedPttState();
                    return false;
                }

                startPttHeartbeat();
                if (source === "emergency-auto" && data.emergency) {
                    await startEmergencyAudioTransmission(data.max_tx_duration_ms);
                } else if (!proactive) {
                    await startAudioTransmission();
                    emit("ptt", {
                        state: "active",
                        source,
                        optimistic: false,
                        max_tx_duration_ms: data.max_tx_duration_ms,
                    });
                } else {
                    // Bij een vrij kanaal liep optimistic audio al. Als we eerst
                    // BUSY/waiting waren, is die audio gemute en starten we hem
                    // nu pas opnieuw zodra de server de queue/overname toekent.
                    if (waitedForFloor) {
                        await startAudioTransmission();
                        await playTransmitGrantedTone();
                    }
                    emit("ptt", {
                        state: "active",
                        source,
                        optimistic: false,
                        max_tx_duration_ms: data.max_tx_duration_ms,
                    });
                }
                return true;
            } catch (error) {
                if (!state.pttPressed || requestId !== state.pttRequestId) {
                    stopAudioTransmission();
                    state.pttOptimistic = false;
                    return false;
                }
                // Proactieve TX wordt bij iedere serverweigering/netwerkfout
                // onmiddellijk ingetrokken. De server blijft autoritatief.
                clearGrantedPttState();
                await notifyTransmitDenied(source, "denied", error.message || "Zendtoestemming geweigerd");
                return false;
            }
        })();

        try { return await state.pttAcquirePromise; }
        finally { state.pttAcquirePromise = null; }
    }

    async function pttPress(source = "ui") {
        if (state.pttPressed) return state.pttGranted;
        if (source !== "emergency-auto" && state.priority99Blocked && !state.emergencyAccepted) {
            const message = `Geblokkeerd door noodoproep: [${channel().name}]`;
            emit("ptt", { state: "blocked", source, reason: "priority_99", message });
            await notifyTransmitDenied(source, "denied", message);
            return false;
        }

        // Registreer de fysieke press vóór aanwezigheid, spraakmelding en
        // microfooninitialisatie. Pointer-up kan de aanvraag dan ook tijdens
        // een van deze asynchrone stappen veilig annuleren.
        state.pttRequestId += 1;
        const requestId = state.pttRequestId;
        state.pttPressed = true;
        state.pttGranted = false;
        state.pttOptimistic = false;
        state.pttBlocked = false;
        state.floorToken = "";
        state.pttDeniedTonePlayed = false;
        state.pttBusyBuzzPlayed = false;
        stopBusyBuzz();
        emit("ptt", {
            state: "requesting",
            source,
            reason: "requesting",
            message: waitingMessage("requesting", source),
        });

        // Locatie mag de PTT-latency niet verhogen. Stuur de laatst bekende
        // positie mee met de floor-aanvraag en vraag parallel een verse GPS-fix
        // op. Die verse fix wordt als apart location-event gelogd.
        if (locationEnabled && source !== "emergency-auto") {
            void requestAndSendLocation({ forceFresh: true, source: "ptt" });
        }

        if (source !== "emergency-auto" && ENABLE_PTT_PRESENCE_CHECK) {
            const presenceResult = await checkChannelPresenceForPtt(source, requestId);
            if (!presenceResult.ok) return false;
        }
        try {
            await ensureAudioContext();
            if (!state.pttPressed || requestId !== state.pttRequestId) return false;
            if (source === "emergency-auto") {
                await ensureMicrophoneReady();
                if (!state.pttPressed || requestId !== state.pttRequestId) return false;
            }
        }
        catch (error) {
            if (!state.pttPressed || requestId !== state.pttRequestId) return false;
            state.pttPressed = false;
            state.pttRequestId += 1;
            state.pttBlocked = true;
            emit("ptt", {
                state: "blocked",
                error: error.message,
                source,
                reason: "microphone_error",
                message: error.message || "Microfoon niet beschikbaar",
            });
            feedback(error.message, "error");
            return false;
        }
        return acquirePttWhilePressed(source);
    }

    async function pttRelease(source = "ui") {
        if (!state.pttPressed && !state.pttGranted && !state.floorToken) return true;
        const wasPressed = state.pttPressed;
        state.pttPressed = false;
        state.pttRequestId += 1;
        state.floorWakeResolver?.();
        stopPttHeartbeat();
        stopAudioTransmission();
        stopBusyBuzz();
        const shouldStopServer = wasPressed || state.pttGranted || Boolean(state.floorToken);
        state.pttGranted = false;
        state.pttOptimistic = false;
        state.pttBlocked = false;
        state.floorToken = "";
        state.pttDeniedTonePlayed = false;
        state.pttBusyBuzzPlayed = false;
        if (state.emergencyAutoTimer) window.clearTimeout(state.emergencyAutoTimer);
        state.emergencyAutoTimer = null;
        state.emergencyAutoRunning = false;
        if (state.emergencyCaptureActive) finishEmergencyCapture();
        if (shouldStopServer) await api("ptt/stop/", "POST", {}).catch((error) => feedback(error.message, "error"));
        state.emergencyCaptureFrames = [];
        state.emergencyCaptureSamples = 0;
        emit("ptt", { state: "idle", source });
        return true;
    }

    function synchronizeEmergencyTransmission(status, autoSent = false) {
        const active = Number(status?.call_request_priority) === 1;
        if (active && !state.emergencyStatusActive) {
            state.emergencyStatusActive = true;
            if (autoSent) {
                state.emergencyPhase = "standby";
                emit("sos", { state: "standby", message: "cancel? druk kort op noodknop" });
                return;
            }
            state.emergencyPhase = "starting";
            emit("sos", { state: "starting", message: "Verzend noodoproep" });
            if (!state.emergencyAutoRunning) {
                state.emergencyAutoRunning = true;
                void (async () => {
                    await playLocalMorseK();
                    if (state.emergencyStatusActive && state.emergencyPhase === "starting") {
                        await pttPress("emergency-auto");
                    }
                })();
            }
        } else if (!active && state.emergencyStatusActive) {
            state.emergencyStatusActive = false;
            state.emergencyPhase = "idle";
            if (state.emergencyAutoRunning) void pttRelease("emergency-status-cleared");
        }
    }

    function canUseAction(action) {
        if (state.connectionLost) {
            // Volume blijft lokaal bruikbaar; alle radio-/kanaal-/PTT-acties
            // zijn geblokkeerd totdat de control+media verbinding terug is.
            return action === "volume_up" || action === "volume_down";
        }

        if (!state.emergencyStatusActive) return true;
        if (state.emergencyPhase === "starting") return false;
        return action === "ptt" || action === "emergency_cancel";
    }

    async function cancelOwnEmergency() {
        if (!state.emergencyStatusActive || state.emergencyPhase === "starting") return false;
        if (state.pttPressed || state.pttGranted) await pttRelease("emergency-cancel");
        const data = await api("emergency/cancel/", "POST", {});
        await playLocalMorseR();
        state.statusIndex = state.statuses.findIndex((item) => item.slug === data.status_slug);
        state.currentStatus = {
            slug: data.status_slug,
            label_short: data.status_label_short || "",
            label_long: data.status_label_long || data.status_label_short || "",
            call_request_priority: data.call_request_priority,
        };
        state.emergencyStatusActive = false;
        state.emergencyPhase = "idle";
        emit("status", state.currentStatus);
        emit("sos", { state: "cancelled", message: "" });
        feedback("Noodoproep beëindigd door radio");
        return true;
    }

    async function connectAfterChannelChange(expectedSlug = "") {
        // De select/move POST en bootstrap kunnen op verschillende workers/transactions
        // landen. Accepteer daarom NOOIT een bootstrap voor het oude kanaal en forceer
        // lokaal ook geen nieuw channelIndex met oude credentials. Wacht kort totdat de
        // server het gewenste kanaal autoritatief teruggeeft.
        let data = null;
        let lastReportedSlug = "";
        const attempts = 12;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            data = await api("bootstrap/", "GET", undefined, { cache: "no-store" });
            lastReportedSlug = String(data?.current_channel_slug || "");

            if (!expectedSlug || lastReportedSlug === expectedSlug) break;
            if (attempt < attempts - 1) {
                await new Promise(resolve => window.setTimeout(resolve, 125));
            }
        }

        if (!data) throw new Error("Geen bootstrap ontvangen na kanaalwissel.");
        if (expectedSlug && lastReportedSlug !== expectedSlug) {
            throw new Error(`Server bevestigde kanaal '${expectedSlug}' niet (actueel: '${lastReportedSlug || "—"}').`);
        }

        applyBootstrapConnectionData(data);

        if (!channel().slug || !state.wsSessionId || !state.wsAccessToken) {
            throw new Error("Kanaalwissel leverde geen bruikbare radioverbinding op.");
        }

        // Pas nu is de nieuwe serverstate compleet. De oude socket/media mag gecontroleerd
        // worden afgebroken en vervangen door de nieuwe verbinding.
        if (state.wsReconnectTimer) window.clearTimeout(state.wsReconnectTimer);
        state.wsReconnectTimer = null;
        stopReconnectCountdown();
        state.reconnectAttempt = 0;
        state.connectionLost = false;
        connectControlSocket("channel-switch");
    }

    async function setChannel(slug) {
        return queueChannelSwitch(async () => {
            if (!slug) throw new Error("Geen kanaal opgegeven.");
            const index = state.channels.findIndex((item) => item.slug === slug);
            if (index < 0) throw new Error(`Kanaal '${slug}' is niet beschikbaar.`);
            if (index === state.channelIndex) return true;

            await prepareChannelSwitch("channel-select", slug);
            try {
                await api(`channel/${encodeURIComponent(slug)}/select/`, "POST", {});
                await connectAfterChannelChange(slug);
            } catch (error) {
                finishChannelSwitch();
                // Alleen na een daadwerkelijk mislukte gecontroleerde handover wordt dit
                // een echte reconnect. Een normale socket-close tijdens de wissel wordt
                // nooit als verbindingsverlies aangekondigd.
                markConnectionLost("channel-switch-failed");
                if (state.reconnectAttempt < 1) state.reconnectAttempt = 1;
                scheduleControlReconnect(0);
                throw error;
            }
            emit("channel", { ...channel() });
            void refreshChannelPresence();
            feedback(`Kanaal: ${channel().name}`);
            return true;
        });
    }

    async function moveChannel(step) {
        return queueChannelSwitch(async () => {
            await prepareChannelSwitch("channel-move");
            let data;
            try {
                data = await api("channel/move/", "POST", { step });
                await connectAfterChannelChange(data.channel_slug);
            } catch (error) {
                finishChannelSwitch();
                markConnectionLost("channel-move-failed");
                if (state.reconnectAttempt < 1) state.reconnectAttempt = 1;
                scheduleControlReconnect(0);
                throw error;
            }
            emit("channel", { ...channel() });
            void refreshChannelPresence();
            feedback(`Kanaal: ${data.channel_name || channel().name}`);
            return true;
        });
    }

    async function synchronizeChannel(data, source = "explicit") {
        // Heartbeats zijn read-only voor de actieve kanaalverbinding.
        // Bewaar deze guard ook als bescherming tegen toekomstige call-sites.
        if (source === "heartbeat") return;

        const nextChannels = Array.isArray(data.channels) ? data.channels : state.channels;
        const previousChannel = channel();

        // De 5s heartbeat is informatief en mag nooit een bestaande kanaalverbinding
        // afbreken wanneer current_channel_slug tijdelijk ontbreekt/leeg is. Alleen een
        // expliciet, geldig ander kanaal is autoritatief genoeg voor een handover.
        const rawChannelSlug = typeof data?.current_channel_slug === "string"
            ? data.current_channel_slug.trim()
            : "";
        const hasExplicitChannel = rawChannelSlug.length > 0;
        const nextSlug = hasExplicitChannel ? rawChannelSlug : (previousChannel.slug || "");
        const channelsChanged = JSON.stringify(state.channels) !== JSON.stringify(nextChannels);
        const channelChanged = hasExplicitChannel && previousChannel.slug !== nextSlug;

        if (!channelsChanged && !channelChanged) return;

        if (channelChanged) {
            await prepareChannelSwitch("channel-sync");
        }

        state.channels = nextChannels;
        state.channelIndex = state.channels.findIndex((item) => item.slug === nextSlug);
        if (state.channelIndex < 0 && state.channels.length && !nextSlug) state.channelIndex = 0;

        if (channelChanged) {
            connectControlSocket("channel-switch");
        }

        const current = channel();
        emit("channel", { ...current, external: true });
        void refreshChannelPresence();
        if (channelChanged) feedback(current.slug ? `Kanaal: ${current.name}` : "Geen kanaal ingesteld");
    }

    async function setStatus(slug) {
        if (!slug) throw new Error("Geen status opgegeven.");
        const index = state.statuses.findIndex((item) => item.slug === slug);
        if (index < 0) throw new Error(`Status '${slug}' is niet beschikbaar.`);
        const data = await api("status/select/", "POST", { status: slug });
        state.statusIndex = index;
        const selectedStatus = state.statuses[index];
        const labelShort = data.status_label_short || selectedStatus.label_short;
        const labelLong = data.status_label_long || selectedStatus.label_long || labelShort;
        selectedStatus.call_request_priority = data.call_request_priority;
        state.currentStatus = {
            slug: data.status_slug,
            label_short: labelShort,
            label_long: labelLong,
            call_request_priority: data.call_request_priority,
        };
        emit("status", state.currentStatus);
        synchronizeEmergencyTransmission(state.currentStatus);
        feedback(`Status: ${labelLong}`);
        return true;
    }

    function numericInput(params = {}) {
        const result = window.RadioInput?.numeric(params) || { value: String(params.value ?? "") };
        state.numericValue = result.value;
        feedback(result.value || result.key || "");
        return true;
    }

    function t9Input(params = {}) {
        const result = window.RadioInput?.t9(params) || { value: String(params.value ?? "") };
        state.t9Value = result.value;
        feedback(result.value);
        return true;
    }


    function isHoldAction(action) {
        return action === "ptt";
    }

    async function press(action, params = {}, source = "ui", meta = {}) {
        if (!canUseAction(action)) return false;
        if (action === "ptt") return await pttPress(source);
        return false;
    }

    async function release(action, params = {}, source = "ui") {
        // Loslaten moet een eerder gestarte PTT altijd kunnen beëindigen. De
        // radiostatus kan tijdens het indrukken wijzigen (bijvoorbeeld door een
        // noodoproep); die nieuwe status mag de release nooit blokkeren.
        if (action === "ptt") return await pttRelease(source);
        if (!canUseAction(action)) return false;
        return false;
    }

    async function trigger(action, params = {}, source = "ui") {
        try {
            if (!canUseAction(action)) return false;
            switch (action) {
                case "":
                case "none": return false;
                case "screen_open": return Boolean(state.handlers.screenOpen?.(params.screen));
                case "screen_back": return Boolean(state.handlers.screenBack?.());
                case "selection_up": return Boolean(state.handlers.selectionUp?.());
                case "selection_down": return Boolean(state.handlers.selectionDown?.());
                case "selection_left": return Boolean(state.handlers.selectionLeft?.());
                case "selection_right": return Boolean(state.handlers.selectionRight?.());
                case "selection_select": return Boolean(state.handlers.selectionSelect?.());
                case "channel_up": return await moveChannel(1);
                case "channel_down": return await moveChannel(-1);
                case "channel_select": return await setChannel(params.channel || params.channel_slug || params.slug);
                case "status_select": return await setStatus(params.status || params.status_slug || params.slug);
                case "volume_up": {
                    const configured = Number(params.step);
                    const step = (!Number.isFinite(configured) || configured <= 0 || configured === 10) ? 5 : configured;
                    setVolume(state.volume + step);
                    return true;
                }
                case "volume_down": {
                    const configured = Number(params.step);
                    const step = (!Number.isFinite(configured) || configured <= 0 || configured === 10) ? 5 : configured;
                    setVolume(state.volume - step);
                    return true;
                }
                case "input_numeric": return numericInput(params);
                case "input_t9": return t9Input(params);
                case "sos": {
                    if (state.emergencyStatusActive) return false;
                    const emergencyStatus = state.statuses.find((item) => Number(item.call_request_priority) === 1);
                    if (!emergencyStatus) throw new Error("Geen noodstatus geconfigureerd.");
                    return await setStatus(emergencyStatus.slug);
                }
                case "emergency_cancel": return await cancelOwnEmergency();
                case "private_call_accept": return Boolean(window.RadioPrivateCall?.accept?.());
                case "private_call_decline": return Boolean(window.RadioPrivateCall?.decline?.());
                case "private_call_hangup": return Boolean(window.RadioPrivateCall?.hangup?.());
                case "ptt": return await pttPress(source);
                default:
                    feedback(`Onbekende actie: ${action}`, "error");
                    return false;
            }
        } catch (error) {
            feedback(error.message || String(error), "error");
            return false;
        }
    }



    function parseBridgeDetail(detail) {
        if (typeof detail !== "string") return detail && typeof detail === "object" ? detail : {};
        try { return JSON.parse(detail); } catch (_) { return {}; }
    }

    async function playDiagnosticTone() {
        try {
            const context = await ensureAudioContext();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = "sine";
            oscillator.frequency.value = 1000;
            gain.gain.value = 0.08;
            oscillator.connect(gain);
            gain.connect(state.outputGain || context.destination);
            oscillator.start();
            oscillator.stop(context.currentTime + 5);
            feedback("Diagnostische 1 kHz toon: 5 seconden");
            oscillator.onended = () => {
                try { oscillator.disconnect(); } catch (_) {}
                try { gain.disconnect(); } catch (_) {}
            };
        } catch (error) {
            feedback(`Testtoon mislukt: ${error.message}`, "error");
        }
    }

    function metricLast(metric) {
        if (metric == null) return "-";
        if (typeof metric === "number") return String(Math.round(metric * 100) / 100);
        if (typeof metric === "object" && metric.last != null) return String(metric.last);
        return "-";
    }

    function updateAudioDebugOverlay() {
        const overlay = document.getElementById("audio-debug-overlay");
        if (!overlay) return;
        const rtc = state.livekit?.diagnosticsSnapshot?.() || {};
        const android = state.androidAudioDiagnostics || {};
        overlay.querySelector("[data-audio-debug-text]").textContent = [
            `Android ${android.android_release ?? "-"} / SDK ${android.android_sdk ?? "-"} · ${android.manufacturer ?? "-"} ${android.model ?? ""}`,
            `output ${android.output_sample_rate ?? "-"} Hz · buffer ${android.frames_per_buffer ?? "-"} frames · mode ${android.audio_mode ?? "-"}`,
            `RX ${metricLast(rtc.rx_bitrate_kbps)} kbps · loss ${metricLast(rtc.rx_loss_percent)}% · jitter ${metricLast(rtc.jitter_ms)} ms · RTT ${metricLast(rtc.rtt_ms)} ms`,
            `concealed ${rtc.concealed_samples ?? "-"} · events ${rtc.concealment_events ?? "-"} · samples ${rtc.total_samples_received ?? "-"}`,
            `tracks ${rtc.remote_audio_tracks ?? 0} · audio elements ${rtc.audio_elements ?? 0}`,
        ].join("\n");
    }

    function installAudioDiagnostics() {
        document.addEventListener("ui_radio:android-audio-diagnostics", event => {
            state.androidAudioDiagnostics = parseBridgeDetail(event.detail);
            updateAudioDebugOverlay();
        });

        if (new URLSearchParams(window.location.search).get("debug") !== "1") return;
        const overlay = document.createElement("section");
        overlay.id = "audio-debug-overlay";
        overlay.className = "audio-debug-overlay";
        overlay.innerHTML = `<pre data-audio-debug-text>Audio diagnostics laden…</pre><button type="button" data-audio-test-tone>1 kHz testtoon</button>`;
        document.body.appendChild(overlay);
        overlay.querySelector("[data-audio-test-tone]").addEventListener("click", () => { void playDiagnosticTone(); });
        window.setInterval(updateAudioDebugOverlay, 1000);
        updateAudioDebugOverlay();
    }

    let locationTimer = null;
    let locationRequestPending = false;
    let locationEnabled = false;
    let locationIntervalMs = 15000;
    let lastLocationPayload = null;
    let locationRequestPromise = null;

    function configureLocation(config) {
        const nextEnabled = config?.enabled === true;
        const nextInterval = nextEnabled ? Math.max(5000, Number(config?.interval_ms || 15000)) : 0;
        const intervalChanged = locationIntervalMs !== nextInterval;
        locationEnabled = nextEnabled;
        locationIntervalMs = nextInterval;
        if (!nextEnabled) {
            if (locationTimer) window.clearInterval(locationTimer);
            locationTimer = null;
            return;
        }
        if (locationTimer && intervalChanged) {
            window.clearInterval(locationTimer);
            locationTimer = null;
        }
        if (!locationTimer) {
            void requestAndSendLocation();
            locationTimer = window.setInterval(() => { void requestAndSendLocation(); }, locationIntervalMs);
        }
    }

    async function requestAndSendLocation({ forceFresh = false, source = "interval" } = {}) {
        if (!locationEnabled || !navigator.geolocation) return null;
        if (locationRequestPromise) return locationRequestPromise;
        locationRequestPending = true;
        locationRequestPromise = (async () => {
            try {
                const position = await new Promise((resolve, reject) => {
                    navigator.geolocation.getCurrentPosition(resolve, reject, {
                        enableHighAccuracy: true,
                        timeout: 10000,
                        maximumAge: forceFresh ? 0 : 5000,
                    });
                });
                const coords = position.coords || {};
                if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude) || !Number.isFinite(coords.accuracy)) return null;
                const payload = {
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    accuracy_m: coords.accuracy,
                    timestamp_ms: Number(position.timestamp || Date.now()),
                };
                lastLocationPayload = payload;
                await api("location/", "POST", { ...payload, source });
                return payload;
            } catch (_) {
                // Geen locatiepermission/fix is geen radioverbindingsfout; volgende interval/PTT probeert opnieuw.
                return null;
            } finally {
                locationRequestPending = false;
                locationRequestPromise = null;
            }
        })();
        return locationRequestPromise;
    }

    async function initialize(handlers = {}) {
        // Hardware-input moet vanaf het eerste render-moment gekoppeld zijn.
        // De bind is idempotent en buffert Android-key events totdat de
        // action-engine/bootstrap volledig gereed is.
        window.RadioHardware?.bind({
            trigger,
            press,
            release,
            isHoldAction,
            canUseAction,
        });
        installAudioDiagnostics();
        state.handlers = { ...handlers };
        if (state.initialized) return state;
        state.initialized = true;
        try {
            const data = await api("bootstrap/");
            state.identity = {
                display_name: data.identity?.display_name || window.RADIO_USER?.name || "Radio",
                user_slug: data.identity?.user_slug || "",
            };
            state.channels = Array.isArray(data.channels) ? data.channels : [];
            state.channelIndex = state.channels.findIndex((item) => item.slug === data.current_channel_slug);
            if (state.channelIndex < 0 && state.channels.length) state.channelIndex = 0;
            state.statuses = Array.isArray(data.statuses) ? data.statuses : [];
            state.statusIndex = state.statuses.findIndex((item) => item.slug === data.current_status_slug);
            state.currentStatus = state.statusIndex >= 0 ? { ...state.statuses[state.statusIndex] } : null;
            state.defaultTxPriority = Number(data.default_tx_priority || 0);
            state.txPermissionMode = data.tx_permission_mode === "proactive" ? "proactive" : "conservative";
            configureLocation(data.location || {});
            state.channelEmergency = data.channel_emergency === true;
            state.emergencyUsers = Array.isArray(data.emergency_users) ? data.emergency_users : [];
            synchronizeEmergencyTransmission(state.currentStatus, data.emergency_auto_sent === true);
            state.priority = data.priority || null;
            applyBootstrapConnectionData(data);
            connectControlSocket("startup");
            setVolume(state.volume);
            emit("ready", {
                identity: state.identity,
                channels: state.channels,
                channel: channel(),
                volume: state.volume,
                priority: state.priority,
                status: state.currentStatus,
                channelEmergency: state.channelEmergency,
                emergencyUsers: state.emergencyUsers,
                presence: state.channelPresence,
            });
            void refreshChannelPresence();
        } catch (error) {
            feedback(`Backend niet beschikbaar: ${error.message}`, "error");
            setConnectionLost(true);
            scheduleControlReconnect();
        }
        // RadioHardware is al vóór bootstrap gekoppeld; bind() is bewust
        // idempotent en pending events zijn inmiddels geflusht.
        window.RadioHardware?.bind({ trigger, press, release, isHoldAction, canUseAction });
        document.addEventListener("pointerdown", () => { void ensureAudioContext(); }, { once: true, capture: true });
        document.querySelector("#connection-reconnect")?.addEventListener("click", reconnectControl);
        document.addEventListener("ui_radio:key_tone",keyTone);
        window.addEventListener("offline", () => {
            markConnectionLost("browser-offline");
            if (state.wsReconnectTimer) window.clearTimeout(state.wsReconnectTimer);
            state.wsReconnectTimer = null;
            stopReconnectCountdown();
            scheduleControlReconnect();
        });
        window.addEventListener("online", () => {
            if (!state.connectionLost) return;
            if (state.wsReconnectTimer) window.clearTimeout(state.wsReconnectTimer);
            state.wsReconnectTimer = null;
            stopReconnectCountdown();
            scheduleControlReconnect(0);
        });
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                void pttRelease("visibility");
                return;
            }
            // Android/Gecko kan timers in de achtergrond vertragen. Zodra de
            // radio weer zichtbaar wordt, direct opnieuw proberen met verse data.
            if (state.connectionLost) {
                if (state.wsReconnectTimer) window.clearTimeout(state.wsReconnectTimer);
                state.wsReconnectTimer = null;
                stopReconnectCountdown();
                scheduleControlReconnect(0);
            }
        });
        window.addEventListener("focus", () => {
            if (!state.connectionLost) return;
            if (state.wsReconnectTimer) window.clearTimeout(state.wsReconnectTimer);
            state.wsReconnectTimer = null;
            stopReconnectCountdown();
            scheduleControlReconnect(0);
        });
        // Een gewone window.blur is geen knop-release. Op sommige dedicated
        // Android-radio's veroorzaakt een fysieke hardwarekey kort een Gecko
        // focuswisseling. PTT mag daardoor niet worden geannuleerd. De echte
        // release komt via pointerup/pointercancel of Android key UP.
        window.addEventListener("pagehide", () => { if (state.pttPressed || state.pttGranted) void pttRelease("pagehide"); });
        window.setInterval(() => {
            void refreshChannelPresence();
            api("heartbeat/", "POST", heartbeatPayload()).then(async (data) => {
                // De 5-seconden-heartbeat is uitsluitend liveness/status/telemetrie.
                // Hij mag NOOIT een channel handover, control-WebSocket rebuild of
                // LiveKit reconnect starten. Kanaalwissels lopen alleen via de
                // expliciete channel select/move-flow of een config push.
                //
                // Dit voorkomt een reconnect-loop wanneer server- en clientstate
                // tijdens een heartbeat kortstondig niet exact gelijk zijn.
                state.defaultTxPriority = Number(data.default_tx_priority || state.defaultTxPriority || 0);
                configureLocation(data.location || {});
                const nextChannelEmergency = data.channel_emergency === true;
                const nextEmergencyUsers = Array.isArray(data.emergency_users) ? data.emergency_users : [];
                if (state.channelEmergency !== nextChannelEmergency
                    || JSON.stringify(state.emergencyUsers) !== JSON.stringify(nextEmergencyUsers)) {
                    state.channelEmergency = nextChannelEmergency;
                    state.emergencyUsers = nextEmergencyUsers;
                    emit("channel-emergency", { active: nextChannelEmergency, users: nextEmergencyUsers });
                }
                const nextStatus = data.current_status_slug ? {
                    slug: data.current_status_slug,
                    label_short: data.status_label_short || "",
                    label_long: data.status_label_long || data.status_label_short || "",
                    call_request_priority: data.call_request_priority,
                } : null;
                const previous = JSON.stringify(state.currentStatus);
                const next = JSON.stringify(nextStatus);
                if (previous !== next) {
                    state.currentStatus = nextStatus;
                    state.statusIndex = state.statuses.findIndex((item) => item.slug === nextStatus?.slug);
                    emit("status", nextStatus || {});
                    synchronizeEmergencyTransmission(nextStatus, data.emergency_auto_sent === true);
                }
            }).catch(() => {});
        }, STATUS_HEARTBEAT_MS);
        return state;
    }

    window.RadioActions = {
        initialize,
        trigger,
        press,
        release,
        isHoldAction,
        pttPress,
        pttRelease,
        getState: () => state,
        setVolume,
        reconnectControl,
        canUseAction,
        refreshChannelPresence,
    };
})();
