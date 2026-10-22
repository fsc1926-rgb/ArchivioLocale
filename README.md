# 🛡️🗂️ PersonalOS — Archivio Personale & SecureVault (PWA 100% Offline)

Applicazione **Progressive Web App (PWA)** unificata e **100% Offline**, nata dalla fusione e dal potenziamento architetturale di **Archivio Personale OS** e **SecureVault Password Manager**.

---

## ✨ Caratteristiche Principali

1. **📊 Dashboard Globale Unificata**
   - Statistiche in tempo reale su Faldoni, Articoli in Inventario, Valore Stimato (€), Garanzie Attive, Prestiti in corso e stato della Cassaforte Password.
   - Alert immediati per **prestiti in ritardo** e **garanzie in scadenza**.

2. **📦 Faldoni & Unità d'Archivio**
   - Gestione completa (Creazione, Modifica, Eliminazione, Ricerca) di scatole, faldoni, armadi e cassetti.
   - **Stampa Etichetta Fisica** ottimizzata per la stampa, comprensiva degli oggetti e degli scontrini collegati.

3. **📋 Inventario Oggetti & Documenti**
   - Catalogazione dettagliata collegata ai Faldoni fisici (Quantità, Condizione, Valore in €, Categoria, Seriale/Note).
   - **Acquisizione Foto con Doppia Modalità**: compressione a colori per gli oggetti oppure **Scanner B/N ad alto contrasto** per i documenti cartacei.

4. **🧾 Garanzie & Scontrini**
   - Calcolo automatico della data di scadenza della garanzia.
   - **Scanner Termico B/N anti-sbiadimento** per conservare gli scontrini in locale.
   - Esportazione promemoria **`.ICS`** compatibile con Google Calendar, Apple Calendar e Outlook.

5. **🤝 Registro Prestiti**
   - Tracciamento di oggetti e documenti prestati con stato di restituzione, avvisi di scadenza e promemoria calendario `.ICS`.

6. **🔐 SecureVault — Password Manager Cifrato**
   - **Crittografia Web Crypto API nativa**: derivazione chiave `PBKDF2` (100.000 iterazioni SHA-256) + cifratura autenticata `AES-256-GCM` con `Salt` e `IV` crittograficamente casuali.
   - **Auto-Lock per inattività** configurabile (5 / 15 / 30 minuti) e pulsante di blocco immediato.
   - **Generatore di Password Crittografico** + **Audit di Sicurezza** automatico (rileva password deboli o riutilizzate).
   - **Importazione ed Esportazione CSV** (standard RFC-4180 compatibile con Google Password Manager, Chrome, Bitwarden).

7. **🔍 Omnisearch & Centro Backup Totale Unificato**
   - Ricerca istantanea trasversale su tutti i moduli.
   - **Backup JSON Unificato**: salva in un solo file l'intero Archivio Personale e il payload cifrato AES-GCM del Vault.
   - **Migrazione Automatica**: recupera automaticamente eventuali dati salvati nel browser dalle versioni precedenti delle due app.

---

## 🚀 Come pubblicare su GitHub Pages

1. Crea una nuova repository su GitHub (es. `personal-os-pwa`).
2. Carica tutti i file contenuti in questo archivio nella radice (`root`) della repository.
3. Vai in **Settings → Pages** della repository.
4. Sotto **Build and deployment**, seleziona **Deploy from a branch** → branch `main` → cartella `/ (root)` e clicca **Save**.
5. Dopo circa 60 secondi la tua PWA sarà online e installabile su Android, iOS, Windows, macOS e Linux!
