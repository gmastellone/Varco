export function extractFilename(contentDisposition) {
  if (!contentDisposition) return "download";
  const match = contentDisposition.match(/filename="([^"]*)"/);
  return match ? match[1] : "download";
}

function initDownloadPage() {
  const form = document.getElementById("download-form");
  const passwordInput = document.getElementById("password-input");
  const submitButton = document.getElementById("submit-button");
  const messageEl = document.getElementById("message");

  function setMessage(text, kind) {
    messageEl.textContent = text;
    messageEl.className = kind ? `message ${kind}` : "message";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    setMessage("Verifica in corso...", "");

    try {
      const response = await fetch(window.location.pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: passwordInput.value }),
      });

      if (response.status === 429) {
        setMessage("Troppi tentativi. Riprova più tardi.", "error");
        return;
      }
      if (response.status === 410) {
        setMessage("Questo link non è più disponibile.", "error");
        return;
      }
      if (!response.ok) {
        setMessage("Password errata o link non valido.", "error");
        return;
      }

      const blob = await response.blob();
      const filename = extractFilename(response.headers.get("Content-Disposition"));
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      setMessage("Download avviato.", "success");
    } catch (error) {
      setMessage("Errore di rete. Riprova.", "error");
    } finally {
      submitButton.disabled = false;
    }
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initDownloadPage);
}
