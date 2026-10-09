/* ============================================================
   Central de Impressões — Desbravador (content script)

   Integra a Central local (app.py / Flask) à interface do
   Desbravador como se fosse uma tela nativa:

     1. adiciona "Central de Impressões" ao menu "Atendimento"
        (mesmo markup/estilo dos itens nativos);
     2. cria a rota  /#/central-impressoes/  — o SPA não a conhece
        (daria 403 e "Acesso bloqueado"), por isso a navegação é
        interceptada e feita com history.pushState (sem hashchange);
     3. desenha a página dentro de #conteudo-ajax, logo abaixo da
        barra de título nativa (h4#titulo-conteudo).

   As chamadas ao app local passam pelo background (service worker),
   evitando CORS / mixed-content dentro da página.
   ============================================================ */

(() => {
  "use strict";

  const HASH     = "#/central-impressoes/";
  const TITULO   = "Central de Impressões";
  const PEND_KEY = "extCentralImpressoesPendente";
  const PREF_KEY = "ext_central_impressoes_config";
  const DEBUG    = true;
  const log = (...a) => DEBUG && console.log("[Central]", ...a);

  const rotaAtiva = () =>
    (location.hash || "").toLowerCase().startsWith("#/central-impressoes");

  /* ------------------------------------------------------------
     0. Abertura directa / reload na nossa rota.
     Se o hash já é o nosso, escondemo-lo do SPA (senão ele tenta
     carregar /central-impressoes, leva 403 e abre o modal
     "Acesso bloqueado"). Ficamos com a intenção guardada e
     reabrimos a página quando o SPA assentar.
     ------------------------------------------------------------ */
  try {
    if (rotaAtiva()) {
      sessionStorage.setItem(PEND_KEY, "1");
      history.replaceState(null, "", location.pathname + location.search + "#/");
    }
  } catch (_) { /* sessionStorage/history indisponível */ }

  /* ------------------------------------------------------------
     1. Guarda da rota: o SPA reage a hashchange carregando a URL.
     Como este content script corre em document_start (antes dos
     scripts da página), este listener é registado primeiro e
     consegue travar o evento para a nossa rota.
     ------------------------------------------------------------ */
  window.addEventListener("hashchange", (e) => {
    if (rotaAtiva()) {
      e.stopImmediatePropagation();
      ativarRota();
    } else {
      marcarItemAtivo(false);   // voltou a uma tela nativa: o SPA marca a dele
    }
  }, true);

  window.addEventListener("popstate", () => {
    if (rotaAtiva()) ativarRota();
  }, true);

  /* ------------------------------------------------------------
     Bridge com o background (proxy do app local)
     ------------------------------------------------------------ */
  function enviar(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, erro: chrome.runtime.lastError.message });
            return;
          }
          resolve(r || { ok: false, erro: "Sem resposta do serviço da extensão." });
        });
      } catch (e) {
        resolve({ ok: false, erro: String((e && e.message) || e) });
      }
    });
  }

  async function api(path, opts) {
    const r = await enviar({
      type: "central:api",
      path,
      method: (opts && opts.method) || "GET",
      body: opts && opts.body
    });
    if (!r.ok) throw new Error(r.erro || "Falha na chamada ao app local.");
    return r.dados;
  }

  // Sincroniza a sessão em silêncio: os cookies do Desbravador vão para o
  // app local através do background (que também o faz sempre que um cookie
  // muda). O utilizador nunca vê um passo "conectar".
  const garantirSessao = () => enviar({ type: "central:sessao" });

  /* ------------------------------------------------------------
     2. Item no menu "Atendimento"
     ------------------------------------------------------------ */
  function acharGrupoAtendimento() {
    const paineis = document.querySelectorAll(".sidebar__menu");
    for (const painel of paineis) {
      for (const li of painel.querySelectorAll("li.item__menu")) {
        const span = li.querySelector(":scope > a > span.span--menu");
        if (span && /atendimento/i.test(span.textContent || "")) return li;
      }
    }
    return null;
  }

  /* O Desbravador marca o item ativo com a classe `item--ativo` no <li>
     (borda azul à esquerda + texto azul a negrito). Reproduzimos o mesmo
     estado no nosso item e desselecionamos o último que estava ativo. */
  function limparSelecaoNativa() {
    const grupo = acharGrupoAtendimento();
    if (!grupo) return;
    grupo.querySelectorAll("li.item__menu.item--ativo").forEach(li => {
      if (li.id !== "ext-central-item") li.classList.remove("item--ativo");
    });
  }

  function marcarItemAtivo(ativo) {
    const meu = document.getElementById("ext-central-item");
    if (ativo) limparSelecaoNativa();
    if (meu) meu.classList.toggle("item--ativo", !!ativo);
  }

  function injetarMenuItem() {
    const grupo = acharGrupoAtendimento();
    if (!grupo) return false;
    if (grupo.querySelector("#ext-central-menu")) {
      if (rotaAtiva()) marcarItemAtivo(true);
      return true;
    }

    const ul = grupo.querySelector(":scope > ul");
    if (!ul) return false;
    const alvo = ul.querySelector(":scope > div") || ul;

    const li = document.createElement("li");
    li.className = "item__menu";
    li.id = "ext-central-item";

    const a = document.createElement("a");
    a.id = "ext-central-menu";
    a.setAttribute("href", "javascript:void(0)");
    a.setAttribute("target", "_self");
    a.innerHTML = '<i class="menu-icon fa fa-print"></i><span>Central de Impressões</span><i></i>';

    // Intercepta o clique (fase de bubble, no próprio alvo) — impede
    // que qualquer handler delegado do SPA veja o evento.
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      abrirCentral();
    });

    li.appendChild(a);

    // Fica imediatamente ANTES do item nativo "Check-in".
    let ref = null;
    for (const item of alvo.children) {
      if (item.tagName !== "LI") continue;
      const span = item.querySelector(":scope > a > span");
      if (span && /^check-?in$/i.test(span.textContent.trim())) { ref = item; break; }
    }
    if (ref) alvo.insertBefore(li, ref);
    else alvo.appendChild(li);

    if (rotaAtiva()) marcarItemAtivo(true);
    log("item de menu injetado");
    return true;
  }

  function abrirCentral() {
    try {
      if (!rotaAtiva()) {
        history.pushState({ extCentral: true }, "", location.pathname + location.search + HASH);
      }
    } catch (_) { /* pushState pode falhar em contextos restritos */ }
    ativarRota();
  }

  /* ------------------------------------------------------------
     3. Página (Shadow DOM dentro de #conteudo-ajax)
     ------------------------------------------------------------ */
  const CSS = `
    *{box-sizing:border-box}
    .wrap{padding:18px;background:#f4f6f9;color:#393939;
      font-family:Roboto,"Open Sans",Arial,sans-serif;font-size:13px;min-height:100%}
    .hdr{display:flex;justify-content:space-between;align-items:center;
      gap:12px;flex-wrap:wrap;margin-bottom:14px}
    .pix{text-align:right;font-size:12px;line-height:1.6;color:#4f9d69}
    .pix b{color:#3d8556}
    .pill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;
      font-size:12px;font-weight:700;border:0;cursor:pointer;font-family:inherit;text-align:left}
    .pill.ok{background:#e6f6ea;color:#1a7f37}
    .pill.bad{background:#fdeaea;color:#b02a37}
    .pill.wait{background:#eef1f4;color:#66707a}
    .card{background:#fff;border:1px solid #e5e9ee;border-radius:6px;
      padding:16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
    .card h3{margin:0 0 12px;font-size:15px;font-weight:600;color:#428ece}
    .grid-principal{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);
      gap:14px;align-items:start;margin-bottom:14px}
    .grid-principal > .card{margin-bottom:0}
    @media (max-width:1150px){.grid-principal{grid-template-columns:1fr}}
    .toolbar{display:flex;justify-content:space-between;align-items:flex-start;
      gap:12px;flex-wrap:wrap;margin-bottom:12px}
    .toolbar .tl,.toolbar .tr{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .opts{display:flex;align-items:center;gap:16px;flex-wrap:wrap;
      padding-top:12px;border-top:1px solid #f0f2f5}
    .opts label{display:flex;align-items:center;gap:6px;color:#5b6670;font-size:12.5px}
    .btn{padding:7px 14px;border-radius:4px;font-size:13px;cursor:pointer;
      border:1px solid transparent;font-weight:500;line-height:1.4;transition:background .15s}
    .btn:disabled{opacity:.55;cursor:not-allowed}
    .btn-primary{background:#428ece;color:#fff;border-color:#428ece}
    .btn-primary:not(:disabled):hover{background:#3178b6}
    .btn-default{background:#fff;color:#495057;border-color:#cfd6dd}
    .btn-default:not(:disabled):hover{background:#f2f5f8}
    select,input[type=number]{padding:6px 8px;border:1px solid #cfd6dd;border-radius:4px;
      font-size:13px;background:#fff;color:#393939}
    select{min-width:200px}
    input[type=number]{width:74px}
    .hint{color:#8a949e;font-size:12.5px}
    .cnt{background:#eef4fb;border:1px solid #d7e5f5;color:#3a6a9c;
      padding:4px 10px;border-radius:999px;font-size:12px}
    .lista{display:grid;gap:8px}
    .lista-topo{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px}
    .lista-toggle{display:inline-flex;align-items:center;gap:7px}
    /* Seta desenhada com bordas — a fonte de ícones da página não atravessa o shadow DOM */
    .lista-seta{display:inline-block;width:7px;height:7px;border-right:2px solid #66707a;
      border-bottom:2px solid #66707a;transform:rotate(45deg)}
    .lista-toggle[aria-expanded="true"] .lista-seta{transform:rotate(-135deg)}
    .lista-toggle-qtd{background:#eef4fb;border:1px solid #d7e5f5;color:#3a6a9c;
      border-radius:999px;padding:1px 8px;font-size:11.5px;font-weight:700}
    .lista-dica{color:#8a949e;font-size:12px}
    .lista-preview{display:flex;gap:6px;overflow-x:auto;padding:9px 0 2px}
    .lista-preview[hidden]{display:none}
    .lista-chip{flex:0 0 auto;background:#f4f7fa;border:1px solid #e2e8ee;border-radius:5px;
      padding:4px 9px;font-size:11.5px;color:#4a5560;white-space:nowrap}
    .lista-chip b{color:#2b5c86;font-weight:700}
    .lista-chip.sel{background:#e9f7ed;border-color:#bfe3c8;color:#1a7f37}
    .lista-chip.sel b{color:#1a7f37}
    .lista-mais{flex:0 0 auto;display:inline-flex;align-items:center;padding:4px 6px;
      color:#8a949e;font-size:13px;font-weight:700;letter-spacing:1.5px}
    .lista-central{margin-top:14px;padding-top:12px;border-top:1px solid #f0f2f5}
    .lista-central.recolhida{display:none}
    .reserva{display:flex;align-items:flex-start;gap:10px;padding:11px 13px;
      border:1px solid #e5e9ee;border-radius:6px;cursor:pointer}
    .reserva:hover{border-color:#bcd2e8;background:#fbfdff}
    .reserva input{margin-top:3px;transform:scale(1.1)}
    .reserva .rid{font-weight:700;font-size:14px}
    .reserva .qs{color:#7a848e;font-size:12.5px;margin-top:2px;word-break:break-word}
    .vazio{color:#9aa4ae;padding:14px 2px}
    .cafe{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin-top:12px}
    .cafe .box{border:1px solid #eef1f4;border-radius:6px;padding:12px}
    .cafe .box .rot{color:#8a949e;font-size:12px}
    .cafe .box .val{font-size:22px;font-weight:700;color:#3f4a54;margin-top:3px}
    .cafe .box.full{grid-column:1/-1}
    .cafe .box.full .val{font-size:28px;color:#428ece}
    .msg{margin:0 0 14px;white-space:pre-wrap;padding:10px 14px;border-radius:6px;
      background:#eef4fb;border:1px solid #d7e5f5;color:#2b5c86;display:none}
    .msg.show{display:block}
    .msg.erro{background:#fdeaea;border-color:#f6cfd0;color:#b02a37}
    .row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  `;

  const HTML = `
    <div class="wrap">
      <div class="hdr">
        <button class="pill wait" id="st-pill" title="Clique para sincronizar a sessão">● Verificando sessão…</button>
        <div class="pix">
          Se isso foi útil para você, considere me apoiar &lt;3<br>
          Programa feito por <b>Isaac</b><br>
          Chave Pix e contato para suporte: <b>(94) 99663-5669</b>
        </div>
      </div>

      <div class="msg" id="msg"></div>

      <div class="grid-principal">
        <!-- Coluna esquerda: check-ins -->
        <div class="card">
          <h3>Check-ins</h3>
          <div class="toolbar">
            <div class="tl">
              <button class="btn btn-primary" id="btn-buscar">Atualizar check-ins</button>
              <span class="hint" id="total">—</span>
            </div>
            <div class="tr">
              <label class="hint">Impressora
                <select id="printer"><option value="">Impressora padrão</option></select>
              </label>
            </div>
          </div>

          <div class="opts">
            <label><input type="checkbox" id="opt-ficha"> Ficha</label>
            <label><input type="checkbox" id="opt-info"> Informativos</label>
            <label>Tempo espera (s) <input type="number" id="opt-hold" min="0" step="1" value="5"></label>
            <button class="btn btn-default" id="btn-marcar">Marcar todos</button>
            <button class="btn btn-default" id="btn-desmarcar">Desmarcar todos</button>
            <span class="cnt" id="sel-count">0 selecionado(s)</span>
            <button class="btn btn-primary" id="btn-imprimir" disabled>Imprimir selecionados</button>
          </div>

          <div class="lista-topo">
            <button type="button" class="btn btn-default lista-toggle" id="btn-lista"
                    aria-expanded="false" aria-controls="lista" title="Expandir a lista de reservas">
              <span class="lista-seta" aria-hidden="true"></span><span>Reservas</span>
              <span class="lista-toggle-qtd" id="btn-lista-qtd">0</span>
            </button>
            <span class="lista-dica" id="lista-dica" hidden>lista recolhida</span>
          </div>

          <div class="lista-preview" id="lista-preview" hidden></div>

          <div id="lista" class="lista-central"><div class="vazio">Carregando check-ins…</div></div>
        </div>

        <!-- Coluna direita: previsão de café -->
        <div class="card">
          <h3>Previsão de Café da Manhã</h3>
          <div class="row">
            <button class="btn btn-primary" id="btn-cafe">Atualizar</button>
            <button class="btn btn-default" id="btn-copiar" disabled>Copiar mensagem</button>
          </div>
          <div class="cafe" id="cafe"><div class="vazio">Carregando…</div></div>
        </div>
      </div>

      <!-- Relatórios no fundo -->
      <div class="card">
        <h3>Relatórios</h3>
        <div class="row">
          <button class="btn btn-primary" id="btn-checkin">Check-in do dia</button>
          <button class="btn btn-primary" id="btn-governanca">Governança</button>
          <label class="hint">Dias entre trocas
            <input type="number" id="dias" min="0" max="30" step="1" value="2">
          </label>
        </div>
      </div>
    </div>
  `;

  let hostCentral = null;
  let _aguardandoAbertura = false;   // abrir/reabrir → recarrega os dados

  /* Chamado sempre que a rota é (re)aberta pelo utilizador: além de desenhar,
     dispara o carregamento automático de check-ins e previsão de café. */
  function ativarRota() {
    _aguardandoAbertura = true;
    renderCentral();
  }

  function renderCentral() {
    marcarItemAtivo(true);
    const ca = document.querySelector("#conteudo-ajax");
    if (!ca) return;

    const t = document.querySelector("#titulo-conteudo");
    if (t) t.textContent = TITULO;

    if (!hostCentral) criarHost();
    if (!ca.contains(hostCentral)) {
      ca.innerHTML = "";
      ca.appendChild(hostCentral);
    }

    if (_aguardandoAbertura && hostCentral &&
        typeof hostCentral.__atualizarTudo === "function") {
      _aguardandoAbertura = false;
      hostCentral.__atualizarTudo();
    }
  }

  function criarHost() {
    hostCentral = document.createElement("div");
    hostCentral.id = "ext-central-host";
    hostCentral.style.display = "block";
    const sh = hostCentral.attachShadow({ mode: "open" });
    sh.innerHTML = "<style>" + CSS + "</style>" + HTML;
    ligar(sh);
  }

  /* ============================================================
     Lógica da página
     ============================================================ */
  let reservasCache = [];
  let previsaoCache = null;

  function ligar(sh) {
    const $ = (id) => sh.getElementById(id);

    /* ---------- feedback ---------- */
    function msg(texto, erro) {
      const el = $("msg");
      el.className = "msg show" + (erro ? " erro" : "");
      el.textContent = texto || "";
    }

    /* ---------- preferências ---------- */
    function carregarPrefs() {
      let cfg = {};
      try { cfg = JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {}; } catch (_) {}
      if (cfg.printer) {
        const sel = $("printer");
        if ([...sel.options].some(o => o.value === cfg.printer)) sel.value = cfg.printer;
      }
      if (cfg.hold !== undefined && cfg.hold !== null) $("opt-hold").value = cfg.hold;
      if (cfg.ficha) $("opt-ficha").checked = true;
      if (cfg.info) $("opt-info").checked = true;
    }
    function salvarPrefs() {
      try {
        localStorage.setItem(PREF_KEY, JSON.stringify({
          printer: $("printer").value || "",
          hold: parseInt($("opt-hold").value, 10) || 0,
          ficha: $("opt-ficha").checked,
          info: $("opt-info").checked
        }));
      } catch (_) {}
    }

    /* ---------- sessão (silenciosa) ---------- */
    async function atualizarStatus() {
      const pill = $("st-pill");
      try {
        const s = await api("/api/session/status");
        if (s && s.connected) {
          pill.className = "pill ok";
          pill.textContent = "● Sessão conectada";
          pill.title = "Sessão do Desbravador sincronizada com a Central de Impressões";
        } else {
          pill.className = "pill wait";
          pill.textContent = "● Sincronizando sessão…";
          pill.title = "Clique para sincronizar novamente";
        }
      } catch (e) {
        pill.className = "pill bad";
        pill.textContent = "● Central de Impressões não está aberta";
        pill.title = "A sessão conecta sozinha assim que a Central estiver aberta";
      }
    }

    // Conecta sem incomodar: não há botão "conectar" para carregar.
    async function sincronizarAgora(silencioso) {
      const pill = $("st-pill");
      if (!silencioso) {
        pill.className = "pill wait";
        pill.textContent = "● Sincronizando sessão…";
      }
      const r = await garantirSessao();
      if (!r.ok) {
        pill.className = "pill bad";
        pill.textContent = "● Central de Impressões não está aberta";
        pill.title = r.erro || "";
        return r;
      }
      await atualizarStatus();
      return r;
    }

    /* Abrir a página = recarregar os dados (check-ins + previsão de café). */
    let _ultimaAtualizacao = 0;
    async function atualizarTudo() {
      if (Date.now() - _ultimaAtualizacao < 1500) return;   // evita duplo arranque
      _ultimaAtualizacao = Date.now();
      await sincronizarAgora(true);   // sessão fresca, em silêncio
      buscar();                       // cada um reporta os seus próprios erros
      atualizarCafe();
    }
    if (hostCentral) hostCentral.__atualizarTudo = atualizarTudo;

    /* ---------- impressoras ---------- */
    async function carregarImpressoras() {
      const sel = $("printer");
      try {
        const d = await api("/api/printers");
        if (d && d.ok) {
          sel.innerHTML = '<option value="">Impressora padrão</option>' +
            (d.printers || []).map(n => '<option value="' + String(n).replace(/"/g, "&quot;") + '">' + n + "</option>").join("");
        }
      } catch (_) { /* sem impressoras: segue com a padrão */ }
      carregarPrefs();
    }

    /* ---------- reservas ---------- */
    // Recolhe apenas a lista de reservas: o resto do cartão (Ficha, tempo de
    // espera, "Marcar todos", "Imprimir selecionados") continua sempre visível.
    // Abre SEMPRE recolhida — a lista completa só ocupa espaço se o utilizador
    // a quiser ver (o estado não é persistido: cada abertura começa recolhida).
    let listaRecolhida = true;

    function aplicarLista() {
      const lista = $("lista");
      const btn = $("btn-lista");
      if (!lista || !btn) return;
      lista.classList.toggle("recolhida", listaRecolhida);
      $("lista-preview").hidden = !listaRecolhida;
      $("lista-dica").hidden = !listaRecolhida;
      btn.setAttribute("aria-expanded", String(!listaRecolhida));
      btn.title = listaRecolhida ? "Expandir a lista de reservas" : "Recolher a lista de reservas";
    }

    function atualizarContadores() {
      const sel = sh.querySelectorAll('input[name="reservaSelecionada"]:checked').length;
      const tot = sh.querySelectorAll('input[name="reservaSelecionada"]').length;
      $("sel-count").textContent = sel + " selecionado(s)";
      $("btn-imprimir").disabled = sel === 0;
      if (tot) $("total").textContent = tot + " apartamento(s)";

      // mantém a prévia horizontal (visível com a lista recolhida) em sincronia
      sh.querySelectorAll(".lista-chip[data-id]").forEach(c => {
        const chk = sh.querySelector('input[name="reservaSelecionada"][value="' + c.dataset.id + '"]');
        c.classList.toggle("sel", !!chk && chk.checked);
      });
    }

    function renderReservas(reservas) {
      const box = $("lista");
      if (!reservas.length) {
        box.innerHTML = '<div class="vazio">Nenhum check-in encontrado.</div>';
        $("btn-lista-qtd").textContent = "0";
        $("lista-preview").innerHTML = "";
        atualizarContadores();
        return;
      }
      box.innerHTML = '<div class="lista">' + reservas.map(x =>
        '<label class="reserva">' +
          '<input type="checkbox" name="reservaSelecionada" value="' + x.id + '">' +
          '<span><span class="rid">Reserva #' + x.id + "</span>" +
          '<div class="qs">Quartos: ' + ((x.quartos && x.quartos.length) ? x.quartos.join(", ") : "não informado") + "</div></span>" +
        "</label>"
      ).join("") + "</div>";

      // prévia horizontal: no máximo 3 UHs, com "…" a indicar que há mais
      const LIMITE_PREVIA = 3;
      $("btn-lista-qtd").textContent = String(reservas.length);
      const previa = reservas.slice(0, LIMITE_PREVIA).map(x =>
        '<span class="lista-chip" data-id="' + x.id + '">#' + x.id + " · <b>" +
        ((x.quartos && x.quartos.length) ? x.quartos.join(", ") : "—") + "</b></span>"
      );
      if (reservas.length > LIMITE_PREVIA) {
        const restantes = reservas.length - LIMITE_PREVIA;
        previa.push('<span class="lista-mais" title="mais ' + restantes +
          (restantes === 1 ? " reserva" : " reservas") + '">…</span>');
      }
      $("lista-preview").innerHTML = previa.join("");

      box.querySelectorAll('input[name="reservaSelecionada"]').forEach(i =>
        i.addEventListener("change", atualizarContadores));
      atualizarContadores();
    }

    async function buscar() {
      const btn = $("btn-buscar");
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = "Buscando…";
      msg("Buscando check-ins no Desbravador…");
      try {
        await garantirSessao();     // sessão fresca antes de pedir dados
        const d = await api("/api/reservas", { method: "POST" });
        if (!d || !d.ok) throw new Error((d && d.error) || "Erro ao listar reservas.");
        reservasCache = d.reservas || [];
        renderReservas(reservasCache);
        msg((d.count || 0) + " reserva(s) encontrada(s).");
      } catch (e) {
        reservasCache = [];
        $("lista").innerHTML = '<div class="vazio">Falha ao buscar check-ins.</div>';
        atualizarContadores();
        msg("Erro: " + e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    }

    async function imprimirSelecionados() {
      const ids = [...sh.querySelectorAll('input[name="reservaSelecionada"]:checked')].map(i => i.value);
      if (!ids.length) { msg("Selecione ao menos um apartamento.", true); return; }

      const btn = $("btn-imprimir");
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = "Imprimindo…";
      msg("Imprimindo " + ids.length + " apartamento(s)…");
      salvarPrefs();

      try {
        const d = await api("/api/imprimir-lote", {
          method: "POST",
          body: {
            ids,
            printer: $("printer").value || "",
            print_confirmation: true,
            print_ficha: $("opt-ficha").checked,
            print_informativos: $("opt-info").checked,
            print_hold_seconds: parseInt($("opt-hold").value, 10) || 0
          }
        });

        const linhas = ["Impressão concluída para " + ((d && d.count) || 0) + " apartamento(s)."];
        if (d && d.printed && d.printed.length) {
          linhas.push("Reservas: " + d.printed.map(x => "#" + x.reserva_id).join(", "));
        }
        if (d && d.errors && d.errors.length) {
          linhas.push("Falhas: " + d.errors.map(x => "#" + x.id + " (" + x.error + ")").join(" | "));
          msg(linhas.join("\n"), true);
        } else {
          msg(linhas.join("\n"));
        }
      } catch (e) {
        msg("Erro ao imprimir: " + e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
        atualizarContadores();
      }
    }

    /* ---------- relatórios ---------- */
    async function acaoRelatorio(btn, texto, path, body) {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Imprimindo…";
      msg(texto + "…");
      try {
        const d = await api(path, { method: "POST", body });
        if (!d || !d.ok) throw new Error((d && d.error) || "Falha ao imprimir.");
        msg(texto + " impresso com sucesso." + (d.data ? "\nData: " + d.data : "") +
            (d.andares ? "\nAndares: " + d.andares.join(", ") : ""));
      } catch (e) {
        msg("Erro: " + e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    }

    /* ---------- previsão de café ---------- */
    function renderPrevisao(d) {
      $("cafe").innerHTML =
        '<div class="box"><div class="rot">UH\'s ocupadas hoje</div><div class="val">' + d.uh_atual + "</div></div>" +
        '<div class="box"><div class="rot">Hóspedes na casa</div><div class="val">' + d.pax_atual + "</div></div>" +
        '<div class="box"><div class="rot">Check-in</div><div class="val">' + d.checkin_uh + " UH | " + d.checkin_pax + " PAX</div></div>" +
        '<div class="box"><div class="rot">Check-out previsto</div><div class="val">' + d.checkout_uh + " UH | " + d.checkout_pax + " PAX</div></div>" +
        '<div class="box full"><div class="rot">Café da manhã para amanhã</div><div class="val">' + d.uh_amanha + " UHs | " + d.pax_amanha + " PAX</div></div>";
      $("btn-copiar").disabled = false;
    }

    async function atualizarCafe() {
      const btn = $("btn-cafe");
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Consultando…";
      $("cafe").innerHTML = '<div class="vazio">Consultando Desbravador…</div>';
      msg("Calculando previsão de café…");
      try {
        const d = await api("/api/previsao-cafe");
        if (!d || !d.ok) throw new Error((d && d.error) || "Falha na previsão.");
        previsaoCache = d;
        renderPrevisao(d);
        msg("Previsão atualizada: " + d.uh_amanha + " UHs | " + d.pax_amanha + " PAX para o café de amanhã.");
      } catch (e) {
        previsaoCache = null;
        $("btn-copiar").disabled = true;
        $("cafe").innerHTML = '<div class="vazio">Erro ao consultar a previsão.</div>';
        msg("Erro: " + e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    }

    async function copiarCafe() {
      if (!previsaoCache) { msg("Atualize a previsão antes de copiar.", true); return; }
      const d = previsaoCache;
      const p = String(d.data || "").split("/");
      let amanha = "";
      if (p.length === 3) {
        const dt = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
        dt.setDate(dt.getDate() + 1);
        amanha = String(dt.getDate()).padStart(2, "0") + "/" +
                 String(dt.getMonth() + 1).padStart(2, "0") + "/" + dt.getFullYear();
      }
      const texto =
"Bom dia!\n" +
"📊 Atualização do dia " + d.data + ":\n" +
"- 🛌 " + d.uh_atual + " UH's ocupadas\n" +
"- 👥 Total de hóspedes (PAX): " + d.pax_atual + "\n" +
"🔁 Movimentações do dia:\n\n" +
"📈 Check-in: " + String(d.checkin_uh).padStart(2, "0") + " UH's | " + d.checkin_pax + " Pax\n" +
"- \n- \n" +
"📉 Check-out previsto: " + String(d.checkout_uh).padStart(2, "0") + " UH's | " + d.checkout_pax + " Pax\n" +
"- \n- \n" +
"🍽️ Café da manhã para amanhã (" + amanha + ")\n- 🌄\n\n" +
d.uh_amanha + " UHs | pax " + d.pax_amanha;

      try {
        await navigator.clipboard.writeText(texto);
        const btn = $("btn-copiar");
        const orig = btn.textContent;
        btn.textContent = "Copiado!";
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1600);
      } catch (e) {
        msg("Não foi possível copiar: " + e.message, true);
      }
    }

    /* ---------- eventos ---------- */
    $("st-pill").addEventListener("click", () => sincronizarAgora(false));
    $("btn-buscar").addEventListener("click", buscar);
    $("btn-marcar").addEventListener("click", () => {
      sh.querySelectorAll('input[name="reservaSelecionada"]').forEach(i => i.checked = true);
      atualizarContadores();
    });
    $("btn-desmarcar").addEventListener("click", () => {
      sh.querySelectorAll('input[name="reservaSelecionada"]').forEach(i => i.checked = false);
      atualizarContadores();
    });
    $("btn-imprimir").addEventListener("click", imprimirSelecionados);
    $("btn-lista").addEventListener("click", () => {
      listaRecolhida = !listaRecolhida;
      aplicarLista();
    });
    aplicarLista();
    $("btn-checkin").addEventListener("click", (e) =>
      acaoRelatorio(e.currentTarget, "Relatório de Check-in do dia", "/api/relatorio/checkin", {}));
    $("btn-governanca").addEventListener("click", (e) =>
      acaoRelatorio(e.currentTarget, "Relatório de Governança", "/api/relatorio/governanca",
        { dias_entre_trocas: parseInt($("dias").value, 10) || 2 }));
    $("btn-cafe").addEventListener("click", atualizarCafe);
    $("btn-copiar").addEventListener("click", copiarCafe);
    ["printer", "opt-hold", "opt-ficha", "opt-info"].forEach(id =>
      $(id).addEventListener("change", salvarPrefs));

    /* ---------- arranque da página ---------- */
    carregarImpressoras();
    atualizarTudo();   // abre já com check-ins e café carregados

    // Exposto para o intervalo de sincronização de sessão (fora do Shadow)
    if (hostCentral) hostCentral.__atualizarStatus = atualizarStatus;
  }

  /* ------------------------------------------------------------
     4. Boot
     ------------------------------------------------------------ */
  function debounce(fn, ms) {
    let t = null;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function iniciar() {
    log("boot", location.href);
    injetarMenuItem();

    // O SPA recria a barra lateral ao trocar de módulo → re-injeta.
    const obs = new MutationObserver(debounce(() => {
      injetarMenuItem();
      if (rotaAtiva()) renderCentral();   // se o SPA limpar a área, redesene
    }, 200));
    try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}

    [600, 1500, 3000].forEach(t => setTimeout(injetarMenuItem, t));

    // Reabertura directa na rota (reload / F5)
    let pend = false;
    try { pend = sessionStorage.getItem(PEND_KEY) === "1"; sessionStorage.removeItem(PEND_KEY); } catch (_) {}
    if (pend) {
      setTimeout(() => {
        try { history.pushState({ extCentral: true }, "", location.pathname + location.search + HASH); } catch (_) {}
        ativarRota();
      }, 900);
    }

    // Sessão: sincroniza sozinha ao abrir, ao voltar ao separador e a cada
    // 10 min. O background reenvia sempre que um cookie muda, por isso o
    // utilizador nunca precisa de fazer nada.
    setTimeout(() => { garantirSessao().then(atualizarStatusSeAberto); }, 1200);
    setInterval(() => { garantirSessao().then(atualizarStatusSeAberto); }, 10 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) garantirSessao().then(atualizarStatusSeAberto);
    });
  }

  function atualizarStatusSeAberto() {
    if (hostCentral && typeof hostCentral.__atualizarStatus === "function") {
      hostCentral.__atualizarStatus();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
