# 🎤 Votation Live

Sistema di votazione in tempo reale per eventi dal vivo (spettacoli, talent show, gare canore). Giudici, pubblico e regia operano da dispositivi separati con aggiornamenti istantanei via WebSocket.

---

## Indice

- [Funzionalità](#funzionalità)
- [Architettura](#architettura)
- [Pagine](#pagine)
- [Installazione locale](#installazione-locale)
- [Variabili d'ambiente](#variabili-dambiente)
- [Comandi npm](#comandi-npm)
- [API REST](#api-rest)
- [Deploy su Render (gratuito)](#deploy-su-render-gratuito)
- [Configurazione Backup Gist](#configurazione-backup-gist)
- [Cookie Policy](#cookie-policy)
- [Licenza](#licenza)

---

## Funzionalità

- ✅ Votazione 1–10 per giudici e pubblico in tempo reale
- ✅ Scaletta artisti con ordine personalizzabile
- ✅ Tre classifiche: giudici, pubblico, ponderata (pesi configurabili)
- ✅ Ballottaggio tra due artisti
- ✅ Controllo accessi per ruolo (Admin / Regia / Giudice)
- ✅ Backup automatico su GitHub Gist + ripristino al boot
- ✅ Graceful shutdown per deploy senza perdita dati
- ✅ Interfaccia responsive con animazioni CSS

---

## Architettura

```
Node.js + Express 5
├── Socket.IO 4  →  aggiornamenti real-time
├── better-sqlite3  →  database SQLite (WAL mode)
└── public/  →  frontend statico HTML/CSS/JS vanilla
```

**Tabelle DB:**
| Tabella | Contenuto |
|---|---|
| `lineup` | Artisti in scaletta |
| `sessions` | Sessioni di voto per esibizione |
| `votes` | Voti giudici e pubblico |
| `runoff_sessions` | Sessioni ballottaggio |
| `runoff_votes` | Voti ballottaggio |

---

## Pagine

| URL | Ruolo richiesto | Descrizione |
|---|---|---|
| `/login.html` | — | Login con ruolo e PIN |
| `/public.html` | — | Voto pubblico (no login) |
| `/judge.html` | Giudice | Voto giudice |
| `/director.html` | Regia / Admin | Stato live e controllo votazione |
| `/lineup.html` | Regia / Admin | Gestione scaletta artisti |
| `/report.html` | Regia / Admin | Classifiche con pesi configurabili |
| `/performance.html` | Admin | Avanza/pausa/termina esibizioni |
| `/runoff-manage.html` | Regia / Admin | Gestione ballottaggio |
| `/runoff-judge.html` | Giudice | Voto ballottaggio giudice |
| `/runoff-public.html` | — | Voto ballottaggio pubblico |
| `/index.html` | Tutti | Menu principale post-login |

---

## Installazione locale

### Prerequisiti
- Node.js ≥ 18
- npm ≥ 9

### Passaggi

```bash
# 1. Clona il repository
git clone https://github.com/mistermudd/votationReact.git
cd votationReact

# 2. Installa le dipendenze
npm install

# 3. (Opzionale) Crea .env con le credenziali
cp .env.example .env   # vedi sezione Variabili d'ambiente

# 4. Avvia in modalità sviluppo (hot reload)
npm run dev

# 5. Oppure avvia in produzione
npm start
```

Apri `http://localhost:3000` nel browser.

---

## Variabili d'ambiente

Crea un file `.env` nella root del progetto (non committarlo mai):

```env
# Credenziali ruoli (default se non specificati)
ADMIN_USER=admin
ADMIN_PIN=1234

GESTIONE_USER=regia
GESTIONE_PIN=5678

REGIA_USER=giudice
REGIA_PIN=2468

# Percorso database SQLite
# Default: ./votation.db nella root del progetto
DB_PATH=/var/data/votation.db

# Porta HTTP (default: 3000)
PORT=3000

# Backup automatico su GitHub Gist (opzionale ma consigliato)
GITHUB_BACKUP_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
GITHUB_BACKUP_GIST_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> ⚠️ **Sicurezza**: cambia sempre le credenziali di default prima di un deploy pubblico.

---

## Comandi npm

| Comando | Descrizione |
|---|---|
| `npm start` | Avvia il server in produzione |
| `npm run dev` | Avvia con hot reload (`--watch`) |

---

## API REST

### Autenticazione
Tutte le API protette utilizzano il cookie di sessione `auth_token` oppure HTTP Basic Auth.

### Stato e votazione

| Metodo | Path | Ruolo | Descrizione |
|---|---|---|---|
| `GET` | `/api/state` | Tutti | Stato corrente esibizione |
| `POST` | `/api/vote` | Tutti | Invia voto `{role, voterName, score}` |
| `GET` | `/api/public/vote-status` | — | Controlla se il dispositivo ha già votato |

### Scaletta

| Metodo | Path | Ruolo | Descrizione |
|---|---|---|---|
| `GET` | `/api/lineup` | Regia / Admin | Elenco artisti |
| `POST` | `/api/lineup` | Regia / Admin | Aggiungi artista `{artistName, songTitle, performanceOrder}` |
| `PUT` | `/api/lineup/:id` | Regia / Admin | Modifica artista |
| `DELETE` | `/api/lineup/:id` | Regia / Admin | Elimina artista |
| `POST` | `/api/lineup/activate` | Regia / Admin | Attiva esibizione `{lineupId}` |

### Controllo esibizione (solo Admin)

| Metodo | Path | Descrizione |
|---|---|---|
| `POST` | `/api/performance/start` | Avvia votazione |
| `POST` | `/api/performance/pause` | Mette in pausa |
| `POST` | `/api/performance/resume` | Riprende |
| `POST` | `/api/performance/next` | Passa all'artista successivo |
| `POST` | `/api/performance/terminate` | Termina esibizione corrente |
| `POST` | `/api/close-voting` | Chiude la votazione |

### Ballottaggio

| Metodo | Path | Ruolo | Descrizione |
|---|---|---|---|
| `GET` | `/api/runoff/state` | Tutti | Stato ballottaggio corrente |
| `GET` | `/api/runoff/vote-status` | Tutti | Controlla se ha già votato |
| `POST` | `/api/runoff/start` | Regia / Admin | Avvia ballottaggio `{firstLineupId, secondLineupId}` |
| `POST` | `/api/runoff/close` | Regia / Admin | Chiude ballottaggio |
| `POST` | `/api/runoff/vote` | Tutti | Vota ballottaggio `{role, voterName, selectedLineupId}` |

### Report

| Metodo | Path | Ruolo | Descrizione |
|---|---|---|---|
| `GET` | `/api/report` | Regia / Admin | Classifiche `?judgeWeight=50&publicWeight=50` |

### Admin

| Metodo | Path | Descrizione |
|---|---|---|
| `GET` | `/api/admin/db-backup` | Scarica file `.db` SQLite |
| `POST` | `/api/admin/backup-now` | Forza backup su GitHub Gist |
| `POST` | `/api/admin/clear-votes` | Cancella tutti i voti |
| `GET` | `/healthz` | Healthcheck (restituisce `{ok:true}`) |

### Auth

| Metodo | Path | Descrizione |
|---|---|---|
| `POST` | `/api/auth/login` | Login `{username, pin}` |
| `POST` | `/api/auth/logout` | Logout |
| `GET` | `/api/auth/me` | Ruolo corrente |

---

## Deploy su Render (gratuito)

Il file `render.yaml` è già configurato.

### Passi

1. Crea un account su [render.com](https://render.com)
2. Collega il repository GitHub `mistermudd/votationReact`
3. Render rileva automaticamente `render.yaml` e crea il servizio
4. Nella dashboard del servizio → **Environment** → aggiungi le variabili:

```
ADMIN_USER        = <scegli>
ADMIN_PIN         = <scegli>
GESTIONE_USER     = <scegli>
GESTIONE_PIN      = <scegli>
REGIA_USER        = <scegli>
REGIA_PIN         = <scegli>
GITHUB_BACKUP_TOKEN   = <vedi sezione backup>
GITHUB_BACKUP_GIST_ID = <vedi sezione backup>
```

5. Il deploy parte automaticamente ad ogni `git push origin main`

> **Piano Free**: il servizio va in sleep dopo 15 minuti di inattività. Il disco **non** è disponibile sul piano free — configura il **Backup Gist** per non perdere i dati.

---

## Configurazione Backup Gist

Sistema di backup automatico su GitHub Gist (gratuito) per proteggere i dati anche sul piano Free di Render.

### Quando scatta il backup
- Ogni **10 minuti** automaticamente
- Al **SIGTERM** (Render spegne il container prima del redeploy o dopo inattività)
- Manualmente via `POST /api/admin/backup-now`

### Al riavvio
Se il DB è vuoto (nuovo container), i dati vengono **ripristinati automaticamente** dal Gist.

### Setup (una volta sola)

#### 1. Crea un GitHub Gist segreto
- Vai su [gist.github.com](https://gist.github.com)
- Crea un nuovo **Secret Gist**
- Nome file: `votation-backup.json`, contenuto iniziale: `{}`
- Copia l'ID dall'URL: `https://gist.github.com/<utente>/<ID>`

#### 2. Crea un Personal Access Token
- GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
- Scope: solo ✅ **gist**
- Copia il token (`ghp_...`)

#### 3. Aggiungi su Render
```
GITHUB_BACKUP_TOKEN   = ghp_xxxxxxxxxxxxxxxxxxxx
GITHUB_BACKUP_GIST_ID = xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Cookie Policy

Vedi [/cookie-policy.html](/cookie-policy.html) per la policy completa.

In sintesi, questo sistema usa:
- **`auth_token`** (cookie di sessione, HttpOnly) — per autenticare i ruoli Regia / Giudice / Admin. Scade con la sessione del browser.
- **`public-voter-device-id`** (localStorage) — identificativo anonimo del dispositivo usato dal pubblico per evitare voti doppi. Non contiene dati personali.
- **`judge-voted-per-lineup`** e **`judge-saved-name`** (localStorage) — memorizzano localmente lo stato di voto del giudice. Non vengono mai inviati a server terzi.

Nessun cookie di profilazione, advertising o tracciamento viene utilizzato.

---

## Licenza

Distribuito sotto licenza **MIT**. Vedi [LICENSE](LICENSE) per i dettagli.
