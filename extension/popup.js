const status = document.getElementById("status");
const button = document.getElementById("send");
const CANDIDATOS = ["http://127.0.0.1:8000", "http://127.0.0.1:5000", "http://127.0.0.1:8001"];

function show(m) { status.textContent = m; }

async function acharApp() {
  for (const base of CANDIDATOS) {
    try {
      const r = await fetch(base + "/api/session/status", { cache: "no-store" });
      if (r.ok) return base;
    } catch (_) { /* tenta a próxima porta */ }
  }
  return null;
}

// Mostra o estado assim que o popup abre.
(async () => {
  const app = await acharApp();
  show(app ? `Central de Impressões ativa em ${app}.` : "Central de Impressões não está aberta.");
})();

button.addEventListener("click", async () => {
  button.disabled = true;
  show("Coletando cookies...");
  try {
    const app = await acharApp();
    if (!app) throw new Error("Central de Impressões não está aberta (portas 8000/5000/8001).");

    const cookies = await chrome.cookies.getAll({ domain: "desbravadorweb.com.br" });
    if (!cookies.length) throw new Error("Nenhum cookie encontrado para desbravadorweb.com.br.");

    const payload = cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate
    }));

    show(`Encontrados ${payload.length} cookies. Enviando...`);
    const response = await fetch(app + "/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: payload })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    show(`Sessão conectada.\nCookies: ${data.cookie_count}`);
    chrome.tabs.create({ url: app + "/" });
  } catch (err) {
    show(`Erro: ${err.message}`);
  } finally {
    button.disabled = false;
  }
});