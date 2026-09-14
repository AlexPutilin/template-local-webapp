# Local Web App Framework – Task Scheduler

## Status und Zweck

**Architekturentwurf – noch nicht implementiert.** Die folgenden Dateinamen, Methoden und Codebeispiele beschreiben die vorgeschlagene Erweiterung zur bestehenden [architecture.md](./architecture.md).

Der Task Scheduler führt projektbezogene JavaScript-Funktionen beim App-Start, zu festgelegten Terminen oder in Intervallen aus. Er läuft innerhalb des bestehenden Node-Prozesses. Konfiguration und letzte Ausführungsdaten bleiben nach einem Neustart erhalten.

Die Engine heißt **TaskScheduler**, ihre Instanz `scheduler`. Ein **Task** verbindet eine stabile ID mit einer Funktion und einem **Schedule**. Eine einzelne Ausführung heißt **Run** und kennt ihren Auslöser: `startup`, `scheduled` oder `manual`.

---

## 1. Vorgeschlagene Projektstruktur

```text
project/
├─ data/
│  └─ scheduler.json             → automatisch gespeicherte Konfiguration und Zustände
├─ docs/
│  ├─ architecture.md
│  └─ task-scheduler.md
├─ app.config.json
├─ package.json
│
└─ src/
   ├─ app.js                    → Komponenten erstellen, verbinden und starten
   │
   ├─ framework/
   │  ├─ http/                  → bestehendes HTTP-Modul
   │  ├─ scheduler/
   │  │  ├─ scheduler.js        → Factory und TaskScheduler-Klasse
   │  │  ├─ schedule.js         → Zeitpläne prüfen und nächste Termine berechnen
   │  │  └─ store.js            → Konfiguration und Zustände laden und speichern
   │  └─ utils/
   │     └─ path.js             → vorhandenes dataPath() verwenden
   │
   ├─ application/
   │  ├─ tasks/
   │  │  ├─ tasks.js            → zentrale Registrierung der Projektaufgaben
   │  │  └─ heartbeat.js        → einfacher Beispiel-Task
   │  ├─ routes/
   │  │  ├─ pages.js
   │  │  └─ tasks.js            → später: HTTP-Endpunkte für die Verwaltung
   │  ├─ services/              → wiederverwendbare Fachlogik
   │  └─ repositories/          → projektspezifischer Datenzugriff
   │
   └─ web/                      → später: optionale Verwaltungsoberfläche
```

Der Baum zeigt das Zielbild. Die Erweiterung benötigt zunächst die drei Scheduler-Dateien und die Aufgabenregistrierung. Verwaltungsrouten und UI folgen bei Bedarf.

---

## 2. Verantwortlichkeiten

| Datei / Bereich | Verantwortung |
| --- | --- |
| `framework/scheduler/scheduler.js` | Exportiert `createTaskScheduler()` und die Klasse `TaskScheduler`. Verwaltet Tasks in einer internen Map, Timer, Ausführungen, Status und öffentliche Methoden. |
| `framework/scheduler/schedule.js` | Validiert Zeitpläne und berechnet Termine. Kennt keine Projektfunktionen und schreibt keine Dateien. |
| `framework/scheduler/store.js` | Lädt und speichert eine versionierte JSON-Struktur. Führt Schreibvorgänge nacheinander aus und ersetzt die Speicherdatei über eine temporäre Datei. |
| `application/tasks/tasks.js` | Registriert Task-IDs, Namen, Funktionen und deren Erstkonfiguration. Entspricht der zentralen Routenregistrierung. |
| `application/tasks/heartbeat.js` | Enthält die auszuführende Funktion. Fachliche Tasks können Services verwenden; sie benötigen keinen `HttpResponse`. |
| `app.js` | Erstellt genau eine Scheduler-Instanz für die App, übergibt den Speicherpfad, verbindet optionale Routen und steuert Start und Shutdown. |
| Spätere Verwaltungsrouten | Erhalten dieselbe Scheduler-Instanz, prüfen HTTP-Eingaben, rufen öffentliche Methoden auf und liefern einen `HttpResponse`. |

`application/tasks/` ist eine empfohlene Konvention. Bei sehr kleinen Projekten darf die Registrierung direkt im Factory-Callback in `app.js` stehen. Fachlogik bleibt in eigenen Funktionen beziehungsweise Services.

---

## 3. Registrierung und dauerhafte Speicherung

Jeder Task besteht aus drei Bereichen:

| Bereich | Inhalt | Speicherort |
| --- | --- | --- |
| Definition | ID, Name, Beschreibung, JS-Funktion | Anwendungscode; zur Laufzeit in der Map |
| Konfiguration | Aktivierung, Initialstart, Zeitplan | Erstwerte im Code; wirksame Einstellungen in `data/scheduler.json` |
| Zustand | Letzter Start, Abschluss, Erfolg und Fehler; aktueller Run; nächster Termin und Fortschritt des Zeitplans, etwa ein bereits verbrauchter Einmaltermin | `data/scheduler.json`; zusätzlich im Arbeitsspeicher |

