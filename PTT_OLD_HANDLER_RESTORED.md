# PTT old-handler restore

Gebaseerd op de aangeleverde oude `server_dispatch_states_fix(1).zip`.

- oude bewezen `pttPress()` flow hersteld;
- experimentele `prepareTransmit()` uit kritieke PTT-pad verwijderd;
- oude LiveKit browser startup-volgorde hersteld;
- native `prepare-transmit` gate bij connect verwijderd;
- latere hardware key UP/release, reconnect, GUI en overige serverfixes behouden;
- tekst `Inschakelen` gewijzigd naar `Activeren`.
