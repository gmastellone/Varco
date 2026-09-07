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

    try {
      const query = inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : "";
      const prepareResponse = await fetch(`/api/upload${query}`, {
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
          if (event.lengthComputable) {
            progressBar.value = (event.loaded / event.total) * 100;
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(undefined);
          else reject(new Error(`Upload fallito (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error("Upload fallito"));
        xhr.send(selectedFile);
      });

      downloadUrlEl.textContent = `${window.location.origin}${downloadUrl}`;
      passwordEl.textContent = password;
      resultPanel.hidden = false;
      setMessage("Upload completato.", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore imprevisto", "error");
    } finally {
      uploadButton.disabled = false;
      progressBar.hidden = true;
    }
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initUploadPage);
}
