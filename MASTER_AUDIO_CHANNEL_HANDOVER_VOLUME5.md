# Master audio + channel handover + 5% volume step

- Master-volume routing behouden.
- Bekend werkende channel-handover/reconnect-semantiek behouden.
- Normale kanaalwissel sluit gecontroleerd over naar verse bootstrap/control/media en wordt niet als verbindingsverlies behandeld.
- Volume-up/down gebruikt standaard 5 procentpunt.
- Oude opgeslagen configs met de voormalige standaardwaarde 10 worden runtime als 5 geïnterpreteerd; afwijkende custom stappen blijven behouden.
- Nieuwe hardware-defaults en admin-editor defaults gebruiken 5.
- PTT-handler, hardware-key fixes en Dispatch GUI niet gewijzigd.
