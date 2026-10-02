# Testklok – Piper TTS

De virtuele testklok gebruikt nu lokale Piper neural TTS in plaats van espeak-ng.

- Voice: `nl_NL-alex-medium`
- Model wordt tijdens `docker build` gedownload naar `/opt/piper-voices`.
- Geen externe TTS API tijdens runtime.
- Het model blijft in geheugen en wordt tussen minuten hergebruikt.
- `TEST_CLOCK_SPEECH_WPM` blijft de spreeksnelheid bepalen.
- Optioneel: `TEST_CLOCK_PIPER_VOLUME`, `TEST_CLOCK_PIPER_NOISE_SCALE`, `TEST_CLOCK_PIPER_NOISE_W_SCALE`.

De bestaande PTT-, LiveKit- en exacte :00-piep timing is niet gewijzigd.
