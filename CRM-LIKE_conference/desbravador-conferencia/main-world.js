/* ============================================================
   Conferência de Comandas — Desbravador
   Bridge do MAIN world (contexto da PÁGINA).

   Este ficheiro é declarado no manifest como content script com
   "world": "MAIN", pelo que é injetado pelo próprio Chrome e corre
   sempre. Antes era injetado com um <script> inline criado pelo
   content script — e esse <script> NÃO executava em todos os
   ambientes, o que fazia o modal "Lançar comandas" nunca aparecer
   (o listener nunca existia e nada era registado na consola).

   ⚠️ Nada aqui pode usar APIs `chrome.*`: no main world elas não
   existem.

   COMUNICAÇÃO com o content script (isolated world):
   o content script publica o payload em JSON no atributo
   `data-ext-ponte-<evento>` do <html> e dispara o evento <evento>.
   Aqui lemos por DOIS canais independentes:
     1) `e.detail` (string JSON) — quando o evento atravessa worlds;
     2) o atributo do DOM, vigiado por polling — caso não atravesse.
   Nunca se lê objetos do `detail`: um objeto criado no isolated world
   não é legível aqui (era a causa de falhas silenciosas).
   Cada pedido processado é confirmado em `data-ext-ack-<evento>`.
   ============================================================ */

