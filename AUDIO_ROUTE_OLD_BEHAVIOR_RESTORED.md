# Audio route old behavior restored

Normal radio audio selection now matches the supplied old server behavior:

- Do not wait up to 600 ms for the Android native media bridge.
- Use native media only when it is already available at channel connect time.
- Otherwise use Gecko/browser LiveKit WebRTC for that connection.
- Piper test-clock TTS and all other newer server changes are retained.
- Opus/bitrate/DTX settings were not changed by this fix.
