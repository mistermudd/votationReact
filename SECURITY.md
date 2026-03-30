# Security Policy

## Versioni supportate

| Versione | Supportata |
|---|---|
| `main` (ultima) | ✅ |
| Versioni precedenti | ❌ |

Si raccomanda sempre di usare l'ultima versione del branch `main`.

## Segnalare una vulnerabilità

Se scopri una vulnerabilità di sicurezza, apri una **GitHub Security Advisory** privata:

1. Vai su `https://github.com/mistermudd/votationReact/security/advisories/new`
2. Descrivi la vulnerabilità, i passi per riprodurla e l'impatto potenziale
3. Non pubblicare dettagli in Issue pubbliche finché non è stata risolta

Riceverai una risposta entro 72 ore.

## Buone pratiche per il deploy

- **Cambia sempre** le credenziali di default (`ADMIN_PIN`, `GESTIONE_PIN`, `REGIA_PIN`) prima di esporre il sistema pubblicamente
- Usa variabili d'ambiente su Render (mai committare credenziali nel repository)
- Il cookie `auth_token` è `HttpOnly`: non è accessibile da JavaScript lato client
- Il database SQLite usa **WAL mode** per garantire integrità delle scritture
- Configura `GITHUB_BACKUP_TOKEN` e `GITHUB_BACKUP_GIST_ID` per il backup automatico
- L'endpoint `/api/admin/db-backup` è protetto dal ruolo `admin`

