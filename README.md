# Varco

Servizio privato di file transfer, self-hosted su un singolo Cloudflare Worker e Backblaze B2. Upload via presigned PUT direttamente su B2 (il file non passa mai dal Worker), download in streaming pass-through (mai un redirect, mai un buffer in memoria).

## Come partire

Tre percorsi, dal più automatico al più manuale. In tutti e tre restano comunque fuori: creare bucket e Application Key su B2 (punti 1-2 sotto — provider diverso da Cloudflare, nessun ponte automatico) e configurare Cloudflare Access (punto 6 — dashboard Zero Trust, non esposto né da wrangler né dal bottone di deploy).

### Opzione A — Deploy in un click, zero clone locale

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<TUO-USER>/<TUO-REPO>)

*(Sostituisci `<TUO-USER>/<TUO-REPO>` con il percorso reale della tua repo GitHub una volta pubblicata.)*

Cliccando il bottone:
1. Cloudflare ti chiede di autenticarti (o creare un account) e di **collegare/forkare questa repo** nel tuo account GitHub — è così che Cloudflare Workers Builds si aggancia per i deploy automatici sui push futuri.
2. Ti mostra i valori non sensibili già presenti in `wrangler.toml` sotto `[vars]` (`B2_BUCKET`, `B2_ENDPOINT`, `B2_REGION`) come campi modificabili prima del deploy — compilali con i valori del tuo bucket B2 (punto 1 sotto).
3. Dovrebbe proporti la creazione del KV namespace dichiarato in `[[kv_namespaces]]` come parte del flusso guidato. Se non lo fa, crealo tu (`npx wrangler kv namespace create FILES_KV` da locale, oppure via `./setup.sh`, oppure a mano dal dashboard) e incolla l'id in `wrangler.toml` prima di rilanciare il deploy.
4. Esegue il deploy.

**Dopo il deploy**, aggiungi i due valori sensibili — impossibile farlo dentro il flusso del bottone, perché i secret non vivono mai in `wrangler.toml`: vai su dashboard Cloudflare → Workers & Pages → il tuo worker → **Settings → Variables and Secrets → Add variable**, tipo **Encrypted**, per `B2_KEY_ID` e `B2_APP_KEY`. Poi configura Cloudflare Access (punto 6). Zero terminale in tutto questo percorso.

### Opzione B — `setup.sh`, bootstrap locale guidato

Dopo aver creato bucket e Application Key B2 (punti 1-2, non automatizzabili da qui), clona la repo ed esegui `./setup.sh` — installa/verifica wrangler, gestisce il login Cloudflare, crea il KV namespace, chiede i valori B2 e scrive `wrangler.toml`/`.dev.vars`, e offre di impostare i secret e fare il deploy. Copre i punti 3-5 e 7 qui sotto. Restano manuali solo i punti 1, 2 e 6.

### Opzione C — passo-passo manuale

La sezione seguente descrive ogni passo a mano, per chi preferisce non usare né il bottone né lo script, o deve capire cosa fanno.

### 1. Bucket Backblaze B2

