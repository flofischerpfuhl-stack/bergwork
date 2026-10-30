# berg:work PDF: Was nur die Desktop-App kann

Stand 2026-10-30. Leitfrage: Was kann eine Desktop-App, das eine Webseite grundsätzlich nicht kann, und was davon würde
berg:work PDF deutlich besser machen?

Geprüft ist nur Linux mit WebKitGTK 2.54. Windows und macOS waren nicht verfügbar. Aufwand in Personentagen (PT).
Konkurrenzangaben stammen aus einer Web-Recherche vom selben Tag; was dort nur schwach belegt war, steht als
„unsicher“. Messungen sind eigene und unter „Native Engine“ beschrieben. Den Stand der App-Grundlagen (Fenster,
Speichern, Absturz) führt `docs/PDF-TODO.md`, Abschnitt „Desktop apps“.

## Kurzfassung

Die Webseite ist bei der Bearbeitung selbst nicht schlechter: Der Editor ist derselbe, und PDFium-WASM ist für normale
Dokumente schnell genug. Der Vorsprung der App liegt woanders:

1. **Die App arbeitet mit Dateien, nicht mit Kopien.** Speichern auf das Original, Ordner als Arbeitsmappe, Stapel,
   überwachte Ordner, Versionen. Das ist der größte Hebel für tägliche Arbeit und meist klein.
2. **Die App spricht mit Geräten und dem System.** Scanner, Direktdruck mit Duplex und Fach, Zertifikatsspeicher,
   Explorer-Vorschau. Hier ist Acrobat stark, und hier bleibt die Webseite dauerhaft draußen.
3. **Die native Engine ist nur für Sonderfälle ein Hebel.** Gemessen rendert sie Text und Scans doppelt so schnell,
   Vektorpläne kaum schneller, und öffnet 1,2 GB mit 79 MB statt 2,4 GB Speicher. Der Umbau wäre aber ein zweiter
   Editor-Kern. Siehe „Native Engine“.

## Reihenfolge

| Stufe | Punkt | Aufwand | Warum jetzt |
| --- | --- | --- | --- |
| Erledigt | Speichern auf das Original, Änderungen von außen, mehrere Fenster, zuletzt geöffnet, Drop mit Pfad | im Branch | Grundlage für alles Weitere |
| 1 | Ordner als Arbeitsmappe (nächste/vorherige PDF) | 2–3 | Klein, täglicher Nutzen, im Web unmöglich |
| 1 | Taskleisten-Fortschritt bei langen Jobs | 0,5 | Fertige Tauri-API |
| 1 | System-Schriften | 2–4 | Beim Bearbeiten fehlt sonst oft die Originalschrift |
| 1 | Direktdruck unter Linux (CUPS) | 2–3 | `lp` genügt, Duplex und Fach inklusive |
| 1 | Sperrhinweis und Versionen neben der Datei | 3–4 | Schützt vor Datenverlust beim Überschreiben |
| 1 | Linux-Thumbnailer | 1–2 | Liegt fast fertig in CLI/Engine |
| 2 | Stapel über ganze Ordner, überwachte Ordner | 5–8 | Baut auf CLI, Stufe 1 und dem Batch-Panel auf |
| 2 | Natives Windows-Paket: Standard-App, Explorer-Vorschau, Direktdruck | 15–25 | Erst nach dem Windows-Build |
| 2 | Natives OCR (Windows.Media.Ocr, Vision) | 3–5 je System | Kein 27-MB-Tesseract, oft bessere Handschrift/Layout-Erkennung (unsicher) |
| 2 | Drag-out, Zwischenablage mit echten Formaten, „Per Mail senden“ | 5–8 | Verbindet die App mit dem Rest des Arbeitsplatzes |
| 3 | Scannen (SANE, WIA, TWAIN) | 10–20 | Großer Punkt gegen Acrobat, aber mühsam je Plattform |
| 3 | Signieren mit Zertifikatsspeicher und Smartcard | 15–30 | Für Behörden und Büros zwingend, sonst selten |
| 3 | Office-Konvertierung über LibreOffice | 3–5 | Nur wenn installiert; billig, solange es optional bleibt |
| 3 | Lokale KI (Zusammenfassen, Formulare erkennen) | offen | Erst mit klarer Funktion; Modelle sind groß |
| 2 | Parallele WASM-Worker für Kacheln und Miniaturen (in Fernwork) | 5–10 | Holt den Tempogewinn der nativen Engine ohne deren Kosten |
| Später | Native Engine | 60–120 | Nur bei belegtem Bedarf an sehr großen Dateien, siehe unten |
| Nicht bauen | Eigener Windows-Druckertreiber | 15–30, hohes Risiko | Treiber-Ende bei Microsoft, siehe `docs/PDF-TODO.md` |

