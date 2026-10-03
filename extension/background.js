/* ============================================================
   Central de Impressões — Desbravador
   Background service worker.

   Ponte entre a página do Desbravador (content script) e o app
   local (Flask). Fazer as chamadas AQUI (e não no content script)
   evita CORS e mixed-content: o service worker tem host_permissions
   e não está sujeito às políticas da página.
   ============================================================ */

/* Portas onde a Central de Impressões costuma responder. A primeira que
   responder a /api/session/status fica em cache (o app pode rodar em
   background, em qualquer uma delas). */
const APP_CANDIDATOS = [
  "http://127.0.0.1:8000",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:8001"
];
const DESBRAVADOR_DOMAIN = "desbravadorweb.com.br";

let _appUrl = null;   // base que respondeu
let _probe = null;    // descoberta em curso

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

/* ---------- Sessão: manda os cookies do Desbravador p/ o app ---------- */
async function enviarSessao(forcar) {
  const base = await descobrirApp(!!forcar);
  if (!base) return { ok: false, erro: "Central de Impressões não está aberta (portas 8000/5000/8001)." };

  const cookies = await chrome.cookies.getAll({ domain: DESBRAVADOR_DOMAIN });
  const limpos = (cookies || [])
    .filter(c => c && c.name && typeof c.value === "string")
    .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" }));

  if (!limpos.length) {
    return { ok: false, erro: "Nenhum cookie do Desbravador encontrado." };
  }

  const r = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookies: limpos, origem: "central-impressoes" })
  });

  const texto = await r.text();
  let dados = null;
  try { dados = JSON.parse(texto); } catch (_) { /* não-JSON */ }

  if (!r.ok || !dados || dados.ok === false) {
    return { ok: false, erro: (dados && (dados.error || dados.erro)) || ("HTTP " + r.status) };
  }
  return { ok: true, cookie_count: dados.cookie_count || limpos.length, appUrl: base };
}

/* ---------- Proxy genérico para os /api/* do app local ---------- */
async function proxy(path, method, body) {
  const base = await descobrirApp(false);
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
    _appUrl = null;              // a porta pode ter mudado: volta a descobrir
    return { ok: false, erro: "Central de Impressões não respondeu (" + base + ")." };
  }
  const texto = await r.text();

  let dados = null;
  try { dados = JSON.parse(texto); } catch (_) { /* não-JSON */ }

  if (!r.ok) {
    return {
      ok: false,
      erro: (dados && (dados.error || dados.erro)) || ("HTTP " + r.status),
      dados
    };
  }
  return { ok: true, dados: dados !== null ? dados : { raw: texto } };
}

/* ---------- Sincronização silenciosa da sessão ----------
   Sempre que um cookie do Desbravador muda (login, renovação de sessão,
   logout) os cookies são reenviados ao app local — o utilizador nunca
   precisa de fazer nada. */
let _timerSessao = null;
function sincronizarEmSegundoPlano() {
  clearTimeout(_timerSessao);
  _timerSessao = setTimeout(() => {
    enviarSessao(true).catch(() => { /* app desligado: ignora em silêncio */ });
  }, 1500);
}

chrome.cookies.onChanged.addListener((info) => {
  const dominio = (info && info.cookie && info.cookie.domain) || "";
  if (dominio.includes(DESBRAVADOR_DOMAIN)) sincronizarEmSegundoPlano();
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => sincronizarEmSegundoPlano());
}
chrome.runtime.onInstalled.addListener(() => sincronizarEmSegundoPlano());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "central:sessao") {
    enviarSessao(!!msg.forcar)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, erro: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === "central:api") {
    proxy(msg.path, msg.method, msg.body)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, erro: String((e && e.message) || e) }));
    return true;
  }

  return;
});
