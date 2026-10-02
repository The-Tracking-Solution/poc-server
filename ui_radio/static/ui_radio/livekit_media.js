(() => {
  "use strict";

  class MetricBucket {
    constructor() { this.reset(); }
    reset() { this.count = 0; this.sum = 0; this.min = null; this.max = null; this.last = null; }
    add(value) {
      value = Number(value);
      if (!Number.isFinite(value)) return;
      this.count += 1; this.sum += value; this.last = value;
      this.min = this.min === null ? value : Math.min(this.min, value);
      this.max = this.max === null ? value : Math.max(this.max, value);
    }
    peek(round = 2) {
      if (!this.count) return null;
      const r = value => Number(value.toFixed(round));
      return { last: r(this.last), min: r(this.min), max: r(this.max), avg: r(this.sum / this.count) };
    }
    take(round = 2) {
      const data = this.peek(round);
      this.reset();
      return data;
    }
  }

  class PocLiveKitMedia {
    constructor(options) {
      this.options = options;
      this.room = null;
      this.echoRoom = null;
      this.localTrack = null;
      this.publication = null;
      this.remoteTracks = new Set();
      /*
       * Exact één playback-element per LiveKit RemoteAudioTrack.
       * Hiermee voorkomen we dat reconnect/subscription-events meerdere
       * <audio>-elementen voor dezelfde track achterlaten.
       */
      this.remoteElements = new Map();

      /*
       * Groepskanalen hebben logisch maar één actieve audiostream:
       * alleen de huidige PTT-zender wordt gesubscribed/afgespeeld.
       */
      this.activeRemotePublication = null;
      this.activeRemoteParticipant = null;

      /*
       * WebRTC audio counters zijn cumulatief. Voor diagnose bewaren we de
       * vorige waarde zodat takeTelemetry() ook de delta sinds de vorige
       * heartbeat kan rapporteren.
       */
      this.previousRxDiagnostics = {
        concealedSamples: null,
        concealmentEvents: null,
        totalSamplesReceived: null,
        insertedSamplesForDeceleration: null,
        removedSamplesForAcceleration: null,
      };

      this.statsTimer = null;
      this.channelSlug = "";
      this.mediaChannelSlug = "";
      this.ignoreIdentityPrefix = "";
      this.linkedRoomSecondary = false;
      this.connectionState = "disconnected";
      this.metrics = {
        rtt: new MetricBucket(), jitter: new MetricBucket(),
        rxLoss: new MetricBucket(), txLoss: new MetricBucket(),
        rxBitrate: new MetricBucket(), txBitrate: new MetricBucket(),
      };
      this.previous = new Map();
      this.samples = 0;
      this.receiveEnabled = options.receiveEnabled !== false;
      this.nativeMode = false;
      this.nativeStatus = {
        provider: "livekit-js",
        connection_state: "disconnected",
        remote_audio_tracks: 0,
        audio_elements: 0,
        active_remote_participant: null,
        transmitting: false,
        receive_enabled: true,
        last_reason: null,
        last_event_at_ms: null,

        // De huidige native bridge rapporteert deze velden mogelijk nog niet.
        // Zodra de Android media-engine ze meestuurt, gaan ze zonder verdere
        // serverwijziging mee in heartbeat + diagnostics.
        rtt_ms: null,
        jitter_ms: null,
        rx_loss_percent: null,
        rx_bitrate_kbps: null,
        tx_loss_percent: null,
        tx_bitrate_kbps: null,
        concealed_samples: null,
        concealed_samples_delta: null,
        concealment_events: null,
        concealment_events_delta: null,
        total_samples_received: null,
        total_samples_received_delta: null,
        inserted_samples_for_deceleration: null,
        inserted_samples_delta: null,
        removed_samples_for_acceleration: null,
        removed_samples_delta: null,
        jitter_buffer_delay: null,
        jitter_buffer_emitted_count: null,
      };
      this.nativePending = new Map();
      this.nativeSequence = 0;
      this.nativeListener = event => this._handleNativeMediaEvent(event);
      document.addEventListener("ui_radio:native-media-event", this.nativeListener);

      this.echoRecorder = null;
      this.echoChunks = [];
      this.echoPlayback = null;

      this.rxDiagnostics = {
        concealedSamples: null, concealmentEvents: null, totalSamplesReceived: null,
        insertedSamplesForDeceleration: null, removedSamplesForAcceleration: null,
        jitterBufferDelay: null, jitterBufferEmittedCount: null, audioLevel: null,
      };
    }

    _nativeAvailable() {
      return document.documentElement.dataset.ttsNativeMedia === "1";
    }

    _parseBridgeDetail(detail) {
      if (detail && typeof detail === "object") return detail;
      if (typeof detail !== "string") return {};
      try { return JSON.parse(detail); } catch (_) { return {}; }
    }

    _handleNativeMediaEvent(event) {
      const detail = this._parseBridgeDetail(event.detail);
      if (!detail || detail.type !== "native-media-event") return;

      if (detail.provider) this.nativeStatus.provider = detail.provider;

      const nativeFields = [
        "connection_state",
        "remote_audio_tracks",
        "audio_elements",
        "active_remote_participant",
        "transmitting",
        "receive_enabled",
        "rtt_ms",
        "jitter_ms",
        "rx_loss_percent",
        "rx_bitrate_kbps",
        "tx_loss_percent",
        "tx_bitrate_kbps",
        "concealed_samples",
        "concealed_samples_delta",
        "concealment_events",
        "concealment_events_delta",
        "total_samples_received",
        "total_samples_received_delta",
        "inserted_samples_for_deceleration",
        "inserted_samples_delta",
        "removed_samples_for_acceleration",
        "removed_samples_delta",
        "jitter_buffer_delay",
        "jitter_buffer_emitted_count",
      ];

      for (const key of nativeFields) {
        if (detail[key] !== undefined) this.nativeStatus[key] = detail[key];
      }

      if (detail.reason !== undefined) this.nativeStatus.last_reason = detail.reason;
      this.nativeStatus.last_event_at_ms = Date.now();

      const requestId = detail.request_id;
      if (requestId && this.nativePending.has(requestId)) {
        const pending = this.nativePending.get(requestId);
        this.nativePending.delete(requestId);
        window.clearTimeout(pending.timer);
        if (detail.ok === false) pending.reject(new Error(detail.error || "Native media command mislukt."));
        else pending.resolve(detail);
      }

      if (detail.event === "status") {
        this.connectionState = String(detail.connection_state || this.connectionState || "unknown");
        this.options.onState?.(this.connectionState);
      }
    }

    _nativeRequest(command, payload = {}, timeoutMs = 8000) {
      const requestId = `native-${Date.now()}-${++this.nativeSequence}`;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.nativePending.delete(requestId);
          reject(new Error(`Native media timeout: ${command}`));
        }, timeoutMs);

        this.nativePending.set(requestId, { resolve, reject, timer });
        document.dispatchEvent(new CustomEvent("ui_radio:native-media-command", {
          detail: JSON.stringify({
            request_id: requestId,
            command,
            ...payload,
          }),
        }));
      });
    }

    async token(channelSlug) {
      const headers = { "Content-Type": "application/json" };
      if (this.options.accessToken) headers.Authorization = `Bearer ${this.options.accessToken}`;
      if (this.options.sessionId) headers["X-POC-Session-ID"] = String(this.options.sessionId);
      const csrf = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
      if (csrf) headers["X-CSRFToken"] = decodeURIComponent(csrf);
      const response = await fetch(this.options.tokenUrl, {
        method: "POST", credentials: "same-origin", headers,
        body: JSON.stringify({ channel_slug: channelSlug }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `WebRTC token HTTP ${response.status}`);
      return payload;
    }

    _publicationIsAudio(publication) {
      const LK = window.LivekitClient;
      return Boolean(
        publication
        && LK
        && publication.kind === LK.Track.Kind.Audio
      );
    }

    _publicationMuted(publication) {
      return Boolean(publication?.isMuted ?? publication?.track?.isMuted ?? false);
    }

    _ignoreParticipant(participant) {
      const identity = String(participant?.identity || "");
      return Boolean(this.ignoreIdentityPrefix && identity.startsWith(this.ignoreIdentityPrefix));
    }

    _deactivateRemotePublication(publication = null) {
      const active = this.activeRemotePublication;
      if (!active) return;
      if (publication && active !== publication) return;

      const track = active.track;
      if (track) this.detachRemoteAudio(track);

      try { active.setSubscribed(false); } catch (_) {}

      this.activeRemotePublication = null;
      this.activeRemoteParticipant = null;
    }

    _activateRemotePublication(publication, participant, channelSlug) {
      if (!this.receiveEnabled || !this._publicationIsAudio(publication)) return;

      // Er mag per groepskanaal maar één actieve remote PTT-stream bestaan.
      if (this.activeRemotePublication && this.activeRemotePublication !== publication) {
        this._deactivateRemotePublication();
      }

      this.activeRemotePublication = publication;
      this.activeRemoteParticipant = participant || null;

      try { publication.setSubscribed(true); } catch (_) {}

      // Als LiveKit de track al heeft, kunnen we direct attachen.
      if (publication.track) {
        this.attachRemoteAudio(publication.track, channelSlug, "remote");
      }
    }

    attachRemoteAudio(track, channelSlug, kind = "remote") {
      this.remoteTracks.add(track);

      // Een bestaande track nooit een tweede keer aan een nieuw audio-element koppelen.
      if (this.remoteElements.has(track)) {
        return this.remoteElements.get(track);
      }

      const element = track.attach();
      element.autoplay = true;
      element.setAttribute("playsinline", "true");
      element.dataset.pocWebrtcAudio = channelSlug;
      element.dataset.pocWebrtcKind = kind;
      element.style.display = "none";

      this.remoteElements.set(track, element);

      if (typeof this.options.onRemoteElement === "function") {
        this.options.onRemoteElement(element, track);
      } else {
        document.body.appendChild(element);
      }

      if (typeof this.options.onRemoteAudio === "function") {
        this.options.onRemoteAudio(true);
      }

      return element;
    }

    detachRemoteAudio(track) {
      this.remoteTracks.delete(track);

      const knownElement = this.remoteElements.get(track);

      try {
        track.detach().forEach(element => element.remove());
      } catch (_) {}

      if (knownElement) {
        try { knownElement.remove(); } catch (_) {}
      }

      this.remoteElements.delete(track);

      if (!this.remoteTracks.size && typeof this.options.onRemoteAudio === "function") {
        this.options.onRemoteAudio(false);
      }
    }

    async connectEchoReceiver(cfg, channelSlug) {
      const token = cfg?.echo?.participant_token;
      if (!cfg?.echo?.enabled || !token) return;
      const LK = window.LivekitClient;
      const echoRoom = new LK.Room({ adaptiveStream: false, dynacast: false });
      this.echoRoom = echoRoom;
      echoRoom.on(LK.RoomEvent.TrackSubscribed, track => {
        if (track.kind === LK.Track.Kind.Audio) this.attachRemoteAudio(track, channelSlug, "echo");
      });
      echoRoom.on(LK.RoomEvent.TrackUnsubscribed, track => {
        if (track.kind === LK.Track.Kind.Audio) this.detachRemoteAudio(track);
      });
      echoRoom.on(LK.RoomEvent.Disconnected, () => {
        if (this.echoRoom === echoRoom) this.echoRoom = null;
      });
      await echoRoom.connect(cfg.server_url, token, { autoSubscribe: true });
      try { await echoRoom.startAudio(); } catch (_) {}
    }

    async connect(channelSlug) {
      if (
        this.channelSlug === channelSlug
        && this.connectionState === "connected"
        && (this.room || this.nativeMode)
      ) return;

      await this.close();
      const cfg = await this.token(channelSlug);
      this.audioConfig = cfg.audio || {};
      this.channelSlug = channelSlug;
      this.mediaChannelSlug = cfg.media_channel_slug || channelSlug;
      this.ignoreIdentityPrefix = String(cfg.ignore_identity_prefix || this.options.ignoreIdentityPrefix || "");
      this.linkedRoomSecondary = Boolean(this.options.linkedRoomReceivePrimaryOnly && this.mediaChannelSlug !== channelSlug);
      this.channelType = cfg.channel_type || "group";
      this.echoDisplayName = cfg?.echo?.name || "parrot";

      /*
       * Android native media voor normale groepskanalen.
       * Echo blijft bewust web-fallback omdat Echo na TX-end moet replayen.
       */
      if (cfg.channel_type !== "echo" && this._nativeAvailable()) {
        this.nativeMode = true;
        this.connectionState = "connecting";
        this.options.onState?.("connecting");
        await this._nativeRequest("connect", { config: cfg }, 12000);
        this.connectionState = "connected";
        this.nativeStatus.connection_state = "connected";
        this.options.onState?.("connected");

        // Ook native audio iedere seconde pollen. De native "status"-response
        // loopt via dezelfde bridge terug naar nativeStatus.
        this.startStats();
        return;
      }

      if (!window.LivekitClient) throw new Error("LiveKit clientbibliotheek ontbreekt.");
      const LK = window.LivekitClient;
      const room = new LK.Room({ adaptiveStream: false, dynacast: false });
      this.room = room;
      this.channelSlug = channelSlug;
      this.connectionState = "connecting";

      room.on(LK.RoomEvent.TrackPublished, (publication, participant) => {
        if (!this._publicationIsAudio(publication) || this._ignoreParticipant(participant)) return;

        // Groepskanalen starten unsubscribed. Alleen een werkelijk actieve
        // (unmuted) PTT-publicatie wordt aangezet.
        try { publication.setSubscribed(false); } catch (_) {}

        if (this.receiveEnabled && !this._publicationMuted(publication)) {
          this._activateRemotePublication(publication, participant, channelSlug);
        }
      });

      room.on(LK.RoomEvent.TrackUnmuted, (publication, participant) => {
        if (!this._publicationIsAudio(publication) || this._ignoreParticipant(participant)) return;
        this._activateRemotePublication(publication, participant, channelSlug);
      });

      room.on(LK.RoomEvent.TrackMuted, publication => {
        if (!this._publicationIsAudio(publication)) return;
        this._deactivateRemotePublication(publication);
      });

      room.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind !== LK.Track.Kind.Audio || this._ignoreParticipant(participant)) {
          try { publication?.setSubscribed(false); } catch (_) {}
          try { track?.detach?.().forEach(element => element.remove()); } catch (_) {}
          return;
        }

        // Alleen de geselecteerde actieve PTT-publicatie mag playback krijgen.
        if (publication !== this.activeRemotePublication) {
          try { publication?.setSubscribed(false); } catch (_) {}
          try { track.detach().forEach(element => element.remove()); } catch (_) {}
          return;
        }

        this.activeRemoteParticipant = participant || this.activeRemoteParticipant;
        this.attachRemoteAudio(track, channelSlug, "remote");
      });

      room.on(LK.RoomEvent.TrackUnsubscribed, (track, publication) => {
        if (track.kind === LK.Track.Kind.Audio) this.detachRemoteAudio(track);
        if (publication && publication === this.activeRemotePublication) {
          this.activeRemotePublication = null;
          this.activeRemoteParticipant = null;
        }
      });
      room.on(LK.RoomEvent.ConnectionStateChanged, state => {
        this.connectionState = String(state || "unknown").toLowerCase();
        this.options.onState?.(this.connectionState);
      });
      room.on(LK.RoomEvent.Disconnected, () => {
        this.connectionState = "disconnected";
        this.options.onState?.("disconnected");
      });

      await room.connect(cfg.server_url, cfg.participant_token, { autoSubscribe: false });
      try { await room.startAudio(); } catch (_) {}
      this.connectionState = "connected";
      await this.setReceiveEnabled(this.receiveEnabled);

      if (this.options.prepublishMicrophone !== false) await this.ensurePublisher();
      this.startStats();
    }

    async setReceiveEnabled(active) {
      this.receiveEnabled = !!active && !this.linkedRoomSecondary;
      if (!this.room && !this.echoRoom) return;
      const LK = window.LivekitClient;

      // Group room: nooit alles subscriben. Alleen de actieve PTT-zender.
      if (!this.receiveEnabled) {
        this._deactivateRemotePublication();
      } else if (this.room) {
        for (const participant of this.room.remoteParticipants.values()) {
          if (this._ignoreParticipant(participant)) continue;
          for (const publication of participant.trackPublications.values()) {
            if (publication.kind !== LK.Track.Kind.Audio) continue;
            if (!this._publicationMuted(publication)) {
              this._activateRemotePublication(publication, participant, this.channelSlug);
              break;
            }
          }
          if (this.activeRemotePublication) break;
        }
      }

      // Echo-room is bewust een aparte, eigen loopbackstream.
      if (this.echoRoom) {
        for (const participant of this.echoRoom.remoteParticipants.values()) {
          for (const publication of participant.trackPublications.values()) {
            if (publication.kind !== LK.Track.Kind.Audio) continue;
            try { publication.setSubscribed(this.receiveEnabled); } catch (_) {}
          }
        }
      }
    }

    _startDelayedEchoCapture() {
      if (this.channelType !== "echo") return;

      if (typeof MediaRecorder === "undefined") {
        console.error("[echo] MediaRecorder wordt niet ondersteund door deze browser.");
        this.options.onState?.("echo-recorder-unavailable");
        return;
      }

      const mediaTrack = this.localTrack?.mediaStreamTrack;
      if (!mediaTrack) {
        console.error("[echo] Lokale audiotrack ontbreekt.");
        this.options.onState?.("echo-track-unavailable");
        return;
      }

      try {
        this._stopDelayedEchoCapture();

        try {
          this.echoPlayback?.pause?.();
          if (this.echoPlayback?.src) URL.revokeObjectURL(this.echoPlayback.src);
        } catch (_) {}
        this.echoPlayback = null;

        this.echoChunks = [];

        const stream = new MediaStream();
        stream.addTrack(mediaTrack);

        let recorder;
        const preferredTypes = [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/ogg;codecs=opus",
          "audio/ogg",
        ];
        const mimeType = preferredTypes.find(type =>
          typeof MediaRecorder.isTypeSupported !== "function"
          || MediaRecorder.isTypeSupported(type)
        );

        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        recorder.ondataavailable = event => {
          if (event.data && event.data.size) this.echoChunks.push(event.data);
        };

        recorder.onerror = event => {
          console.error("[echo] MediaRecorder fout.", event?.error || event);
        };

        recorder.onstop = () => {
          const chunks = this.echoChunks.splice(0);
          if (!chunks.length) {
            console.warn("[echo] Geen audioblokken opgenomen.");
            this.options.onState?.("echo-empty");
            return;
          }
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          const url = URL.createObjectURL(blob);

          window.setTimeout(() => {
            void this._broadcastParrotReplay(url);
          }, 150);
        };

        recorder.start(100);
        this.echoRecorder = recorder;
        this.options.onState?.("echo-recording");
      } catch (error) {
        console.error("[echo] Recorder kon niet starten.", error);
        this.echoRecorder = null;
        this.options.onState?.("echo-recorder-error");
      }
    }

    _stopDelayedEchoCapture() {
      const recorder = this.echoRecorder;
      this.echoRecorder = null;
      if (!recorder || recorder.state === "inactive") return;
      try { recorder.stop(); } catch (_) {}
    }

    async _broadcastParrotReplay(url) {
      let audio = null;
      let context = null;
      let source = null;
      let destination = null;
      let replayTrack = null;
      let replayPublication = null;
      let floorStarted = false;
      try {
        if (!this.room || this.connectionState !== "connected") throw new Error("WebRTC room is niet verbonden.");
        if (typeof this.options.onParrotFloorRequest === "function") {
          floorStarted = (await this.options.onParrotFloorRequest({ channel_slug: this.channelSlug })) !== false;
          if (!floorStarted) {
            this.options.onState?.("parrot-floor-busy");
            return;
          }
        } else {
          floorStarted = true;
        }

        const LK = window.LivekitClient;
        audio = new Audio(url);
        audio.preload = "auto";
        audio.volume = 1;
        context = new (window.AudioContext || window.webkitAudioContext)();
        if (context.state === "suspended") await context.resume();
        source = context.createMediaElementSource(audio);
        destination = context.createMediaStreamDestination();
        source.connect(destination);
        // De bronradio hoort de Papegaai ook terug; andere deelnemers horen
        // dezelfde opname via de gedeelde LiveKit-room.
        source.connect(context.destination);
        const mediaTrack = destination.stream.getAudioTracks()[0];
        replayTrack = new LK.LocalAudioTrack(mediaTrack);
        replayPublication = await this.room.localParticipant.publishTrack(replayTrack, {
          audioBitrate: Math.max(6000, Number(this.audioConfig?.bitrate_kbps || this.options.bitrateKbps || 20) * 1000),
          dtx: false,
          red: this.audioConfig?.red === true,
          source: LK.Track.Source.Microphone,
          name: "parrot-replay",
        });

        this.echoPlayback = audio;
        this.options.onEchoPlayback?.(true, { name: "Papegaai", channel_slug: this.channelSlug });
        await new Promise((resolve, reject) => {
          audio.onended = resolve;
          audio.onerror = () => reject(new Error("Papegaai-audio kon niet worden afgespeeld."));
          audio.play().catch(reject);
        });
      } catch (error) {
        console.error("[parrot] Broadcast kon niet starten of afronden.", error);
        this.options.onState?.("parrot-broadcast-error");
      } finally {
        this.options.onEchoPlayback?.(false, { name: "Papegaai", channel_slug: this.channelSlug });
        try { audio?.pause?.(); } catch (_) {}
        if (this.echoPlayback === audio) this.echoPlayback = null;
        try {
          if (replayPublication && this.room?.localParticipant) {
            await this.room.localParticipant.unpublishTrack(replayTrack, true);
          }
        } catch (_) {}
        try { replayTrack?.stop?.(); } catch (_) {}
        try { source?.disconnect?.(); } catch (_) {}
        try { destination?.disconnect?.(); } catch (_) {}
        try { await context?.close?.(); } catch (_) {}
        try { URL.revokeObjectURL(url); } catch (_) {}
        if (floorStarted && typeof this.options.onParrotFloorRelease === "function") {
          try { await this.options.onParrotFloorRelease({ channel_slug: this.channelSlug }); } catch (error) {
            console.error("[parrot] Floor kon niet worden vrijgegeven.", error);
          }
        }
      }
    }

    async ensurePublisher() {
      if (this.localTrack && this.publication) return this.localTrack;
      if (!this.room || this.connectionState !== "connected") {
        throw new Error("WebRTC room is niet verbonden.");
      }

      const LK = window.LivekitClient;
      let track = null;
      try {
        track = await LK.createLocalAudioTrack({
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });

        // Een voorbereid dispatch-spoor mag vóór een floor-grant nooit audio
        // uitzenden. Daarom eerst muten en pas daarna publiceren.
        await track.mute();

        const publication = await this.room.localParticipant.publishTrack(track, {
          audioBitrate: Math.max(6000, Number(this.audioConfig?.bitrate_kbps || this.options.bitrateKbps || 20) * 1000),
          dtx: this.audioConfig?.dtx !== false,
          red: this.audioConfig?.red === true,
          source: LK.Track.Source.Microphone,
        });

        this.localTrack = track;
        this.publication = publication;
        return this.localTrack;
      } catch (error) {
        // Belangrijk: een mislukte publish mag geen 'localTrack' achterlaten.
        // Anders denkt een volgende PTT dat de microfoon klaar is terwijl het
        // spoor nooit in de LiveKit-room gepubliceerd werd.
        try { track?.stop?.(); } catch (_) {}
        this.localTrack = null;
        this.publication = null;
        throw error;
      }
    }

    async setTransmit(active) {
      if (this.nativeMode) {
        await this._nativeRequest("set-transmit", { active: active === true });
        return;
      }

      if (active) {
        // Portofoon is half-duplex: tijdens TX geen RX playback.
        await this.setReceiveEnabled(false);
        await this.ensurePublisher();
        if (!this.localTrack) return;
        await this.localTrack.unmute();
        this._startDelayedEchoCapture();
        return;
      }

      // Echo-recording stopt exact bij TX-end; replay start pas daarna.
      // Recorder eerst stoppen zodat het laatste audioblok nog kan flushen,
      // daarna pas de LiveKit microfoon muten.
      this._stopDelayedEchoCapture();
      if (this.localTrack) await this.localTrack.mute();
      await this.setReceiveEnabled(true);
    }

    startStats() {
      if (this.statsTimer) clearInterval(this.statsTimer);
      this.statsTimer = setInterval(() => { void this.sampleStats(); }, 1000);
    }

    _rate(key, bytes, timestampMs) {
      const previous = this.previous.get(key);
      this.previous.set(key, { bytes, timestampMs });
      if (!previous || timestampMs <= previous.timestampMs || bytes < previous.bytes) return null;
      return ((bytes - previous.bytes) * 8) / (timestampMs - previous.timestampMs); // kbps: bits/ms
    }


    _packetLoss(key, received, lost) {
      received = Number(received || 0); lost = Number(lost || 0);
      const previous = this.previous.get(`loss:${key}`);
      this.previous.set(`loss:${key}`, { received, lost });
      if (!previous || received < previous.received || lost < previous.lost) return null;
      const deltaReceived = received - previous.received;
      const deltaLost = lost - previous.lost;
      const total = deltaReceived + deltaLost;
      return total > 0 ? (deltaLost / total) * 100 : 0;
    }

    _consumeReport(report, prefix) {
      const now = Date.now();
      report.forEach(stat => {
        const audio = stat.kind === "audio" || stat.mediaType === "audio";
        if (!audio) return;
        if (stat.type === "remote-inbound-rtp") {
          if (Number.isFinite(stat.roundTripTime)) this.metrics.rtt.add(stat.roundTripTime * 1000);
          if (Number.isFinite(stat.jitter)) this.metrics.jitter.add(stat.jitter * 1000);
          const loss = this._packetLoss(`${prefix}:tx:${stat.id}`, stat.packetsReceived, stat.packetsLost);
          if (loss !== null) this.metrics.txLoss.add(loss);
        }
        if (stat.type === "inbound-rtp") {
          if (Number.isFinite(stat.jitter)) this.metrics.jitter.add(stat.jitter * 1000);
          if (Number.isFinite(stat.concealedSamples)) this.rxDiagnostics.concealedSamples = Number(stat.concealedSamples);
          if (Number.isFinite(stat.concealmentEvents)) this.rxDiagnostics.concealmentEvents = Number(stat.concealmentEvents);
          if (Number.isFinite(stat.totalSamplesReceived)) this.rxDiagnostics.totalSamplesReceived = Number(stat.totalSamplesReceived);
          if (Number.isFinite(stat.insertedSamplesForDeceleration)) this.rxDiagnostics.insertedSamplesForDeceleration = Number(stat.insertedSamplesForDeceleration);
          if (Number.isFinite(stat.removedSamplesForAcceleration)) this.rxDiagnostics.removedSamplesForAcceleration = Number(stat.removedSamplesForAcceleration);
          if (Number.isFinite(stat.jitterBufferDelay)) this.rxDiagnostics.jitterBufferDelay = Number(stat.jitterBufferDelay);
          if (Number.isFinite(stat.jitterBufferEmittedCount)) this.rxDiagnostics.jitterBufferEmittedCount = Number(stat.jitterBufferEmittedCount);
          if (Number.isFinite(stat.audioLevel)) this.rxDiagnostics.audioLevel = Number(stat.audioLevel);
          const loss = this._packetLoss(`${prefix}:rx:${stat.id}`, stat.packetsReceived, stat.packetsLost);
          if (loss !== null) this.metrics.rxLoss.add(loss);
          if (Number.isFinite(stat.bytesReceived)) {
            const rate = this._rate(`${prefix}:rx:${stat.id}`, Number(stat.bytesReceived), now);
            if (rate !== null) this.metrics.rxBitrate.add(rate);
          }
        }
        if (stat.type === "outbound-rtp" && Number.isFinite(stat.bytesSent)) {
          const rate = this._rate(`${prefix}:tx:${stat.id}`, Number(stat.bytesSent), now);
          if (rate !== null) this.metrics.txBitrate.add(rate);
        }
        if (stat.type === "candidate-pair" && stat.state === "succeeded" && Number.isFinite(stat.currentRoundTripTime)) {
          this.metrics.rtt.add(stat.currentRoundTripTime * 1000);
        }
      });
    }

    async sampleStats() {
      if (this.nativeMode) {
        try {
          await this._nativeRequest("status", {}, 2500);
          this.samples += 1;
        } catch (_) {
          // Heartbeat blijft werken wanneer de native bridge tijdelijk niet antwoordt.
        }
        return;
      }

      if (!this.room) return;
      let sampled = false;
      try {
        const sender = this.localTrack?.sender;
        if (sender?.getStats) { this._consumeReport(await sender.getStats(), "local"); sampled = true; }
      } catch (_) {}
      for (const track of this.remoteTracks) {
        try {
          const receiver = track.receiver;
          if (receiver?.getStats) { this._consumeReport(await receiver.getStats(), `remote:${track.sid || "audio"}`); sampled = true; }
        } catch (_) {}
      }
      if (sampled) this.samples += 1;
    }

    _rxCounterDelta(name, current) {
      if (!Number.isFinite(current)) return null;

      const previous = this.previousRxDiagnostics[name];
      this.previousRxDiagnostics[name] = current;

      /*
       * Een nieuwe receiver/WebRTC-sessie kan weer bij nul beginnen.
       * Dan rapporteren we bij de eerste sample bewust geen misleidende delta.
       */
      if (!Number.isFinite(previous) || current < previous) {
        return null;
      }

      return current - previous;
    }

    diagnosticsSnapshot() {
      if (this.nativeMode) {
        return {
          connection_state: this.nativeStatus.connection_state || this.connectionState,
          channel: this.channelSlug || null,
          provider: this.nativeStatus.provider || "livekit-android",
          native_audio: true,
          transmitting: this.nativeStatus.transmitting === true,
          receive_enabled: this.nativeStatus.receive_enabled !== false,
          native_last_reason: this.nativeStatus.last_reason || null,
          native_last_event_at_ms: this.nativeStatus.last_event_at_ms || null,
          remote_audio_tracks: Number(this.nativeStatus.remote_audio_tracks || 0),
          audio_elements: Number(this.nativeStatus.audio_elements || 0),
          active_remote_participant: this.nativeStatus.active_remote_participant || null,

          rtt_ms: this.nativeStatus.rtt_ms,
          jitter_ms: this.nativeStatus.jitter_ms,
          rx_loss_percent: this.nativeStatus.rx_loss_percent,
          rx_bitrate_kbps: this.nativeStatus.rx_bitrate_kbps,
          tx_loss_percent: this.nativeStatus.tx_loss_percent,
          tx_bitrate_kbps: this.nativeStatus.tx_bitrate_kbps,

          concealed_samples: this.nativeStatus.concealed_samples,
          concealed_samples_delta: this.nativeStatus.concealed_samples_delta,
          concealment_events: this.nativeStatus.concealment_events,
          concealment_events_delta: this.nativeStatus.concealment_events_delta,
          total_samples_received: this.nativeStatus.total_samples_received,
          total_samples_received_delta: this.nativeStatus.total_samples_received_delta,
          inserted_samples_for_deceleration: this.nativeStatus.inserted_samples_for_deceleration,
          inserted_samples_delta: this.nativeStatus.inserted_samples_delta,
          removed_samples_for_acceleration: this.nativeStatus.removed_samples_for_acceleration,
          removed_samples_delta: this.nativeStatus.removed_samples_delta,
          jitter_buffer_delay: this.nativeStatus.jitter_buffer_delay,
          jitter_buffer_emitted_count: this.nativeStatus.jitter_buffer_emitted_count,
        };
      }

      return {
        connection_state: this.connectionState,
        channel: this.channelSlug || null,
        rtt_ms: this.metrics.rtt.peek(),
        jitter_ms: this.metrics.jitter.peek(),
        rx_loss_percent: this.metrics.rxLoss.peek(),
        rx_bitrate_kbps: this.metrics.rxBitrate.peek(),
        concealed_samples: this.rxDiagnostics.concealedSamples,
        concealment_events: this.rxDiagnostics.concealmentEvents,
        total_samples_received: this.rxDiagnostics.totalSamplesReceived,
        inserted_samples_for_deceleration: this.rxDiagnostics.insertedSamplesForDeceleration,
        removed_samples_for_acceleration: this.rxDiagnostics.removedSamplesForAcceleration,
        remote_audio_tracks: this.remoteTracks.size,
        audio_elements: this.remoteElements.size,
        active_remote_participant:
          this.activeRemoteParticipant?.identity
          || this.activeRemoteParticipant?.name
          || null,
      };
    }

    takeTelemetry() {
      if (this.nativeMode) {
        const value = {
          transport: "webrtc",
          provider: this.nativeStatus.provider || "livekit-android",
          codec: "opus",
          channel: this.channelSlug || null,
          connection_state: this.nativeStatus.connection_state || this.connectionState,
          native_audio: true,
          samples: this.samples,
          transmitting: this.nativeStatus.transmitting === true,
          receive_enabled: this.nativeStatus.receive_enabled !== false,
          native_last_reason: this.nativeStatus.last_reason || null,
          native_last_event_at_ms: this.nativeStatus.last_event_at_ms || null,

          remote_audio_tracks: Number(this.nativeStatus.remote_audio_tracks || 0),
          audio_elements: Number(this.nativeStatus.audio_elements || 0),
          active_remote_participant: this.nativeStatus.active_remote_participant || null,

          rtt_ms: this.nativeStatus.rtt_ms,
          jitter_ms: this.nativeStatus.jitter_ms,
          rx_loss_percent: this.nativeStatus.rx_loss_percent,
          rx_bitrate_kbps: this.nativeStatus.rx_bitrate_kbps,
          tx_loss_percent: this.nativeStatus.tx_loss_percent,
          tx_bitrate_kbps: this.nativeStatus.tx_bitrate_kbps,

          concealed_samples: this.nativeStatus.concealed_samples,
          concealed_samples_delta: this.nativeStatus.concealed_samples_delta,
          concealment_events: this.nativeStatus.concealment_events,
          concealment_events_delta: this.nativeStatus.concealment_events_delta,
          total_samples_received: this.nativeStatus.total_samples_received,
          total_samples_received_delta: this.nativeStatus.total_samples_received_delta,
          inserted_samples_for_deceleration: this.nativeStatus.inserted_samples_for_deceleration,
          inserted_samples_delta: this.nativeStatus.inserted_samples_delta,
          removed_samples_for_acceleration: this.nativeStatus.removed_samples_for_acceleration,
          removed_samples_delta: this.nativeStatus.removed_samples_delta,
          jitter_buffer_delay: this.nativeStatus.jitter_buffer_delay,
          jitter_buffer_emitted_count: this.nativeStatus.jitter_buffer_emitted_count,
        };

        this.samples = 0;
        return value;
      }

      const concealedDelta = this._rxCounterDelta(
        "concealedSamples",
        this.rxDiagnostics.concealedSamples
      );
      const concealmentEventsDelta = this._rxCounterDelta(
        "concealmentEvents",
        this.rxDiagnostics.concealmentEvents
      );
      const totalSamplesDelta = this._rxCounterDelta(
        "totalSamplesReceived",
        this.rxDiagnostics.totalSamplesReceived
      );
      const insertedDelta = this._rxCounterDelta(
        "insertedSamplesForDeceleration",
        this.rxDiagnostics.insertedSamplesForDeceleration
      );
      const removedDelta = this._rxCounterDelta(
        "removedSamplesForAcceleration",
        this.rxDiagnostics.removedSamplesForAcceleration
      );

      const value = {
        transport: "webrtc",
        provider: "livekit",
        codec: "opus",
        channel: this.channelSlug || null,
        connection_state: this.connectionState,
        samples: this.samples,
        rtt_ms: this.metrics.rtt.take(),
        jitter_ms: this.metrics.jitter.take(),
        rx_loss_percent: this.metrics.rxLoss.take(),
        tx_loss_percent: this.metrics.txLoss.take(),
        rx_bitrate_kbps: this.metrics.rxBitrate.take(),
        tx_bitrate_kbps: this.metrics.txBitrate.take(),
        concealed_samples: this.rxDiagnostics.concealedSamples,
        concealment_events: this.rxDiagnostics.concealmentEvents,
        total_samples_received: this.rxDiagnostics.totalSamplesReceived,
        inserted_samples_for_deceleration: this.rxDiagnostics.insertedSamplesForDeceleration,
        removed_samples_for_acceleration: this.rxDiagnostics.removedSamplesForAcceleration,

        // Delta sinds de vorige heartbeat / takeTelemetry().
        concealed_samples_delta: concealedDelta,
        concealment_events_delta: concealmentEventsDelta,
        total_samples_received_delta: totalSamplesDelta,
        inserted_samples_delta: insertedDelta,
        removed_samples_delta: removedDelta,

        jitter_buffer_delay: this.rxDiagnostics.jitterBufferDelay,
        jitter_buffer_emitted_count: this.rxDiagnostics.jitterBufferEmittedCount,
        remote_audio_tracks: this.remoteTracks.size,
        audio_elements: this.remoteElements.size,
        active_remote_participant:
          this.activeRemoteParticipant?.identity
          || this.activeRemoteParticipant?.name
          || null,
      };
      this.samples = 0;
      return value;
    }

    async close() {
      if (this.nativeMode) {
        try { await this._nativeRequest("disconnect", {}, 4000); } catch (_) {}
        this.nativeMode = false;
        this.connectionState = "disconnected";
        this.nativeStatus = {
          provider: "livekit-js",
          connection_state: "disconnected",
          remote_audio_tracks: 0,
          audio_elements: 0,
          active_remote_participant: null,
          transmitting: false,
          receive_enabled: true,
          last_reason: null,
          last_event_at_ms: null,
          rtt_ms: null,
          jitter_ms: null,
          rx_loss_percent: null,
          rx_bitrate_kbps: null,
          tx_loss_percent: null,
          tx_bitrate_kbps: null,
          concealed_samples: null,
          concealed_samples_delta: null,
          concealment_events: null,
          concealment_events_delta: null,
          total_samples_received: null,
          total_samples_received_delta: null,
          inserted_samples_for_deceleration: null,
          inserted_samples_delta: null,
          removed_samples_for_acceleration: null,
          removed_samples_delta: null,
          jitter_buffer_delay: null,
          jitter_buffer_emitted_count: null,
        };
      }

      this._stopDelayedEchoCapture();
      try { this.echoPlayback?.pause?.(); } catch (_) {}
      this.echoPlayback = null;

      if (this.statsTimer) clearInterval(this.statsTimer);
      this.statsTimer = null;
      try { if (this.localTrack) await this.localTrack.mute(); } catch (_) {}
      try { this.localTrack?.stop(); } catch (_) {}
      this.localTrack = null; this.publication = null;
      for (const track of this.remoteTracks) {
        try { track.detach().forEach(element => element.remove()); } catch (_) {}
      }
      this.remoteTracks.clear();

      for (const element of this.remoteElements.values()) {
        try { element.remove(); } catch (_) {}
      }
      this.remoteElements.clear();
      this.activeRemotePublication = null;
      this.activeRemoteParticipant = null;

      this.previousRxDiagnostics = {
        concealedSamples: null,
        concealmentEvents: null,
        totalSamplesReceived: null,
        insertedSamplesForDeceleration: null,
        removedSamplesForAcceleration: null,
      };

      if (this.echoRoom) {
        try { await this.echoRoom.disconnect(); } catch (_) {}
      }
      if (this.room) {
        try { await this.room.disconnect(); } catch (_) {}
      }
      this.echoRoom = null;
      this.room = null;
      this.connectionState = "disconnected";
      this.channelSlug = "";
      this.channelType = "";
    }
  }

  window.PocLiveKitMedia = PocLiveKitMedia;
})();