Die Map ist nach Task-ID organisiert. Funktionsreferenzen und Timer werden nicht serialisiert. Zeitstempel für Ausführungen werden als UTC-Zeitpunkte gespeichert; Kalenderpläne enthalten ihre Zeitzone.

Beim Start:

```text
1. Funktionen und Erstkonfiguration registrieren; dabei noch nichts ausführen.
2. Gespeicherte Konfiguration und Zustände laden und validieren.
3. Über stabile Task-IDs zuordnen; gespeicherte Einstellungen haben Vorrang.
4. Unvollständig abgeschlossene Ausführungen als unterbrochen / Ergebnis unbekannt markieren.
5. Nächste Termine anhand der aktuellen Zeit und des gespeicherten Zustands prüfen.
6. Planung aktivieren und erlaubte Initialstarts auslösen.
```

Neue Task-IDs erhalten die Erstwerte aus dem Code. Gespeicherte IDs ohne registrierte Funktion werden nicht ausgeführt.

Konfigurationsänderungen werden geprüft und gespeichert, bevor die neue Planung aktiviert und der UI Erfolg bestätigt wird. Auch Start und Abschluss einer Ausführung werden gespeichert. Der letzte erfolgreiche Lauf bleibt bei einem späteren Fehler erhalten.

Eine fehlende Speicherdatei wird angelegt. Eine beschädigte Datei darf nicht stillschweigend durch Standardwerte ersetzt werden. Speicherfehler müssen sichtbar gemeldet werden. Die erste Version speichert die letzten Werte pro Task; ein vollständiges Run-Protokoll folgt bei Bedarf.

---

## 4. Zeitpläne und Ausführungsregeln

| Zeitplan | Vorgeschlagene Angaben | Bedeutung |
| --- | --- | --- |
| `once` | `at`: Datum und Uhrzeit mit Offset oder UTC | Einmal zu einem Zeitpunkt |
| `delay` | `delayMs` | Einmal nach einer Verzögerung; der Zieltermin bleibt gespeichert |
| `interval` | `intervalMs`, `mode: 'fixedDelay'` | Nach dem Abschluss jeweils die angegebene Pause warten |
| `interval` | `intervalMs`, `mode: 'fixedRate'` | Wiederkehrende Termine in festem Takt |
| `daily` | `time`, `timeZone` | Täglich zur lokalen Kalenderzeit |
| `weekly` | `weekdays`, `time`, `timeZone` | An ausgewählten Wochentagen zur lokalen Kalenderzeit |

Kalenderbeispiel: `time: '06:00'`, `timeZone: 'Europe/Berlin'`; Wochentage: `mon` bis `sun`. Kalendertermine berücksichtigen die Zeitzone. Vorgeschlagene Sommerzeitregel: nicht existierende Uhrzeiten überspringen, doppelte Uhrzeiten nur einmal ausführen.

**Initialstart:** `runOnStart` führt einen aktiven Task einmal pro App-Lauf zusätzlich aus. Kalendertermine bleiben erhalten; bei `fixedDelay` beginnt die Pause nach dem Initiallauf. Auch bei Einmalplänen ist dies ein zusätzlicher Lauf. Wiederholtes `start()` oder späteres Aktivieren erzeugt keinen weiteren Initialstart.

**Ausführung:** Derselbe Task läuft höchstens einmal gleichzeitig. Überschneidende Termine werden übersprungen, manuelle Doppelstarts abgelehnt. Alle Auslöser verwenden dieselbe Ausführungs- und Speicherlogik. Task-Fehler werden gespeichert; wiederkehrende Zeitpläne bleiben bestehen.

**Neustart:** Historie und Konfiguration bleiben erhalten. Bereits verbrauchte Einmaltermine werden nicht erneut automatisch ausgeführt. Für verpasste Termine wird zunächst Überspringen vorgeschlagen; Initialstarts sind davon unabhängig. Nachholen und die genaue Verspätungstoleranz bleiben abzustimmen.

---

## 5. Fiktiver Quick-Start

Die folgende API ist ein Vorschlag und im Template noch nicht verfügbar. Die Beispiele gehören jeweils in die bezeichnete Datei.

### Schritt 1 – Task-Funktion anlegen

`src/application/tasks/heartbeat.js`:

```js
export default async function heartbeat() {
    console.log('Application heartbeat:', new Date().toISOString());
}
```

Der Task schreibt eine Meldung; später könnte er einen Dashboard-Service aufrufen. Die Funktion muss ihre gesamte Arbeit abwarten, damit der Scheduler den Abschluss erkennen kann.

### Schritt 2 – Task registrieren

`src/application/tasks/tasks.js`:

```js
import heartbeat from './heartbeat.js';

export default function registerTasks(scheduler) {
    scheduler.register({
        id: 'app-heartbeat',
        name: 'Application heartbeat',
        description: 'Logs a regular application heartbeat.',
        handler: heartbeat,
        config: {
            enabled: true,
            runOnStart: true,
            schedule: {
                type: 'interval',
                mode: 'fixedDelay',
                intervalMs: 60_000
            }
        }
    });
}
```

