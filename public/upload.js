export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function buildShareText(downloadUrl, password) {
  return `File: ${downloadUrl}\nPassword: ${password}`;
}

// Files at or under this size go through the simple single-PUT flow
// (one request, no chunking) — not worth the extra round trips. Anything
// bigger goes through multipart: a single PUT of several GB over a slow or
// flaky connection has no checkpoint, so one failure near the end throws
// away the entire transfer. Multipart bounds that loss to a single part.
const MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024;
const MAX_PART_ATTEMPTS = 4;
const PART_RETRY_BASE_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Identifies "the same file" across reloads/days well enough to resume:
// name + size + lastModified together are extremely unlikely to collide by
// accident, and the server independently re-verifies against B2 (via
// list-parts) before trusting any of this — this key just finds the right
// local bookkeeping to check.
function resumeStorageKey(file) {
  return `varco-upload:${file.name}:${file.size}:${file.lastModified}`;
}

function loadResumeState(file) {
  try {
    const raw = localStorage.getItem(resumeStorageKey(file));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveResumeState(file, state) {
  try {
    localStorage.setItem(resumeStorageKey(file), JSON.stringify(state));
  } catch {
    // Resumability is a convenience, not a correctness requirement — if
    // storage is full or unavailable, the upload still completes, it just
    // can't be resumed if interrupted.
  }
}

function clearResumeState(file) {
  try {
    localStorage.removeItem(resumeStorageKey(file));
  } catch {
    // Nothing to do — see saveResumeState.
  }
}

async function uploadSimple(file, payload, inviteToken, { onProgress }) {
  // The invite path is /api/guest-upload, kept outside Cloudflare Access
  // entirely so guests never need an Access session — only the owner's
  // /api/upload sits behind Access (see src/routes/upload.ts). It's not
  // /api/upload/invite: an Access "exact" path destination for "api/upload"
  // actually matches as a prefix, so any path nested under /api/upload
  // would get swept in too.
  const query = inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : "";
  const endpoint = inviteToken ? `/api/guest-upload${query}` : "/api/upload";

  const prepareResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!prepareResponse.ok) {
    throw new Error("Impossibile preparare l'upload");
  }
  const { uploadUrl, downloadUrl, password } = await prepareResponse.json();

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(undefined);
      else reject(new Error(`Upload fallito (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload fallito"));
    xhr.send(file);
  });

  return { downloadUrl, password };
}

function uploadPart(url, blob, baseOffset, fileSize, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(baseOffset + event.loaded, fileSize);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const eTag = xhr.getResponseHeader("ETag");
        if (eTag) resolve(eTag);
        else reject(new Error("Risposta senza ETag per la parte caricata"));
      } else {
        reject(new Error(`Parte fallita (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Parte fallita"));
    xhr.send(blob);
  });
}

async function uploadMultipart(file, payload, inviteToken, { onProgress, onStatus }) {
  const query = inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : "";
  const base = inviteToken ? "/api/guest-upload/multipart" : "/api/upload/multipart";

  async function postJson(path, body) {
    const res = await fetch(`${base}${path}${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res;
  }

  let multipartToken;
  let partSize;
  let partCount;
  const completedParts = new Map(); // partNumber -> eTag

  const resumeState = loadResumeState(file);
  if (resumeState) {
    onStatus("Verifica ripresa upload...");
    const listRes = await postJson("/list-parts", { multipartToken: resumeState.multipartToken });
    if (listRes.ok) {
      const info = await listRes.json();
      if (info.filename === file.name && info.size === file.size) {
        multipartToken = resumeState.multipartToken;
        partSize = info.partSize;
        partCount = info.partCount;
        for (const part of info.parts) completedParts.set(part.partNumber, part.eTag);
      }
    }
    if (!multipartToken) clearResumeState(file);
  }

  if (!multipartToken) {
    const initRes = await postJson("/init", payload);
    if (!initRes.ok) throw new Error("Impossibile preparare l'upload");
    const init = await initRes.json();
    multipartToken = init.multipartToken;
    partSize = init.partSize;
    partCount = init.partCount;
    saveResumeState(file, { multipartToken, filename: file.name, size: file.size });
  }

  let bytesDone = 0;
  for (const partNumber of completedParts.keys()) {
    const start = (partNumber - 1) * partSize;
    bytesDone += Math.min(start + partSize, file.size) - start;
  }
  onProgress(bytesDone, file.size);

  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    if (completedParts.has(partNumber)) continue;

    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.size);
    const blob = file.slice(start, end);

    let eTag;
    let lastError;
    for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS && !eTag; attempt++) {
      try {
        onStatus(
          `Caricamento parte ${partNumber} di ${partCount}${attempt > 1 ? ` (tentativo ${attempt})` : ""}...`
        );
        const urlRes = await postJson("/part-url", { multipartToken, partNumber });
        if (!urlRes.ok) throw new Error("Impossibile ottenere l'URL della parte");
        const { url } = await urlRes.json();
        eTag = await uploadPart(url, blob, start, file.size, onProgress);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_PART_ATTEMPTS) await sleep(PART_RETRY_BASE_DELAY_MS * attempt);
      }
    }

    if (!eTag) {
      throw lastError instanceof Error ? lastError : new Error("Upload fallito");
    }

    completedParts.set(partNumber, eTag);
    onProgress(end, file.size);
    saveResumeState(file, { multipartToken, filename: file.name, size: file.size });
  }

  onStatus("Finalizzazione upload...");
  const parts = Array.from(completedParts.entries())
    .map(([partNumber, eTag]) => ({ partNumber, eTag }))
    .sort((a, b) => a.partNumber - b.partNumber);

  const completeRes = await postJson("/complete", { multipartToken, parts });
  if (!completeRes.ok) throw new Error("Impossibile completare l'upload");
  const { downloadUrl, password } = await completeRes.json();

  clearResumeState(file);
  return { downloadUrl, password };
}

function initUploadPage() {
  const dropzone = document.getElementById("dropzone");
  const dzText = document.getElementById("dz-text");
  const fileInput = document.getElementById("file-input");
  const expiresInput = document.getElementById("expires-input");
  const maxDownloadsInput = document.getElementById("max-downloads-input");
  const uploadButton = document.getElementById("upload-button");
  const progressBar = document.getElementById("progress-bar");
  const messageEl = document.getElementById("message");
  const resultPanel = document.getElementById("result-panel");
  const downloadUrlEl = document.getElementById("download-url");
  const passwordEl = document.getElementById("password");
  const copyLinkButton = document.getElementById("copy-link");
  const copyPasswordButton = document.getElementById("copy-password");
  const copyBothButton = document.getElementById("copy-both");

  const inviteToken = new URLSearchParams(window.location.search).get("invite");
  let selectedFile = null;

  function setMessage(text, kind) {
    messageEl.textContent = text;
    messageEl.className = kind ? `message ${kind}` : "message";
  }

  function selectFile(file) {
    selectedFile = file;
    dzText.textContent = `${file.name} (${formatBytes(file.size)})`;
    uploadButton.disabled = false;
  }

  dropzone.addEventListener("click", () => fileInput.click());

  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) selectFile(file);
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) selectFile(file);
  });

  async function copyToClipboard(text) {
    await navigator.clipboard.writeText(text);
  }

  copyLinkButton.addEventListener("click", () => copyToClipboard(downloadUrlEl.textContent ?? ""));
  copyPasswordButton.addEventListener("click", () => copyToClipboard(passwordEl.textContent ?? ""));
  copyBothButton.addEventListener("click", () =>
    copyToClipboard(buildShareText(downloadUrlEl.textContent ?? "", passwordEl.textContent ?? ""))
  );

  uploadButton.addEventListener("click", async () => {
    if (!selectedFile) return;
    uploadButton.disabled = true;
    setMessage("Preparazione upload...", "");
    progressBar.hidden = false;
    progressBar.value = 0;

    const expiresInDays = Number(expiresInput.value || "7");
    const maxDownloadsRaw = maxDownloadsInput.value.trim();
    const payload = {
      filename: selectedFile.name,
      size: selectedFile.size,
      expiresInDays,
      ...(maxDownloadsRaw ? { maxDownloads: Number(maxDownloadsRaw) } : {}),
    };

    const onProgress = (loaded, total) => {
      progressBar.value = total > 0 ? (loaded / total) * 100 : 0;
    };
    const onStatus = (text) => setMessage(text, "");

    try {
      const { downloadUrl, password } =
        selectedFile.size > MULTIPART_THRESHOLD_BYTES
          ? await uploadMultipart(selectedFile, payload, inviteToken, { onProgress, onStatus })
          : await uploadSimple(selectedFile, payload, inviteToken, { onProgress });

      downloadUrlEl.textContent = `${window.location.origin}${downloadUrl}`;
      passwordEl.textContent = password;
      resultPanel.hidden = false;
      setMessage("Upload completato.", "success");
    } catch (error) {
      const isMultipart = selectedFile.size > MULTIPART_THRESHOLD_BYTES;
      const baseMessage = error instanceof Error ? error.message : "Errore imprevisto";
      setMessage(
        isMultipart ? `${baseMessage} — riprova, riprenderà da dove si è interrotto.` : baseMessage,
        "error"
      );
    } finally {
      uploadButton.disabled = false;
      progressBar.hidden = true;
    }
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initUploadPage);
}