## Native Engine

**Frage:** Was brächte PDFium nativ in Rust statt WASM, und passt das zur Worker-Architektur?

**Ergebnis:** nativ ist beim Rendern von Text und Scans doppelt so schnell, bei Vektorplänen kaum. Der klare Gewinn liegt
bei sehr großen Dateien, nicht beim Tempo. Der Umbau wäre ein zweiter Editor-Kern. Empfehlung: **nicht umbauen**, solange
kein echter Bedarf an Dateien über etwa 1 GB belegt ist. Das Tempo holt man billiger über parallele Worker.

### Messung

Gleiche Dateien, gleiche Schritte, je dreimal, Median. CPU-Zeit statt Uhrzeit, weil auf dem PC parallel andere Jobs
liefen (Ryzen 3 PRO 3200G, 4 Threads, `nice 19`). Rendern bei 150 dpi. Testdateien selbst erzeugt:
`~/AgentWork/pdf-desktop/native-bench/` (Quellen `bench.c`, `bench-wasm.cjs`, `run.sh`).

| Datei | Schritt | Nativ | WASM | Faktor |
| --- | --- | --- | --- | --- |
| Text, 300 Seiten | Rendern | 3,65 s | 7,39 s | 2,0 |
| | Text je Seite lesen | 0,96 s | 1,30 s | 1,4 |
| Vektorplan, 12 große Seiten, je 150 000 Linien | Rendern | 17,0 s | 19,0 s | 1,1 |
| | Seiten laden und Text | 1,76 s | 2,68 s | 1,5 |
| Scan, 60 Seiten, 2480×3508 JPEG | Rendern | 6,15 s | 13,67 s | 2,2 |
| Sehr groß, 1,2 GB (10 Seiten) | Öffnen | 0,5 ms | 1,3 s | über 1000 |
| | Spitze Arbeitsspeicher | 79 MB | 2 438 MB | 31 |
| | Rendern | 1,03 s | 2,41 s | 2,3 |

Vier Prozesse auf vier Threads rendern den Scan in 3,4 bis 3,8 s statt 8,7 s Uhrzeit, also 2,4-mal schneller auf
einem ausgelasteten Rechner.

**Grenzen der Messung:**

- WASM lief in Node (V8), nicht in der App. Das entspricht grob WebView2; JavaScriptCore in WKWebView und WebKitGTK ist
  nicht gemessen.
- Nativ ist `pdfium-binaries` chromium/8125, also **ohne** Fernworks 29 Patches und mit anderem Stand als der
  EmbedPDF-Fork im WASM. Für Rendern und Lesen ist das aussagekräftig, fürs Bearbeiten nicht.
- WASM selbst ist `vendor/pdfium/runtime/pdfium.wasm` (Hash `ddb4dc04`), identisch mit dem gepinnten Build.
- Die IPC-Kosten zwischen nativem Prozess und WebView fehlen in der Tabelle. Sie sind der wunde Punkt: In der App unter
  WebKitGTK brauchte `read_file` 64 ms für 1 MB, 747 ms für 10 MB, 3,6 s für 50 MB und 10 s für 157 MB, also rund
  15 MB/s. Das ist gedrosselt gemessen (`nice 19`, PC ausgelastet), also eine Obergrenze. Eine A4-Seite bei 150 dpi sind
  8,7 MB Bitmap. Selbst bei fünffachem Tempo kostet das Hinüberreichen mehr als das Rendern in WASM (25 ms). Ein
  WASM-Worker reicht dieselbe Bitmap dagegen ohne Kopie weiter. WebView2 und WKWebView sind nicht gemessen.
