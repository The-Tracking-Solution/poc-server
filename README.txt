TTS POC - radio layout update 2026-08-19

Gewijzigde bestanden:
- ui_radio/static/ui_radio/tenant_screen.css
- ui_radio/static/ui_radio/tenant_screen.js
- ui_radio/templates/ui_radio/tenant_screen.html

Nieuwe layout:
- Verticaal: TK 8%, DISPLAY 32%, NK 20%, KB 32%, SR 8%
- Horizontaal: LK 10%, CENTER 80%, RK 10%
- DISPLAY: MENUBAR 15%, TITLEBAR 10%, CONTENT 60%, SK 15%
- MENUBAR: marineblauw (#001f3f), witte tekst, voorlopig 'RADIO'
- Hidden secties worden uit het fr-grid verwijderd; resterende ruimte wordt proportioneel herverdeeld.
- Hidden LK/RK geeft de centerkolom de vrijgekomen breedte terug.
- Hidden TK geeft het center-deel de vrijgekomen hoogte terug.

Installatie:
1. Maak een backup van de drie bestaande bestanden.
2. Kopieer deze bestanden over dezelfde paden in het project.
3. Herbouw/herstart web indien static files in de image zitten:
   docker compose up -d --build web
4. Indien collectstatic nodig is in jouw setup:
   docker compose exec web python manage.py collectstatic --noinput
5. Browser/app hard refresh en test /radio/test/