1. Nel [pannello B2](https://secure.backblaze.com/b2_buckets.htm), crea un bucket **privato** (`allPrivate`).
2. Nelle impostazioni del bucket, attiva **Default Encryption → SSE-B2**.
3. Aggiungi una **Lifecycle Rule** come rete di sicurezza (il cron del Worker cancella già gli oggetti orfani, questa regola è un backstop):
   - "Keep only the last version of the file" con **"days after uploading"** impostato a qualche giorno oltre alla scadenza massima che offri (es. se offri fino a 30 giorni di scadenza, imposta la lifecycle rule a 35-40 giorni), così un oggetto che sfugge al cron viene comunque rimosso da B2 stessa.
4. Annota l'**endpoint S3** del bucket (es. `https://s3.us-west-004.backblazeb2.com`) e la **region** (es. `us-west-004`) — visibili nella pagina dei dettagli del bucket.

### 2. Application Key B2 (S3-compatible)

1. Vai su **App Keys** nel pannello B2.
2. Crea una nuova Application Key limitata al **singolo bucket** di Varco, con permessi di lettura/scrittura/eliminazione sugli oggetti. **Non usare la master key.**
3. Annota `keyID` e `applicationKey`: sono rispettivamente `B2_KEY_ID` e `B2_APP_KEY`.

### 3. KV Namespace

```bash
npx wrangler kv namespace create FILES_KV
```

Copia l'`id` restituito in `wrangler.toml`, sotto `[[kv_namespaces]]`.

### 4. Variabili locali

```bash
cp .dev.vars.example .dev.vars
```

Compila `.dev.vars` con i valori di B2 (chiave, bucket, endpoint, region). Questo file è in `.gitignore` e non va mai committato.

### 5. Secrets in produzione

`B2_BUCKET`, `B2_ENDPOINT`, `B2_REGION` sono già in `wrangler.toml` sotto `[vars]` (non sensibili). `B2_KEY_ID` e `B2_APP_KEY` sono segreti e vanno impostati con:

```bash
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APP_KEY
```

### 6. Cloudflare Access (Zero Trust)

Nel dashboard Cloudflare Zero Trust → Access → Applications, crea due applicazioni **self-hosted** puntate al dominio del Worker:

- **Applicazione 1** — path `/admin*`. Policy: solo il tuo account (email o gruppo). Protegge la pagina di generazione inviti.
- **Applicazione 2** — path `/api/invite`. Stessa policy della precedente (Access valuta i path indipendentemente dagli asset statici: assicurati che la policy copra sia `/admin` sia `/admin.html`, dato che quest'ultimo è servito come asset statico).

Per gli **utenti fissi** che possono caricare file (`/api/upload` senza invito), crea una terza applicazione Access sul path `/api/upload` con una policy che include la whitelist di email fidate. Cloudflare Access inietta l'header `Cf-Access-Authenticated-User-Email` dopo un login riuscito: il Worker si fida della sua sola presenza, l'autenticazione vera è già avvenuta a monte.

Non serve proteggere `/`, `/d/:token`, `/download.html` — sono pubblici per design (l'autenticazione lì è la password per-file).

### 7. Deploy

```bash
npm install
npm run deploy
```

## Sviluppo locale

```bash
npm run dev
```

Nota: Cloudflare Access non è simulabile localmente in modo nativo — durante lo sviluppo locale l'header `Cf-Access-Authenticated-User-Email` va impostato manualmente (es. con un'estensione browser o `curl -H`) per testare i percorsi da "utente fisso".

## Test

```bash
npm test
```

## Come funziona (in breve)

- **Upload**: il Worker genera un URL S3 v4 presigned per una singola `PUT` su B2 (fino a 5GB, niente multipart) e lo restituisce al browser, che carica il file direttamente su B2 via `XMLHttpRequest`.
- **Download**: il Worker fa `fetch()` verso B2 e inoltra `response.body` come stream al client, senza mai bufferizzare l'intero file in memoria.
- **Password**: generate dal Worker (12 caratteri, alfabeto ad alta entropia), mai scelte dall'utente. Salvate solo come `SHA-256(salt + password)` — un singolo hash veloce è sufficiente perché l'entropia della password (~64 bit) rende il brute force infeasibile a prescindere, ed evita di sforare il budget di CPU del piano free.
- **Pulizia**: KV elimina da sé i metadata scaduti (TTL nativo); un cron giornaliero confronta gli oggetti su B2 con i record KV ancora vivi e cancella quelli orfani. La lifecycle rule di B2 (punto 1) è il backstop nel caso il cron fallisca.

## Budget CPU

Ogni handler è pensato per restare ben sotto i 10ms di CPU del piano Workers Free: nessuna libreria pesante, nessun parsing di payload grandi, hash singolo SHA-256 invece di funzioni lente come bcrypt/PBKDF2/scrypt.