- Über 4 GB wurde nicht gemessen; die Grenze ist die 32-Bit-Adressierung, nicht eine Beobachtung.

### Was das bedeutet

| Versprechen | Befund |
| --- | --- |
| Mehrere Kerne | Nur mit mehreren Prozessen. PDFium ist nicht threadsicher, `pdfium-render` serialisiert per Mutex. Dasselbe geht mit mehreren WASM-Workern, auch im Web |
| Kein 4-GB-Limit | Stimmt. Memory64 fehlt in Safari und damit vermutlich in WKWebView und WebKitGTK (unsicher, aus Browserdaten geschlossen), WebKit-Bug 300538 ist offen. In WebView2 wohl vorhanden, dort aber ungetestet |
| Sehr große Dateien, gestreamt | Der größte echte Gewinn: `FPDF_LoadDocument` liest bei Bedarf von der Platte, 79 MB statt 2,4 GB. Der Editor hält allerdings selbst Bytes im Speicher und in IndexedDB; das müsste mit umgebaut werden |
| GPU | Nicht belegt. `FPDF_RenderPageSkia` ist experimentell und braucht `PDF_USE_SKIA`, ob das GPU nutzt, ist offen. `pdfium-binaries` führt kein Skia |
| Tempo für alle | Eine A4-Textseite kostet in WASM rund 25 ms, ein Scan rund 230 ms. Das merkt niemand. Nur große Scans und Stapel gewinnen, und nativ gerenderte Bitmaps müssen erst durch die langsame IPC. Lohnend ist nativ also dort, wo das Ergebnis eine Datei ist: Stapel, Export, Komprimieren, Thumbnailer |

### Passt es zur Worker-Architektur?

Der Vertrag an der Schale ist schmal (`engine/protocol.js`, `worker-transport.js`, `session-orchestrator.js`), eine
native Transportschicht wäre also denkbar. Dahinter liegt aber die eigentliche Arbeit: `pdfium-worker.js` hat rund
24 000 Zeilen Bearbeitungslogik, die direkt und in vielen kleinen Aufrufen an den PDFium-Exports hängt. Einzeln über IPC
geht das nicht, die Logik müsste nach Rust.

| Weg | Inhalt | Aufwand | Bewertung |
| --- | --- | --- | --- |
| A: Voller Umbau | Worker nach Rust, 29 Patches nativ für drei Systeme bauen (Chromium-Werkzeuge, CI), Editor-Speicher umstellen. Das Web bleibt WASM, also zwei Kerne pflegen | 60–120 PT plus Dauerlast | Nicht jetzt |
| B: Nativer Nur-Lese-Renderer | Kacheln und Miniaturen nativ, Bearbeitung bleibt WASM | 10–20 PT | Nein: Die IPC frisst den Gewinn, und das Speicherproblem bleibt, weil die Sitzung die Datei weiter ganz hält |
| B2: Native Stapel ohne Oberfläche | CLI, Thumbnailer, Stapel-OCR, Export über Rust und PDFium. Ergebnis ist eine Datei, keine Bitmap im WebView. Ohne Fernwork-Patches reicht das nur für Lesen und Rendern | 5–10 PT | Sinnvoll, sobald Stapel oder Thumbnailer gebaut werden |
| C: Mehrere WASM-Worker | Miniaturen und Kacheln parallel, Scheduler heute `maxConcurrent: 1`. Jeder Worker hält eine Kopie der Datei, also nur für kleine bis mittlere Dateien | 5–10 PT in Fernwork | **Empfohlen.** Gleicher Gewinn wie die Prozesse oben, auch im Web, kein zweiter Kern |
| D: Modus für Riesendateien | Nur ansehen, kommentieren, Seiten auswählen, nativ gestreamt; Bearbeitung exportiert einen Ausschnitt | 15–25 PT | Nur bei belegtem Bedarf |