Bei der ersten Verwendung läuft der Task beim Scheduler-Start und danach jeweils 60 Sekunden nach seinem Abschluss. Spätere gespeicherte Änderungen überschreiben diese Erstkonfiguration.

### Schritt 3 – In `app.js` einbinden

`src/app.js`:

```js
import { once } from 'node:events';
import config from '../app.config.json' with { type: 'json' };
import createHttpServer from '#framework/http/http.js';
import createTaskScheduler from '#framework/scheduler/scheduler.js';
import { dataPath } from '#framework/utils/path.js';
import pageRoutes from '#application/routes/pages.js';
import registerTasks from '#application/tasks/tasks.js';

const scheduler = createTaskScheduler(registerTasks, {
    storagePath: dataPath('scheduler.json')
});

const httpServer = createHttpServer(router => {
    router.register('/', pageRoutes);
});

httpServer.on('error', error => {
    console.error('HTTP server failed:', error);
});

// Erst den HTTP-Start bestätigen, dann geplante Aufgaben aktivieren.
httpServer.listen(config.http.port, config.http.host);
await once(httpServer, 'listening');

try {
    await scheduler.start();
} catch (error) {
    httpServer.close();
    throw error;
}
```

Die Factory erstellt und registriert; erst `start()` lädt den Speicher und aktiviert die Ausführung. Das Promise bestätigt die Betriebsbereitschaft, ohne auf den Abschluss der Initialaufgaben zu warten. Ein fehlgeschlagener Start hinterlässt keine aktive Planung.

Das Beispiel zeigt den Startablauf. Eine gemeinsame Shutdown-Behandlung ergänzt später `await scheduler.stop()` und das Schließen des HTTP-Servers. Laufende Arbeit erhält eine begrenzte Wartezeit. `stop()` speichert den Zustand und verhindert neue Starts, ohne Tasks dauerhaft zu deaktivieren.

### Task-Workflow

```text
1. Eine async Funktion unter application/tasks/ anlegen.
2. Bei Bedarf Fachlogik aus einem Service aufrufen.
3. Stabile ID, Name und Erstkonfiguration in tasks.js registrieren.
4. Die zentrale Registrierung einmal in app.js einbinden.
5. App starten; Konfiguration und Ausführungsdaten werden automatisch gespeichert.
```

---

## 6. Vorbereitung für API und UI

Der Scheduler bietet eine öffentliche Schnittstelle. HTTP und Browsercode bleiben außerhalb des Framework-Moduls.

| Vorgeschlagene Methode | Verhalten |
| --- | --- |
| `register(definition)` | Registriert eine bekannte JS-Funktion vor dem Start; doppelte IDs sind Fehler. |
| `list()` / `get(id)` | Liefert JSON-kompatible Momentaufnahmen mit Name, Konfiguration und Status; ohne Funktionen oder Timer. |
| `runNow(id)` | Führt einen Task manuell aus und speichert den Run. Auch bei deaktivierter Automatik möglich, solange der Scheduler gestartet ist. |
| `updateConfig(id, changes)` | Prüft, speichert und übernimmt Einstellungen eines bestehenden Tasks; berechnet den nächsten Termin neu. |
| `enable(id)` / `disable(id)` | Speichert die Aktivierung beziehungsweise Deaktivierung automatischer Ausführungen. |
| `start()` / `stop()` | Steuert den Lebenszyklus der gesamten Engine. |

Änderungen und manuelle Ausführungen sind asynchron. Ein neuer Zeitplan verändert keine laufende Funktion. Aktivierung und Ausführungszustand bleiben getrennt: Deaktivieren verhindert automatische Starts, bricht aber laufende Arbeit nicht ab. Ein manueller Lauf verschiebt keine Kalendertermine.

Verwaltungsrouten erhalten dieselbe Instanz aus `app.js`; der Scheduler übernimmt die Speicherung. Die UI kann bekannte Tasks lesen, starten und konfigurieren. Neue Funktionen werden weiterhin im Code registriert. Ein Abbruch laufender Funktionen benötigt später einen kooperativen Abbruchmechanismus.

---

## Architecture Rules

- `framework/` enthält ausschließlich die allgemeine Scheduler-Technik.
- `application/tasks/` enthält Projektaufgaben und deren explizite Registrierung.
- Fachlogik bleibt unabhängig von HTTP und kann von Routen und Tasks gemeinsam verwendet werden.
- `app.js` bleibt der Ort zum Erstellen, Verbinden, Starten und Beenden der Komponenten.
- Konfiguration und letzte Ausführungsdaten werden bereits in der ersten Version dauerhaft gespeichert.
- Änderungen laufen über Scheduler-Methoden; die UI verändert weder Map noch Speicherdatei direkt.
- Die Speicherdatei hat genau einen schreibenden Scheduler im Node-Prozess.
- API-Endpunkte, UI, vollständige Run-Historie und Nachholstrategien sind spätere Erweiterungen.

Vor der Implementierung bleiben die konkrete Kalenderberechnung beziehungsweise Bibliothekswahl und die Verspätungstoleranz festzulegen. Die Modulgrenzen und der Quick-Start sind davon unabhängig.
