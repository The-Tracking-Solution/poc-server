# Master audio volume

Alle hoorbare lokale audio in ui_radio volgt nu de ingestelde radio-volumeparameter (`radio-volume`): RX LiveKit-elementen, TTS, UI-/toetstonen, TX-feedback, fout/bezettonen, diagnostische toon en lokale Papegaai-weergave.

Dispatch behoudt zijn eigen master-volume en mute-instelling; lokale dispatch-tonen en meldingssignalen worden nu eveneens met dit master-volume vermenigvuldigd. Kanaal-RX liep al via de dispatch master gains.

PTT/floor/control-logica is niet aangepast.