Zu A: Fernworks Patches sind Quellpatches an PDFium und nicht WASM-spezifisch; „native“ meint dort den C++-Teil im
WASM. Einen nativen Build mit Patches gibt es noch nicht, der Weg über `rebuild-runtime.sh` zielt auf Emscripten.

## Dateisystem

Im Browser sieht die App Kopien; File System Access gibt es nur in Chromium, und auch dort nur für einzelne, vom Nutzer
gewählte Dateien und Ordner. Die App sieht das Dateisystem.

| Punkt | Was ginge konkret | Nutzen | Konkurrenz | Aufwand | Plattformen |
| --- | --- | --- | --- | --- | --- |
| Speichern auf das Original | **Gebaut.** Ohne Dialog, atomar, Rechte bleiben. Nicht nach Reparatur oder entfernter Sicherung | Der häufigste Arbeitsschritt | Standard überall | erledigt | alle (nur Linux geprüft) |
| Änderungen von außen | **Gebaut.** Abfrage alle 3 s und beim Fokus. Saubere Dokumente laden neu, sonst Frage | LaTeX, CAD-Export, Sync-Ordner | Okular lädt automatisch neu. PDF-XChange sperrt die Datei, Stand 2017 ohne Auto-Reload (unsicher) | erledigt | alle |
| Ordner als Arbeitsmappe | Nächste/vorherige PDF im Ordner per Taste, Ordnerbaum im linken Panel | Rechnungen, Scans, Planstapel durchgehen, ohne je einen Dialog zu öffnen | Keine belegte Stärke der Konkurrenz; die Ordneransicht von Foxit und PDF-XChange ist nicht geprüft | 2–3, Baum 3–5 | alle |
| Stapel über Ordner | Das Batch-Panel und die CLI auf einen ganzen Ordner anwenden: OCR, Komprimieren, Schwärzen, Wasserzeichen, PDF/A, mit Ausgabeordner und Fehlerliste | Massenarbeit, heute Domäne von Acrobat Pro | Action Wizard in Acrobat Pro, bei Foxit nur Pro, bei PDF-XChange über PDF-Tools | 3–5 | alle |
| Überwachte Ordner | Datei fällt in einen Ordner, App bearbeitet sie und legt sie ab. Im Hintergrund über Tray und Autostart | Scanner-Eingang, Rechnungsablage | Acrobat hat „Watched Folders“ nur im Distiller für PostScript. Echte PDF-Automation fehlt dort | 3–5 | alle |
| Netzlaufwerke | Abfrage funktioniert schon dort, wo Dateisystem-Ereignisse fehlen: `inotify` sieht nur lokale Änderungen, unter NFS nur die desselben Clients. Bei Fehlern klare Meldung statt Hänger; Dateizugriffe laufen bereits abseits des Hauptthreads | Büros mit Serverlaufwerk | Word und Acrobat ebenso | 1–2 | alle |
| Sperrdateien | Beim Öffnen `.~lock.<name>#` oder `~$name` prüfen und anlegen, Hinweis „gerade bei X offen“. Word-Muster: `~$` mit Login-Name, bleibt nach Absturz liegen | Verhindert doppelte Bearbeitung im Team | Word; Verhalten von Acrobat nicht belegt | 1–2 | alle |
| Autosave neben der Datei | Heute liegt die Wiederherstellung in IndexedDB. Optional daneben: `.name.pdf.bergwork` | Überlebt Neuinstallation und Rechnerwechsel | Word | 2 | alle |
| Versionen | Vor dem Überschreiben die alte Fassung in einen Ordner legen, die letzten N behalten, im Panel vergleichen (Compare gibt es schon) | Schutz gegen Fehler bei Ctrl+S; verbindet sich mit Compare | Nicht belegt | 2–3 | alle |

## Eingabegeräte und Hardware

