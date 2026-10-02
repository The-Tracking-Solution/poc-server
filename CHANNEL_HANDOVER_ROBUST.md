# Robuuste kanaalhandover

- Kanaalwissel heeft een eigen `channelSwitchInFlight` toestand en wordt niet als netwerkverlies gemeld.
- Oude control/media blijft actief tot de serverselectie is verwerkt en een verse bootstrap het nieuwe kanaal bevestigt.
- De client forceert nooit meer lokaal een nieuw kanaal met credentials van het oude kanaal.
- Bootstrap wordt maximaal 12 keer met 125 ms tussenruimte gecontroleerd op het verwachte kanaal.
- Snelle hardware/rotary kanaalacties worden geserialiseerd zodat handovers niet over elkaar heen lopen.
- Een verwachte close/error van de oude WebSocket tijdens handover toont geen `Verbinding verloren`.
- Alleen wanneer de gecontroleerde handover echt faalt, valt de code terug op de normale reconnect-flow.
