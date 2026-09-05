function initAdminPage() {
  const form = document.getElementById("invite-form");
  const labelInput = document.getElementById("label-input");
  const maxFilesInput = document.getElementById("max-files-input");
  const ttlInput = document.getElementById("ttl-input");
  const submitButton = document.getElementById("submit-button");
  const messageEl = document.getElementById("message");
  const resultPanel = document.getElementById("result-panel");
  const inviteUrlEl = document.getElementById("invite-url");
  const copyButton = document.getElementById("copy-url");

  function setMessage(text, kind) {
    messageEl.textContent = text;
    messageEl.className = kind ? `message ${kind}` : "message";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    setMessage("Creazione invito...", "");

    try {
      const response = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: labelInput.value,
          maxFiles: Number(maxFilesInput.value),
          ttlHours: Number(ttlInput.value),
        }),
      });

      if (!response.ok) {
        throw new Error("Impossibile creare l'invito");
      }

      const { inviteUrl } = await response.json();
      inviteUrlEl.textContent = `${window.location.origin}${inviteUrl}`;
      resultPanel.hidden = false;
      setMessage("Invito creato.", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore imprevisto", "error");
    } finally {
      submitButton.disabled = false;
    }
  });

  copyButton.addEventListener("click", () => {
    navigator.clipboard.writeText(inviteUrlEl.textContent ?? "");
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initAdminPage);
}