| Punkt | Was ginge konkret | Nutzen | Konkurrenz | Aufwand | Plattformen |
| --- | --- | --- | --- | --- | --- |
| Scannen | Scanner wählen, Seiten einziehen, Reihenfolge prüfen, gleich OCR. Linux SANE, Windows WIA 2.0 und TWAIN, macOS ICA | Der klassische Grund für ein PDF-Programm im Büro | Acrobat (TWAIN und WIA umschaltbar), PDF-XChange, Foxit, Master PDF. Okular nicht (unsicher) | 10–20 | je System eigener Weg; Rust-Crates sind dünn (`sane-scan`, `twain`), LibInsane deckt SANE, WIA, TWAIN ohne macOS ab. 64-Bit-Apps mit 32-Bit-TWAIN-Treibern brauchen einen Hilfsprozess |
| Kamera | Dokument-Scan mit Kanten- und Lichtausgleich | Im Web über `getUserMedia` möglich, also kein Desktop-Vorteil | App-Stores | nicht vorrangig | — |
| Stifttablett mit Druck | Pointer Events liefern `pressure` auch im Browser; nativ kämen Wintab und bessere Latenz dazu | Handschrift beim Unterschreiben und Markieren | Nicht geprüft | 1 für Druckstärke im Pinsel | Prüfen, ob WebView2 und WebKitGTK Druck durchreichen |
| Smartcards und Token | PKCS#11 (Linux, Windows, macOS), Windows CNG. Signatur mit qualifizierter Karte | Pflicht in Behörden und bei Notaren | Acrobat (PKCS#11), Okular (über NSS, im Flatpak gebrochen), PDF-XChange (System-Store) | 15–30 zusammen mit Zertifikatsspeicher, Zeitstempel, LTV | alle, je eigenes API |
| Zertifikatsspeicher | Windows-Store und macOS Keychain lesen statt PFX-Datei hochzuladen | Der private Schlüssel bleibt, wo er liegt | Acrobat, PDF-XChange | siehe oben | Windows, macOS; Linux NSS |
| Zweiter Bildschirm | Präsentation auf dem Beamer, Notizen und nächste Folie auf dem Laptop; Referenzdokument im zweiten Fenster | Vortrag; Vergleich am Doppelschirm. Die Fenster dafür gibt es jetzt | Acrobat (Monitorwahl im Vollbild), Okular (Bildschirmwahl) | 2–3 | alle (Monitorliste über Tauri) |

## Drucken

Die Webseite und die App drucken heute beide über den Browser-Dialog. Unter WebKitGTK ist das nicht geprüft: Xvfb hat
keinen Drucker. Das heißt: kein Duplex-Preset, kein Fach, kein Stapel.

| Punkt | Was ginge konkret | Nutzen | Konkurrenz | Aufwand | Plattformen |
| --- | --- | --- | --- | --- | --- |
| Druckerliste, Direktdruck | Eigener Dialog mit Drucker, Kopien, Bereich; ohne Browser | Ein Klick statt Dialogkette | Standard | Linux 2–3, Windows 3–6, macOS 3–6 | Linux `lpstat`/`lp`. Windows `FPDF_RenderPage` auf einen Drucker-DC, das geht nur unter Windows. macOS `PDFDocument.printOperation` |
| Duplex, Fächer | `lp -o sides=two-sided-long-edge -o media=A4,Tray2`. Windows `DEVMODE.dmDuplex`, `dmDefaultSource` | Briefpapier im Fach 1, Anlagen im Fach 2 | Acrobat mit Presets | in oben enthalten | macOS nicht belegt |
| Stapeldruck | Ganzen Ordner oder Mappe drucken, mit Trennseite | Rechnungspakete, Bauantrag | Acrobat über Aktionen | 1–2 nach Direktdruck | alle |
| Virtueller Drucker | Nicht bauen unter Windows. Stattdessen nach „Microsoft Print to PDF“ öffnen oder einen Ordner überwachen. macOS PDF Services, Linux CUPS-Backend | „Drucken nach berg:work“ aus jeder App | Foxit ja, Master PDF nur Windows, PDF-XChange als eigenes Produkt | 2–4 je Weg | siehe `docs/PDF-TODO.md`, „Printing to berg:work PDF“ |

## System-Integration