(() => {
  "use strict";
  if (window.__extMainWorldPronto) return;
  window.__extMainWorldPronto = true;

  console.log("[CONF/main] main-world.js pronto");

  /* ------------------------------------------------------------
     Canal genérico: atributo do DOM + evento (o que chegar primeiro)
     ------------------------------------------------------------ */
  function canal(evento, tratar) {
    const attr = "data-ext-ponte-" + evento;
    let visto = null;

    function processar(json) {
      if (!json || json === visto) return;   // nada novo
      visto = json;
      let payload = {};
      try { payload = JSON.parse(json) || {}; } catch (_) { return; }
      try { document.documentElement.setAttribute("data-ext-ack-" + evento, String(Date.now())); } catch (_) {}
      console.log("[CONF/main] " + evento + " processado:", payload.numero || payload.conta || "");
      try { tratar(payload); } catch (err) { console.error("[CONF/main] erro em " + evento + ":", err); }
    }

    document.addEventListener(evento, (e) => {
      let json = null;
      // 1) detail como string (primitivo — sempre legível entre worlds)
      try { if (e && typeof e.detail === "string" && e.detail) json = e.detail; } catch (_) {}
      // 2) fallback: o atributo que o content script acabou de escrever
      if (!json) { try { json = document.documentElement.getAttribute(attr); } catch (_) {} }
      processar(json);
    });

    // 3) rede de segurança: se o evento não atravessar worlds, o atributo
    //    sozinho resolve (o polling é barato e o valor só muda num pedido).
    setInterval(() => {
      try { processar(document.documentElement.getAttribute(attr)); } catch (_) {}
    }, 300);
  }

  /* ------------------------------------------------------------
     1. Suprimir a abertura AUTOMÁTICA do diálogo "Informação"
     O Desbravador chama `ExtratoContaController.exibeObservacaoDialog()`
     ao abrir o Extrato de Conta em certas UHs (→
     GET /extratoContaHospedagem/informacoes/<id> → #modalInformacao).
     O botão nativo "Informação" (#btn-exibir-informacoes) usa outro
     caminho (`_ajax`), por isso continua a funcionar.
     ------------------------------------------------------------ */
  (function instalarHookInformacao() {
    if (window.__extInfoHook) return;
    window.__extInfoHook = true;
    let atual = window.ExtratoContaController;

    function instalar(C) {
      if (!C) return;
      try { C.exibeObservacaoDialog = function () { /* suprimido pela extensão */ }; } catch (_) {}
    }

    if (atual) instalar(atual);
    try {
      Object.defineProperty(window, "ExtratoContaController", {
        configurable: true,
        enumerable: true,
        get: function () { return atual; },
        set: function (v) { atual = v; instalar(v); }
      });
    } catch (_) {}

    // rede de segurança limitada: reaplica por ~6s caso o app redefina o método
    let n = 0;
    const t = setInterval(() => {
      instalar(window.ExtratoContaController);
      if (++n >= 20) clearInterval(t);
    }, 300);
  })();

  /* ============================================================
     2. Lançamento de comandas (overlay no documento principal)
     ============================================================ */
  function toast(msg, erro) {
    const t = document.createElement("div");
    t.className = "ext-lanc-toast" + (erro ? " erro" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  function mostrarErro(overlay, raw) {
    try { if (typeof window.toDesmarcarCamposErroValidacaoComanda === "function") window.toDesmarcarCamposErroValidacaoComanda(); } catch (_) {}
    try { if (typeof window.toMarcarCamposErrosValidacaoComanda === "function") window.toMarcarCamposErrosValidacaoComanda({ responseText: raw }); } catch (_) {}
    const body = overlay.querySelector(".ext-lanc-body");
    if (!body) return;
    let banner = body.querySelector(".ext-lanc-error");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "ext-lanc-error";
      body.insertBefore(banner, body.firstChild);
    }
    banner.innerHTML = "<b>Não foi possível salvar o lançamento.</b>";
  }

  function salvar(overlay) {
    const form = overlay.querySelector("#lancamento-form");
    if (!form) return;
    try { if (typeof window.toAntesDeSalvar === "function") window.toAntesDeSalvar(); } catch (_) {}

    const btn = overlay.querySelector("#lancamento-btnSalvar");
    if (btn) { btn.style.pointerEvents = "none"; btn.style.opacity = "0.6"; }

    const body = (window.$ && typeof window.$.param === "function")
      ? window.$(form).serialize()
      : new URLSearchParams(new FormData(form)).toString();

    fetch("/lancamento/salvarLancamentos", {
      method: "POST",
      credentials: "include",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
      },
      body
    })
      .then((r) => r.text().then((t) => ({ ok: r.ok, text: t })))
      .then((res) => {
        if (res.ok) { overlay.remove(); toast("Lançamento salvo com sucesso."); }
        else { mostrarErro(overlay, res.text); }
      })
      .catch(() => mostrarErro(overlay, "Falha de conexão."))
      .finally(() => { if (btn && document.body.contains(btn)) { btn.style.pointerEvents = ""; btn.style.opacity = ""; } });
  }

  function aplicarContextoEtravarConta(body, d, conta) {
    const form = body.querySelector("#lancamento-form");
    if (!form) return;

    const item = (label, val) =>
      val ? '<span class="ext-lanc-ctx-item"><b>' + label + "</b>" + val + "</span>" : "";

    const ctx = document.createElement("div");
    ctx.className = "ext-lanc-context";
    ctx.innerHTML = item("UH", d.numero) + item("Tipo", d.tipo) + item("Reserva", d.reserva) +
      item("Saída", d.saida) + item("Hóspede", d.hospede);
    form.parentNode.insertBefore(ctx, form);

    // Trava o campo da conta (o contexto é a UH escolhida no mapa)
    const inp = body.querySelector("#lancamento-hospedagem");
    if (inp) { inp.readOnly = true; inp.style.pointerEvents = "none"; inp.style.background = "#fff"; inp.style.cursor = "default"; }
    [...body.querySelectorAll('.autocomplete[data-autocomplete-ref="lancamento-hospedagem"]')]
      .forEach((b) => { b.style.display = "none"; });

    const idInput = body.querySelector("#lancamento-hospedagem_input");
    if (idInput && String(idInput.value) !== String(conta)) {
      const aviso = document.createElement("div");
      aviso.className = "ext-lanc-aviso";
      aviso.textContent = "Atenção: a conta do formulário (" + idInput.value +
        ") difere da UH selecionada (" + conta + ").";
      form.parentNode.insertBefore(aviso, form);
    }
  }

  /* O modal abre com 1 item em branco — equivale a um clique em "Novo item"
     (`#btn-incluir-item-comanda` → `adicionaNovoItemComanda()`).
     A grelha pode ainda não estar inicializada, por isso confirma que a linha
     `#lancamento-item-1` apareceu e, se não aparecer, tenta novamente. */
  function adicionarItemInicial(body, tentativa = 0) {
    if (body.querySelector("#lancamento-item-1")) return;   // já lá está
    try {
      if (typeof window.adicionaNovoItemComanda === "function") {
        window.adicionaNovoItemComanda();
      } else {
        body.querySelector("#btn-incluir-item-comanda")?.click();
      }
    } catch (e) {
      console.warn("[CONF/main] item inicial falhou:", e);
    }
    if (!body.querySelector("#lancamento-item-1") && tentativa < 4) {
      setTimeout(() => adicionarItemInicial(body, tentativa + 1), 350);
    }
  }

  /* Prepara o campo do PDV, que é o PRIMEIRO input do modal: deixa-o FOCADO
     (e o texto selecionado, para se escrever por cima) — assim o primeiro
     input do utilizador cai logo no PDV.
     Se existir apenas UM PDV configurado, já o escolhe (não há nada a decidir).
     O campo é um autocomplete "force" cujo callback de seleção preenche
     `#comanda-pdv-id` (pdv.nome) e o oculto `#comanda-pdv-id_input` (pdv.id). */
  async function prepararPdv(body) {
    const el = body.querySelector("#comanda-pdv-id");
    if (!el) return;

    if (!el.value) {
      try {
        const r = await fetch("/pdv/autocomplete?term=", {
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest" }
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const lista = await r.json();
        const itens = Array.isArray(lista) ? lista : (lista && lista.items ? lista.items : []);
        console.log("[CONF/main] PDVs disponíveis:", itens.length,
          itens.map((p) => p.label).join(", "));

        if (itens.length === 1) {                     // único PDV: já fica escolhido
          const texto = String(itens[0].label != null ? itens[0].label : itens[0].value);
          const valor = String(itens[0].value != null ? itens[0].value : "");
          const oculto = body.querySelector("#comanda-pdv-id_input");
          const jq = window.jQuery;
          if (jq && jq(el).autocomplete) {
            try {
              const inst = jq(el).autocomplete("instance");
              if (inst && inst.options && typeof inst.options.select === "function") {
                jq(el).val(texto);
                inst.options.select.call(el, {}, { item: { value: valor, label: texto } });
              }
            } catch (e) { console.warn("[CONF/main] select do autocomplete falhou:", e); }
          }
          if (!el.value) el.value = texto;
          if (oculto && !oculto.value) oculto.value = valor;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          try { if (typeof window.defineUrlItensComanda === "function") window.defineUrlItensComanda(); } catch (_) {}
          console.log("[CONF/main] único PDV pré-selecionado:", texto);
        }
      } catch (e) {
        console.warn("[CONF/main] não foi possível ler a lista de PDV:", e);
      }
    }

    // Pronto para o primeiro input: focado, com o texto (se houver) selecionado.
    // O app foca o campo do ITEM quando a grelha de comandas acaba de carregar
    // (`toLoadComandas` é assíncrono), por isso reafirmamos o foco no PDV —
    // mas paramos assim que o utilizador interage (clique ou tecla) ou ao fim
    // de ~6s, para nunca lutar contra ele.
    const painel = body.closest(".ext-lanc-panel") || document;
    let interagiu = false;
    painel.addEventListener("mousedown", () => { interagiu = true; }, { once: true });
    document.addEventListener("keydown", () => { interagiu = true; }, { once: true });

    let n = 0;
    const focarPdv = () => {
      if (interagiu || ++n > 60) { clearInterval(relogio); return; }   // ~18s no máximo
      const a = document.activeElement;
      const idAtual = (a && a.id) || "";
      const livre = !a || a === document.body || a === el || idAtual.indexOf("lancamento-item") === 0;
      if (!livre) { clearInterval(relogio); return; }        // utilizador noutro campo
      try {
        el.focus();
        if (typeof el.setSelectionRange === "function" && el.value) el.setSelectionRange(0, el.value.length);
      } catch (_) {}
    };
    const relogio = setInterval(focarPdv, 300);
    focarPdv();
    console.log("[CONF/main] PDV pronto para o primeiro input. valor:", JSON.stringify(el.value));
  }

  function abrirLancamento(d) {
    d = d || {};
    const conta = d.conta;
    const numero = d.numero;
    if (!conta) { alert("Não foi possível identificar a conta de hospedagem desta UH."); return; }

    const overlay = document.createElement("div");
    overlay.className = "ext-lanc-overlay";
    overlay.innerHTML =
      '<div class="ext-lanc-panel">' +
        '<header class="ext-lanc-header">' +
          "<h3>Lançamento de Comandas — UH " + numero + "</h3>" +
          '<button class="ext-lanc-close" title="Fechar">×</button>' +
        "</header>" +
        '<div class="ext-lanc-body"><div class="ext-lanc-loading">Carregando…</div></div>' +
      "</div>";
    document.body.appendChild(overlay);

    const fechar = () => overlay.remove();
    overlay.querySelector(".ext-lanc-close").addEventListener("click", fechar);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(); });

    const body = overlay.querySelector(".ext-lanc-body");
    console.log("[CONF/main] overlay criado; a buscar /lancamento/hospedagem/" + conta);

    fetch("/lancamento/hospedagem/" + conta, {
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" }
    })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then((html) => {
        body.innerHTML = html;

        // Os <script> inline do partial não correm via innerHTML: extraímos
        // os valores e chamamos o inicializador do app à mão.
        const mId = html.match(/const\s+hospedagemId\s*=\s*(\d+)/);
        const mInd = html.match(/const\s+isIndividualizaLancamento\s*=\s*(true|false)/);
        const hospedagemId = mId ? mId[1] : conta;
        const individualiza = mInd ? mInd[1] === "true" : false;

        try {
          if (typeof window.toLoadComandas === "function") window.toLoadComandas(hospedagemId, individualiza);
        } catch (e) { console.error("[Conferência] Falha ao inicializar lançamento:", e); }

        aplicarContextoEtravarConta(body, d, conta);

        const btnSalvar = body.querySelector("#lancamento-btnSalvar");
        if (btnSalvar && window.$) {
          window.$(btnSalvar).off("click").on("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            salvar(overlay);
          });
        }

        // O modal já abre com 1 item em branco (equivale a 1 clique em
        // "Novo item") e com o PDV focado, pronto para o primeiro input.
        adicionarItemInicial(body);
        prepararPdv(body);
      })
      .catch((err) => {
        console.error("[CONF/main] fetch do lancamento falhou:", err);
        body.innerHTML = '<div class="ext-lanc-loading" style="color:#CA0806">Erro ao carregar o lançamento: ' +
          err.message + "</div>";
      });
  }

  canal("ext-lancar", abrirLancamento);

  /* ============================================================
     3. Navegação entre UHs (Extrato de Conta Hospedagem)
     ============================================================ */
  canal("ext-nav", (d) => {
    if (!d.conta) return;
    const url = "/extratoContaHospedagem/" + d.conta;
    if (window.AjaxController && typeof window.AjaxController.loadUrl === "function") {
      window.AjaxController.loadUrl(url);
    } else {
      window.location.hash = "#/extratoContaHospedagem/" + d.conta;
    }
  });
})();
