/* ============================================================
   Background Service Worker
   ============================================================ */

const STORAGE_KEY = "desbravador_conferencia_v1";

const DESBRAVADOR_DOMAIN = "desbravadorweb.com.br";

/* A Central de Impressões (app.py) costuma correr em background, sem janela.
   Descobrimos em que porta responde e guardamos em cache. */
const APP_CANDIDATOS = [
  "http://127.0.0.1:8000",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:8001"
];
let _appUrl = null;
let _probe = null;

async function descobrirApp(forcar) {
  if (_appUrl && !forcar) return _appUrl;
  if (_probe) return _probe;

  _probe = (async () => {
    for (const base of APP_CANDIDATOS) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(base + "/api/session/status", { signal: ctrl.signal, cache: "no-store" });
        clearTimeout(t);
        if (r.ok) { _appUrl = base; return base; }
      } catch (_) { /* tenta a próxima porta */ }
    }
    _appUrl = null;
    return null;
  })();

  try { return await _probe; } finally { _probe = null; }
}

/* Base a usar: se a preferida responder, usa-a; senão, procura. */
async function resolverBase(preferida) {
  if (_appUrl) return _appUrl;
  const p = preferida ? String(preferida).replace(/\/+$/, "") : null;
  if (p) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1200);
      const r = await fetch(p + "/api/session/status", { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (r.ok) { _appUrl = p; return p; }
    } catch (_) { /* segue para a descoberta */ }
  }
  return await descobrirApp(false);
}

/* POST genérico para o app.py local; devolve {ok, ...} ou {ok:false, erro}. */
async function postarNoApp(appUrl, caminho, payload) {
  const base = await resolverBase(appUrl);
  if (!base) return { ok: false, erro: "Central de Impressões não está aberta (portas 8000/5000/8001)." };

  let r;
  try {
    r = await fetch(base + caminho, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
  } catch (_) {
    _appUrl = null;                 // a porta pode ter mudado
    return { ok: false, erro: "Central de Impressões não respondeu (" + base + ")." };
  }

  const texto = await r.text();
  let dados = null;
  try { dados = JSON.parse(texto); } catch (_) { /* resposta não-JSON */ }

  if (!r.ok || !dados || dados.ok === false) {
    return { ok: false, erro: (dados && (dados.error || dados.erro)) || ("HTTP " + r.status) };
  }
  return Object.assign({ ok: true }, dados);
}

/* Proxy genérico (GET/POST) dos endpoints /api/* do app local. */
async function proxyCentral(path, method, body) {
  const base = await resolverBase(null);
  if (!base) return { ok: false, erro: "Central de Impressões não está aberta (portas 8000/5000/8001)." };

  const verb = String(method || "GET").toUpperCase();
  const opts = { method: verb, cache: "no-store" };
  if (body !== undefined && body !== null && verb !== "GET" && verb !== "HEAD") {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }

  let r;
  try {
    r = await fetch(base + path, opts);
  } catch (_) {
    _appUrl = null;
    return { ok: false, erro: "Central de Impressões não respondeu (" + base + ")." };
  }

  const texto = await r.text();
  let dados = null;
  try { dados = JSON.parse(texto); } catch (_) { /* não-JSON */ }

  if (!r.ok) {
    return { ok: false, erro: (dados && (dados.error || dados.erro)) || ("HTTP " + r.status), dados };
  }
  return { ok: true, dados: dados !== null ? dados : { raw: texto } };
}

/* ---------- Sessão em segundo plano (sem interação do utilizador) ----------
   Sempre que um cookie do Desbravador muda (login, renovação, logout) os
   cookies são reenviados ao app local. */
let _timerSessao = null;
function sincronizarEmSegundoPlano() {
  clearTimeout(_timerSessao);
  _timerSessao = setTimeout(() => {
    enviarSessaoParaApp(null).catch(() => { /* app fechado: ignora */ });
  }, 1500);
}

chrome.cookies.onChanged.addListener((info) => {
  const dominio = (info && info.cookie && info.cookie.domain) || "";
  if (dominio.includes(DESBRAVADOR_DOMAIN)) sincronizarEmSegundoPlano();
});
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => sincronizarEmSegundoPlano());
chrome.runtime.onInstalled.addListener(() => sincronizarEmSegundoPlano());

/* ============================================================
   SESSÃO — envia os cookies do Desbravador para o app.py local
   (POST /api/session) para o servidor poder aceder ao PMS.
   ============================================================ */
async function enviarSessaoParaApp(appUrl) {
  const cookies = await chrome.cookies.getAll({ domain: DESBRAVADOR_DOMAIN });
  const limpos = (cookies || [])
    .filter(c => c && c.name && typeof c.value === "string")
    .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" }));

  if (!limpos.length) {
    return { ok: false, erro: "Nenhum cookie do Desbravador encontrado." };
  }

  const r = await postarNoApp(appUrl, "/api/session", { cookies: limpos, origem: "crm-conferencia" });
  if (!r.ok) return r;
  return { ok: true, cookies: r.cookie_count || limpos.length };
}

// Ao instalar, inicializa o storage
chrome.runtime.onInstalled.addListener(async () => {
  const atual = await chrome.storage.local.get([STORAGE_KEY]);
  if (!atual[STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: {} });
    console.log("[Conferência] Storage inicializado.");
  }
});

// Escuta mensagens do content script (ex.: para notificar contagem)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "conferencia-snapshot") {
    // Opcional: poderia mostrar badge no ícone da extensão
    const { pendentes, divergentes } = msg.dados || {};
    const total = (pendentes || 0) + (divergentes || 0);
    chrome.action.setBadgeText({ text: total > 0 ? String(total) : "" });
    chrome.action.setBadgeBackgroundColor({ color: divergentes > 0 ? "#CA0806" : "#ef6c00" });
    sendResponse({ ok: true });
  }

  // Envia os cookies da sessão do Desbravador para o app.py local.
  if (msg.type === "sincronizar-sessao") {
    enviarSessaoParaApp(msg.appUrl)
      .then(r => sendResponse(r))
      .catch(err => sendResponse({ ok: false, erro: String((err && err.message) || err) }));
  }

  // Imprime no app.py local: extratos recem-gerados (PDF) ou dados brutos.
  if (msg.type === "imprimir-pdfs" || msg.type === "imprimir-extratos") {
    const caminho = msg.type === "imprimir-pdfs" ? "/api/imprimir-pdfs" : "/api/imprimir-extratos";
    postarNoApp(msg.appUrl, caminho, msg.payload)
      .then(r => sendResponse(r))
      .catch(err => sendResponse({ ok: false, erro: String((err && err.message) || err) }));
  }

  // ---- Central de Impressões (tela nativa dentro do Desbravador) ----
  // Sincroniza a sessão sem o utilizador precisar de fazer nada.
  if (msg.type === "central:sessao") {
    enviarSessaoParaApp(null)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, erro: String((err && err.message) || err) }));
  }

  // Proxy das chamadas /api/* (evita CORS/mixed-content na página).
  if (msg.type === "central:api") {
    proxyCentral(msg.path, msg.method, msg.body)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, erro: String((err && err.message) || err) }));
  }

  return true;
});