| Punkt | Was ginge konkret | Nutzen | Konkurrenz | Aufwand | Plattformen |
| --- | --- | --- | --- | --- | --- |
| Standard-App | Knopf „Als Standard festlegen“ | Der Einstieg in tägliche Nutzung | Standard | 5–8 | Windows nur über Systemeinstellungen (UCPD blockiert stilles Setzen, auch für `.pdf`). macOS `CFBundleDocumentTypes`, Linux `xdg-mime` |
| Vorschau im Dateimanager | Explorer-Vorschau und Miniaturen aus eigener Engine | Sichtbar an jeder PDF, jeden Tag | Acrobat (Option), PDF-XChange (`F_ShellExt`), Foxit (`FX_SE`) | Linux 1–2 (`.thumbnailer`), Windows 8–16 (`IThumbnailProvider`, `IPreviewHandler` in Prevhost.exe mit Low Integrity), macOS 3–5 (Quick Look, Sandbox zwingend, unsicher) | je System |
| Kontextmenü im Explorer | „Zusammenfügen“, „Komprimieren“ auf markierte Dateien | Wege ohne App-Start | Verbreitet, im Einzelnen nicht geprüft | Linux 1 (Dolphin Service Menu, Nautilus-Erweiterung), Windows 3–5 (`IExplorerCommand` plus Sparse Package für das neue Menü; ohne das nur „Weitere Optionen“) | je System |
| Jump Lists, zuletzt verwendet | Zuletzt geöffnete Dateien am Taskleisten-Symbol | Kleiner, sichtbarer Komfort | Standard unter Windows | 2–3 | Windows eigener Weg über `ICustomDestinationList`; in Tauri nicht fertig. Linux GTK Recent Manager 0,5 |
| Taskleisten-Fortschritt | OCR und Export zeigen Fortschritt am Symbol | Lange Jobs laufen im Hintergrund | Standard | 0,5 | `setProgressBar`; Linux und macOS app-weit, Linux nur mit libunity |
| Benachrichtigungen | „OCR fertig“, „Stapel abgeschlossen“, wenn das Fenster nicht vorn liegt | Nur bei langen Jobs wertvoll | selten | 0,5–1 | Tauri-Plugin |
| Globale Tastenkürzel | Zum Beispiel Screenshot in PDF | Selten gebraucht, Kollisionsgefahr | selten | 0,5 | Tauri-Plugin, unter Wayland eingeschränkt |
| Tray, Autostart | Nur für überwachte Ordner sinnvoll | Hintergrunddienst ohne Fenster | — | 1 | Tauri-Plugin; Tray unter Linux ohne Maus-Events |
| System-Schriften | Installierte Schriften auflisten, zum Einbetten anbieten, Einbettungsrechte beachten | Beim Textbearbeiten passt die Schrift; heute nur gebündelte Ersatzschriften | Acrobat, PDF-XChange | 2–4 | `fontdb`, DirectWrite, CoreText |
| Rechtschreibung | System-Prüfung in Textfeldern und beim Bearbeiten | Für Text in Formularen, Kommentaren, Absätzen | Acrobat, PDF-XChange (Plugin) | 1–3 | WebView2 und WebKitGTK prüfen Textfelder selbst (unsicher); im Canvas-Editor eigener Weg nötig |
| Screenshot zu PDF, PDF aus Zwischenablage | Bild aus der Zwischenablage als neue PDF oder Seite | Schneller Beleg | Acrobat, Foxit („PDF from clipboard“) | 1–2 | Zwischenablage auch im Web teilweise; Bildschirm-Aufnahme über System (Windows `ms-screenclip`, Linux Portal) |

## Andere Programme

| Punkt | Was ginge konkret | Nutzen | Konkurrenz | Aufwand | Plattformen |
| --- | --- | --- | --- | --- | --- |
| Drag hinaus | Seite oder Auswahl als echte Datei in den Explorer oder ins Mail-Programm ziehen | Seiten aus einem Dokument herausziehen, ohne Export | Nicht belegt | 2–4 | `tauri-plugin-drag` 2.1 für Windows, macOS, GTK; verlangt eine Datei auf der Platte, Wayland ungeklärt |
| Zwischenablage mit echten Formaten | Auswahl als `image/png` plus PDF plus Text kopieren, Seiten als PDF-Datei einfügen | Einfügen in Word und Mail mit Bild, nicht als Pfad | teils | 2–3 | Eigene Rust-Seite nötig, je System |
| „Per Mail senden“ | Das aktuelle Dokument als Anhang im Mail-Programm | `mailto:` kann keine Anhänge, im Web also unmöglich | Acrobat | 2–4 | Windows MAPI, macOS Mail per Script, Linux `xdg-email --attach`, Thunderbird `-compose` |
| Öffnen in CAD oder Word | „Öffnen mit …“ für das aktuelle Dokument, Rückkehr über „Änderungen von außen“ | Pläne: nach BricsCAD und zurück. Das Neuladen ist schon gebaut | selten | 1 | `tauri-plugin-opener` |
| Office-Konvertierung | PDF↔Word/Excel und Office→PDF über installiertes LibreOffice | Die häufigste Frage an PDF-Programme; im Web nicht machbar | Acrobat und Foxit mit eigener Engine, deutlich besser | 3–5 | Wo LibreOffice installiert ist; Qualität begrenzt |
| Ghostscript | Bessere Komprimierung, PDF/X, PostScript-Eingang, wo installiert | Spezialfälle Druckvorstufe | Acrobat Preflight | 1–2 | AGPL: nur als externes Programm aufrufen, nie mitliefern |
| CLI und MCP aus der App | Die App-Installation bringt `bergwork-pdf-cli` mit; Agenten steuern die laufende App („öffne Datei X bei Seite Y“ gibt es schon) | Automation ohne Chromium-Start; ein Alleinstellungsmerkmal | keine belegt | 3–5 | alle |

## Lokale Rechenleistung

| Punkt | Was ginge konkret | Nutzen | Konkurrenz | Aufwand | Plattformen |
| --- | --- | --- | --- | --- | --- |
| Natives OCR | Windows.Media.Ocr, Apple Vision, sonst Tesseract nativ | Spart das 27-MB-Paket und läuft auf allen Kernen. Tempo-Faktor nativ gegen WASM ließ sich nicht belegen, also messen | Acrobat, Foxit, PDF-XChange mit eigener Engine | 3–5 je System | Windows-Sprachen brauchen Adminrechte zur Installation, `MaxImageDimension` begrenzt; Vision-Sprachen zur Laufzeit abfragen |
| Lokale KI | Zusammenfassen, Fragen ans Dokument, Formularfelder erkennen, Tabellen lesen; alles ohne Upload | Vertrauliche Dokumente; Acrobat schickt solche Daten in die Cloud | Acrobat AI Assistant in der Cloud (unsicher) | 10+ | `ort` (ONNX), `llama-cpp-2` mit Vulkan/Metal; Modelle ab mehreren GB, also optionaler Download |
| Keine Browser-Speichergrenzen | Keine Quota für IndexedDB, Wiederherstellung auf Platte, kein Tab-Kill | Sicherheit bei großen Dateien. Heute läuft die Wiederherstellung noch über IndexedDB und OPFS fehlt in WebKitGTK | — | 3–5 | alle |

## Betrieb

| Punkt | Was ginge konkret | Nutzen | Aufwand | Plattformen |
| --- | --- | --- | --- | --- |
| Auto-Update | Tauri-Updater, Signatur Pflicht. Seit 2.10 laut Changelog alle Bundle-Typen, die Anleitung nennt weiter nur AppImage: Deb und Rpm testen. winget, AUR | Sicherheitsupdates ohne Nutzerarbeit | 3–5 | alle |
| Offline ohne Service Worker | Alles liegt in der Binary. Einzige Ausnahme: zusätzliche OCR-Sprachen von jsDelivr; Sprachpakete mitliefern oder klar anbieten | Flugzeug, abgeschottete Netze, Behörden | 1 | alle |
| Absturzberichte | Nur mit Zustimmung; JS-Fehler, Rust-Panics, Minidumps; nie Dokumentinhalt. Sentry EU oder eigenes Ziel | Fehler aus dem Feld, die wir sonst nie sehen | 2–3 | alle; `tauri-plugin-sentry` prüfen |
| Unternehmens-Installation | MSI mit `perMachine`, Silent-Schalter, GPO-Vorlagen, WebView2 offline (127 MB) oder fest (180 MB), Intune | Voraussetzung für Firmen | 3–5 | Windows |
| Signierung | Windows OV 150–300 $/Jahr; EV umgeht SmartScreen nicht mehr; Laufzeit seit März 2026 höchstens 460 Tage. Azure Artifact Signing: in der EU nur Organisationen, Einzelpersonen nur USA und Kanada. macOS 99 $/Jahr | Ohne Signatur warnen Windows und macOS | 2–3 je System | Windows, macOS |
| Flathub | Vorsicht: KI-Anteile offenlegen, Manifeste ohne KI-Inhalt, Agenten dürfen keine Einreichungen öffnen, Ablehnung ohne Prüfung möglich, Bau aus Quellen Pflicht. Also von Hand und spät | Linux-Reichweite | 3–5 | Linux |

## Quellen

Tauri: [Plugins](https://v2.tauri.app/plugin/), [Window-API](https://v2.tauri.app/reference/javascript/api/namespacewindow/),
[Updater-Changelog](https://tauri.app/release/updater/all-versions/),
[Windows-Installer](https://v2.tauri.app/distribute/windows-installer/).
PDFium: [fpdfview.h](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdfview.h),
[fpdf_dataavail.h](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_dataavail.h),
[pdfium-binaries](https://github.com/bblanchon/pdfium-binaries),
[pdfium-render](https://github.com/ajrcarey/pdfium-render).
WASM: [Memory64-Status](https://web-platform-dx.github.io/web-features-explorer/features/wasm-memory64),
[WebKit-Bug 300538](https://bugs.webkit.org/show_bug.cgi?id=300538),
[Jangda u. a., USENIX 2019](https://www.usenix.org/publications/login/fall2019/jangda).
Windows: [WebView2-Einstellungen](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings3),
[Preview Handler](https://learn.microsoft.com/en-us/windows/win32/shell/preview-handlers),
[Thumbnail Provider](https://learn.microsoft.com/en-us/windows/win32/shell/thumbnail-providers),
[Explorer-Integration](https://learn.microsoft.com/en-my/WINDOWS/APPS/desktop/modernize/integrate-packaged-app-with-file-explorer),
[Code-Signing](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options),
[DEVMODE](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-devmodew),
[ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw).
Konkurrenz: [Foxit Tabs](https://resource-cms.foxit.com/foxit-pdf-editor-for-windows/multi-tab-reading-single-document-reading),
[VS Code Tabs](https://code.visualstudio.com/docs/editor/tabs),
[Figma Tabs](https://help.figma.com/hc/nl/articles/5601429983767),
[Acrobat Scanner](https://helpx.adobe.com/au/acrobat/kb/troubleshoot-scanner-issues-acrobat.html),
[Acrobat Duplex](https://helpx.adobe.com/acrobat/desktop/print-documents/print-duplex-and-multi-page-document/print-double-side.html),
[Acrobat Watched Folders](https://helpx.adobe.com/acrobat/desktop/create-documents/explore-advanced-conversion-settings/set-watched-folders.html),
[Acrobat Vollbild-Monitor](https://helpx.adobe.com/acrobat/11/using/viewing-pdfs-viewing-preferences.html),
[Okular Präsentation](https://docs.kde.org/stable/en/okular/okular/presentationMode.html),
[Okular Reload](https://bugs.kde.org/show_bug.cgi?id=323393),
[PDF-XChange MSI-Schalter](https://help.pdf-xchange.com/sysadmin/switches-for-msi-installers_edpub.html),
[PDF-XChange Sperre](https://forum.pdf-xchange.com/viewtopic.php?t=29909).
Betrieb: [Flathub-Regeln](https://docs.flathub.org/docs/for-app-authors/requirements),
[CUPS-Optionen](https://www.cups.org/doc/options.html).
Dateisysteme: [notify](https://docs.rs/notify/latest/notify/), [Word-Sperrdatei](https://support.microsoft.com/kb/313472).
