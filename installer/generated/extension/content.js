/* ============================================================
   Conferência de Comandas — Desbravador
   Content script: apenas ADICIONA botões ao popover nativo.
   Não altera layout, cores ou comportamento existente.
   ============================================================ */

(() => {
  "use strict";

  const STORAGE_KEY = "desbravador_conferencia_v1";
  const DEBUG = false;

  const log = (...a) => DEBUG && console.log("[Conferência]", ...a);

  /* ------------------------------------------------------------
     Todo o código que tem de correr no MAIN world vive em
     `main-world.js`, declarado no manifest com "world": "MAIN":
       - hook que suprime o diálogo automático "Informação";
       - bridge do modal de lançamento de comandas (ext-lancar);
       - bridge da navegação entre UHs (ext-nav).
     Porquê: daqui só o conseguiríamos injetar com um <script> inline,
     e esse script NÃO executa em todos os ambientes (o listener do
     main world nunca chegava a existir e o modal de lançamento não
     aparecia). O content script com world:"MAIN" é injetado pelo
     próprio Chrome e corre sempre. A comunicação é feita com
     `emitirParaMainWorld` (evento + atributo do DOM com o JSON).
     ------------------------------------------------------------ */

  /* ------------------------------------------------------------
     Persistência via chrome.storage.local
     ------------------------------------------------------------ */
  async function carregarConferencia() {
    return new Promise(res => {
      chrome.storage.local.get([STORAGE_KEY], r => {
        res(r[STORAGE_KEY] || {});
      });
    });
  }
  async function salvarConferencia(dados) {
    return new Promise(res => {
      chrome.storage.local.set({ [STORAGE_KEY]: dados }, res);
    });
  }

  /* ------------------------------------------------------------
     Extrato — a extensão é autossuficiente: busca o extrato
     direto no Desbravador (mesma origem + cookies da página) e
     parseia o HTML localmente. Não depende da Central local.
     ------------------------------------------------------------ */
  const URL_EXTRATO = "/extratoContaHospedagem";

  function parseMoeda(txt) {
    if (txt == null) return 0;
    const s = String(txt).replace(/[^\d,.-]/g, "");
    if (!s || s === "-" || s === "." || s === ",") return 0;
    const norm = s.includes(",") && s.includes(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(",", ".");
    const n = parseFloat(norm);
    return isNaN(n) ? 0 : n;
  }

  /* Lê o extrato (HTML) e separa comandas (extra) de diárias.
     Cada item é um <div id=div-lancamento-... class="extrato-div-comandas">
     com data-idlancamento, data-valor, data-quantidade, etc.
     Diária = descrição contém DIÁRIA/HOSPEDAGEM. */
  function parsearExtrato(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const comandas = [], diarias = [];

    doc.querySelectorAll(".extrato-div-comandas[id^='div-lancamento-']").forEach(el => {
      const data = el.dataset;
      const get = sel => el.querySelector(sel)?.textContent.trim() || "";

      const descricao = get(".label-item");
      const item = {
        id:        data.idlancamento || (el.id || "").replace(/^div-lancamento-/, "") || "",
        descricao: descricao.replace(/^\s*\d+\s*-\s*/, ""),
        comanda:   get(".label-comanda"),
        data:      get(".label-data"),
        pdv:       el.querySelector("[data-sigla-pdv]")?.dataset.siglaPdv || get(".label-pdv"),
        qtd:       parseInt(data.quantidade || "1", 10) || 1,
        valor:     parseMoeda(data.valor),
        total:     parseMoeda(data.total || data.valor),
        categoria: (data.categoria || "").toUpperCase(),
        cortesia:  (data.itemCortesia || "").toLowerCase() === "true"
      };

      const up = descricao.toUpperCase()
        .replace(/Á/g, "A").replace(/À/g, "A").replace(/Â/g, "A").replace(/Ã/g, "A")
        .replace(/É/g, "E").replace(/Ê/g, "E")
        .replace(/Í/g, "I")
        .replace(/Ó/g, "O").replace(/Ô/g, "O").replace(/Õ/g, "O")
        .replace(/Ú/g, "U");

      if (up.includes("DIARIA") || up.includes("HOSPEDAGEM")) {
        diarias.push(item);
      } else {
        comandas.push(item);
      }
    });

    // Ocupação: o próprio extrato traz "Tipo de Faturamento: Particular/Empresa".
    let ocupacao = null;
    const corpo = String(html || "");
    if (/particular/i.test(corpo)) ocupacao = "PARTICULAR";
    else if (/empresa|cnpj/i.test(corpo)) ocupacao = "EMPRESA";

    return { comandas, diarias, ocupacao };
  }

  async function buscarExtrato(reservaId) {
    if (!reservaId) throw new Error("Reserva não identificada nesta UH.");

    const headers = {
      "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "X-Requested-With": "XMLHttpRequest"
    };

    const r = await fetch(`${URL_EXTRATO}/${reservaId}`, {
      credentials: "include",
      headers
    });

    if (!r.ok) {
      throw new Error(`Falha ao buscar extrato (HTTP ${r.status}).`);
    }

    return parsearExtrato(await r.text());
  }

  /* ------------------------------------------------------------
     Compatibilidade: estados salvos antes da unificação usavam
     a chave "div-lancamento-<id>"; agora usamos apenas "<id>".
     ------------------------------------------------------------ */
  function estaConferida(estado, id) {
    const c = (estado && estado.comandas) || {};
    return Boolean(c[id] || c["div-lancamento-" + id]);
  }

  /* ------------------------------------------------------------
     A UH pode ser conferida?
     Somente as OCUPADAS: o card traz o atributo `state`
     (OCUPADA, LIVRE, LIMPEZA, MANUTENCAO...). Basta conter "OCUPADA".
     ------------------------------------------------------------ */
  function estaOcupada(uhEl) {
    const state = String(uhEl.getAttribute("state") || "").toUpperCase().trim();
    if (state) return state.includes("OCUPADA");
    // Fallback: o ícone carrega a classe icone-uh-<SITUACAO>
    const iconCls = uhEl.querySelector(".uh-icon")?.className || "";
    return /icone-uh-ocupada/i.test(iconCls);
  }

  /* ------------------------------------------------------------
     Extrai informações da UH a partir do DOM do card
     ------------------------------------------------------------ */
  function extrairInfoDaUH(uhEl) {
    const numero = uhEl.querySelector(".uh-footer span")?.textContent.replace(/\D/g, "") || "";
    const pop = uhEl.querySelector(".mapauh-main-popover");
    const reserva = pop?.querySelector("label[title^='Reserva']")?.textContent.match(/\d+/)?.[0] || "";
    const hospede = pop?.querySelector("label[title]:not([title^='Reserva']):not([title^='Saída'])")?.textContent.trim() || "";
    const saida   = pop?.querySelector("label[title^='Saída']")?.textContent.replace(/^Saída\s*/i, "").trim() || "";
    const tipo    = pop?.querySelector(".mapauh-popover-header b")?.textContent.match(/[A-Z]+/)?.[0] || "";
    // A conta de hospedagem (ID usado no extrato) fica no onclick do botão
    // nativo "Extrato de conta" (ex.: /extratoContaHospedagem/11601), NÃO no
    // label "Reserva" — reservas de grupo compartilham o mesmo número.
    const conta   = uhEl.querySelector("[id^='btn-extratoConta-']")?.getAttribute("onclick")?.match(/extratoContaHospedagem\/(\d+)/)?.[1] || "";
    return { uhId: uhEl.id, numero, reserva, hospede, saida, tipo, conta };
  }

  /* ------------------------------------------------------------
     Remove os botões/badges da extensão de uma UH.
     Usado quando a UH deixa de estar ocupada.
     ------------------------------------------------------------ */
  function removerBotoes(uhEl) {
    const footer = uhEl.querySelector(".mapauh-popover-footer");
    if (footer) {
      footer.querySelectorAll(".ext-conferir-wrap, .ext-lancar-wrap, .ext-sep")
        .forEach(el => el.remove());
    }
    const badgeCard = uhEl.querySelector(".ext-card-badge");
    if (badgeCard) badgeCard.remove();
  }

  /* ------------------------------------------------------------
     Injeta os 2 botões no popover nativo.
     Idempotente: se já injetado, apenas atualiza o badge.
     ------------------------------------------------------------ */
  async function injetarBotoes(uhEl) {
    if (!extAtiva) { removerBotoes(uhEl); return; }
    const footer = uhEl.querySelector(".mapauh-popover-footer");
    if (!footer) return;

    // Só injeta em UH ocupada. Livre, limpeza e manutenção ficam de fora.
    if (!estaOcupada(uhEl)) {
      console.log("[Conferência] UH", extrairInfoDaUH(uhEl).numero,
                  "state =", JSON.stringify(uhEl.getAttribute("state")),
                  "— não é OCUPADA, botões não injetados.");
      removerBotoes(uhEl);
      return;
    }
    console.log("[Conferência] UH", extrairInfoDaUH(uhEl).numero,
                "state =", JSON.stringify(uhEl.getAttribute("state")),
                "— ocupada, injetando botões.");

    // Já injetado? Só atualiza badge e sai
    if (footer.querySelector(".ext-conferir-wrap")) {
      await atualizarBadge(footer, uhEl);
      return;
    }

    // -------- Botão "Conferir comandas" --------
    const wrapConf = document.createElement("div");
    wrapConf.className = "div-btn-popover-grande ext-conferir-wrap";
    wrapConf.innerHTML = `
      <a class="btn btn-popover-grande ext-conferir no-padding" href="javascript:void(0)"
         title="Conferir comandas">
        <i class="ace-icon fa fa-check-square-o"></i>
        <span>Conferir comandas</span>
        <span class="ext-badge" data-badge></span>
      </a>`;
    wrapConf.querySelector("a").addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      abrirModalConferencia(uhEl);
    });

    // -------- Botão "Lançar comandas" --------
    const wrapLanc = document.createElement("div");
    wrapLanc.className = "div-btn-popover-grande ext-lancar-wrap";
    wrapLanc.innerHTML = `
      <a class="btn btn-popover-grande ext-lancar no-padding" href="javascript:void(0)"
         title="Lançar comandas">
        <i class="ace-icon fa icon-popup_uh_lancar_comanda"></i>
        <span>Lançar comandas</span>
      </a>`;
    wrapLanc.querySelector("a").addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      abrirModalLancamento(uhEl);
    });

    // Insere ANTES do botão nativo "Extrato de conta".
    // Usa .before() (no lugar de footer.insertBefore) porque o botão
    // nativo pode estar aninhado num <div> intermediário, e .before()
    // insere no pai correto independentemente da profundidade.
    const btnNativo = footer.querySelector(".div-btn-popover-grande:not(.ext-conferir-wrap):not(.ext-lancar-wrap)");
    if (btnNativo) {
      const sep = document.createElement("div");
      sep.className = "space-btns-border ext-sep";
      btnNativo.before(wrapLanc, wrapConf, sep);
    } else {
      footer.appendChild(wrapLanc);
      footer.appendChild(wrapConf);
    }

    await atualizarBadge(footer, uhEl);
  }

  /* ------------------------------------------------------------
     Atualiza o badge no botão (e opcionalmente no card)
     ------------------------------------------------------------ */
  async function atualizarBadge(footer, uhEl) {
    const conf = await carregarConferencia();
    const info = extrairInfoDaUH(uhEl);
    const c = conf[info.numero];
    const badge = footer.querySelector("[data-badge]");
    if (!badge) return;

    if (!c) {
      badge.textContent = "";
      badge.className = "ext-badge";
      atualizarBadgeNoCard(uhEl, null, 0, 0);
      return;
    }

    const total = c.total || 0;
    const ok = Object.values(c.comandas || {}).filter(Boolean).length;
    const pend = total - ok;

    if (c.status === "ok") {
      badge.className = "ext-badge ok"; badge.textContent = "✓";
    } else if (c.status === "divergente") {
      badge.className = "ext-badge div"; badge.textContent = `⚠ ${pend}`;
    } else if (pend > 0) {
      badge.className = "ext-badge pend"; badge.textContent = pend;
    } else {
      badge.className = "ext-badge"; badge.textContent = "";
    }

    atualizarBadgeNoCard(uhEl, c.status, total, ok);
  }

  /* ------------------------------------------------------------
     Badge no card da UH (canto do ícone)
     ------------------------------------------------------------ */
  function atualizarBadgeNoCard(uhEl, status, total, okCount) {
    const icon = uhEl.querySelector(".uh-icon") || uhEl.querySelector(".conteudo-draggeable");
    if (!icon) return;
    if (getComputedStyle(icon).position === "static") {
      icon.style.position = "relative";
    }

    let badge = icon.querySelector(".ext-card-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "ext-card-badge";
      icon.appendChild(badge);
    }

    if (!status) {
      badge.textContent = "";
      badge.className = "ext-card-badge";
      return;
    }

    const pend = total - okCount;
    if (status === "ok") {
      badge.className = "ext-card-badge ok"; badge.textContent = "✓";
    } else if (status === "divergente") {
      badge.className = "ext-card-badge div"; badge.textContent = `⚠ ${pend}`;
    } else if (pend > 0) {
      badge.className = "ext-card-badge pend"; badge.textContent = pend;
    } else {
      badge.textContent = ""; badge.className = "ext-card-badge";
    }
  }

  /* ------------------------------------------------------------
     Modal (Shadow DOM — CSS isolado)
     ------------------------------------------------------------ */
  const MODAL_CSS = `
    *{box-sizing:border-box;font-family:Roboto,"Open Sans",sans-serif}
    .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);
      display:flex;align-items:center;justify-content:center;z-index:2147483647}
    .modal{background:#fff;border-radius:8px;width:min(900px,94vw);
      max-height:92vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.3);
      font-size:13px;color:#393939}
    .header{display:flex;justify-content:space-between;align-items:center;
      padding:14px 18px;border-bottom:1px solid #e9ecef;position:sticky;top:0;
      background:#fff;z-index:2}
    .header h2{margin:0;font-size:16px;color:#0684c6}
    .close{border:0;background:transparent;font-size:24px;cursor:pointer;color:#868e96;line-height:1}
    .info{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;
      padding:12px 18px;background:#f8f9fa;font-size:13px}
    .abas{display:flex;gap:4px;padding:8px 18px 0;border-bottom:1px solid #e9ecef}
    .aba{border:0;background:transparent;padding:8px 14px;font-size:13px;cursor:pointer;
      color:#868e96;border-bottom:2px solid transparent}
    .aba.ativa{color:#0684c6;border-bottom-color:#0684c6;font-weight:600}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{padding:8px 10px;border-bottom:1px solid #f1f3f5;text-align:left}
    th{background:#f8f9fa;font-weight:600;color:#495057;position:sticky;top:58px;z-index:1}
    tr.ok td{background:#f1fdf4}
    tr.div td{background:#fff5f5}
    input[type=checkbox]{transform:scale(1.2);cursor:pointer}
    .tag{background:#fff3bf;color:#946200;font-size:10px;padding:2px 6px;
      border-radius:4px;margin-left:6px;font-weight:700}
    .pdv{display:inline-block;background:#e9ecef;color:#495057;font-size:10px;
      padding:2px 6px;border-radius:4px;font-weight:700}
    .vazio{text-align:center;color:#adb5bd;padding:24px}
    .obs{padding:12px 18px}
    .obs label{display:block;font-size:12px;color:#868e96;margin-bottom:4px}
    .obs textarea{width:100%;border:1px solid #ced4da;border-radius:4px;
      padding:6px;font-size:13px;resize:vertical}
    .footer{padding:12px 18px;display:flex;gap:8px;justify-content:flex-end;
      border-top:1px solid #e9ecef;position:sticky;bottom:0;background:#fff}
    .prim{padding:8px 14px;border-radius:5px;font-size:13px;cursor:pointer;
      background:#0684c6;color:#fff;border:1px solid #0684c6;font-weight:500}
    .prim:hover{background:#00679d}
    .sec{padding:8px 14px;border-radius:5px;font-size:13px;cursor:pointer;
      background:#f8f9fa;color:#495057;border:1px solid #ced4da;font-weight:500}
    .sec:hover{background:#e9ecef}
    .loading{padding:40px;text-align:center;color:#868e96}
  `;

  async function abrirModalConferencia(uhEl) {
    if (!extAtiva) return;
    const info = extrairInfoDaUH(uhEl);

    // Cria host + shadow
    const host = document.createElement("div");
    host.id = "ext-conferencia-host";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    // Estado inicial: carregando
    shadow.innerHTML = `
      <style>${MODAL_CSS}</style>
      <div class="backdrop">
        <div class="modal">
          <div class="loading">Buscando extrato da UH ${info.numero}…</div>
        </div>
      </div>`;

    const fechar = () => host.remove();
    shadow.querySelector(".backdrop").addEventListener("click", e => {
      if (e.target.classList.contains("backdrop")) fechar();
    });

    // Busca extrato
    let dados;
    try {
      dados = await buscarExtrato(info.conta || info.reserva);
    } catch (err) {
      shadow.querySelector(".loading").innerHTML =
        `<span style="color:#CA0806">Erro: ${err.message}</span><br><br>
         <button class="sec" id="fechar-erro">Fechar</button>`;
      shadow.querySelector("#fechar-erro").addEventListener("click", fechar);
      return;
    }

    // Carrega estado persistido
    const conf = await carregarConferencia();
    const estado = conf[info.numero] || { comandas: {}, obs: "", total: dados.comandas.length };

    // Renderiza o modal completo
    shadow.innerHTML = `
      <style>${MODAL_CSS}</style>
      <div class="backdrop">
        <div class="modal">
          <header class="header">
            <h2>Conferência UH ${info.numero}${info.tipo ? " · " + info.tipo : ""}${info.hospede ? " · " + info.hospede : ""}</h2>
            <button class="close">×</button>
          </header>
          <div class="info">
            <div><b>Reserva:</b> ${info.reserva || "—"}</div>
            <div><b>Saída:</b> ${info.saida || "—"}</div>
            <div><b>Ocupação:</b> ${dados.ocupacao || "—"}</div>
            <div><b>Total comandas:</b> ${dados.comandas.length}</div>
          </div>
          <div class="abas">
            <button class="aba ativa" data-aba="comandas">Comandas (${dados.comandas.length})</button>
            <button class="aba" data-aba="diarias">Diárias (${dados.diarias.length})</button>
          </div>
          <div class="painel" data-painel="comandas">
            <table>
              <thead><tr>
                <th style="width:40px">✓</th>
                <th style="width:90px">N° Comanda</th>
                <th>Descrição</th>
                <th style="width:50px">Qtd</th>
                <th style="width:70px">PDV</th>
                <th style="width:100px">Valor</th>
                <th style="width:110px">Data</th>
                <th style="width:110px">Status</th>
              </tr></thead>
              <tbody>
                ${dados.comandas.length ? dados.comandas.map(c => `
                  <tr data-cid="${c.id}">
                    <td><input type="checkbox" class="chk" data-cid="${c.id}" ${estaConferida(estado, c.id) ? "checked" : ""}></td>
                    <td>${c.comanda || "—"}</td>
                    <td>${c.descricao}${c.cortesia ? ' <span class="tag">CORTESIA</span>' : ""}</td>
                    <td>${c.qtd}</td>
                    <td><span class="pdv">${c.pdv || "—"}</span></td>
                    <td>R$ ${c.valor.toFixed(2)}</td>
                    <td>${c.data}</td>
                    <td class="cel-status"></td>
                  </tr>`).join("")
                  : `<tr><td colspan="8" class="vazio">Nenhuma comanda lançada.</td></tr>`}
              </tbody>
            </table>
          </div>
          <div class="painel" data-painel="diarias" style="display:none">
            <table>
              <thead><tr><th>Descrição</th><th style="width:60px">Qtd</th>
                <th style="width:100px">Valor</th><th style="width:150px">Data</th></tr></thead>
              <tbody>
                ${dados.diarias.length ? dados.diarias.map(d => `
                  <tr><td>${d.descricao}</td><td>${d.qtd}</td>
                    <td>R$ ${d.valor.toFixed(2)}</td><td>${d.data}</td></tr>`).join("")
                  : `<tr><td colspan="4" class="vazio">Nenhuma diária faturada.</td></tr>`}
              </tbody>
            </table>
          </div>
          <div class="obs">
            <label>Observações</label>
            <textarea rows="2" placeholder="Ex: comanda X não localizada...">${estado.obs || ""}</textarea>
          </div>
          <footer class="footer">
            <button class="sec" data-acao="marcar-todas">Marcar todas OK</button>
            <button class="sec" data-acao="desmarcar">Desmarcar</button>
            <button class="prim" data-acao="salvar">Salvar conferência</button>
          </footer>
        </div>
      </div>`;

    // ----- Handlers -----
    shadow.querySelector(".close").addEventListener("click", fechar);
    shadow.querySelector(".backdrop").addEventListener("click", e => {
      if (e.target.classList.contains("backdrop")) fechar();
    });

    shadow.querySelectorAll(".aba").forEach(btn => {
      btn.addEventListener("click", () => {
        shadow.querySelectorAll(".aba").forEach(b => b.classList.remove("ativa"));
        btn.classList.add("ativa");
        shadow.querySelectorAll(".painel").forEach(p => {
          p.style.display = p.dataset.painel === btn.dataset.aba ? "" : "none";
        });
      });
    });

    const atualizarLinha = tr => {
      const chk = tr.querySelector(".chk");
      if (!chk) return;
      tr.classList.toggle("ok", chk.checked);
      tr.classList.toggle("div", !chk.checked);
      const cel = tr.querySelector(".cel-status");
      if (cel) cel.textContent = chk.checked ? "✅ OK" : "⚠️ pendente";
    };
    shadow.querySelectorAll("tr[data-cid]").forEach(atualizarLinha);
    shadow.querySelectorAll(".chk").forEach(chk => {
      chk.addEventListener("change", () => atualizarLinha(chk.closest("tr")));
    });

    shadow.querySelector("[data-acao='marcar-todas']").addEventListener("click", () => {
      shadow.querySelectorAll(".chk").forEach(c => c.checked = true);
      shadow.querySelectorAll("tr[data-cid]").forEach(atualizarLinha);
    });
    shadow.querySelector("[data-acao='desmarcar']").addEventListener("click", () => {
      shadow.querySelectorAll(".chk").forEach(c => c.checked = false);
      shadow.querySelectorAll("tr[data-cid]").forEach(atualizarLinha);
    });

    shadow.querySelector("[data-acao='salvar']").addEventListener("click", async () => {
      const comandas = {};
      shadow.querySelectorAll(".chk").forEach(c => comandas[c.dataset.cid] = c.checked);

      const total = dados.comandas.length;
      const okCount = Object.values(comandas).filter(Boolean).length;
      const status = total === 0 ? "ok"
                   : okCount === total ? "ok"
                   : okCount === 0 ? "pendente" : "divergente";

      const todas = await carregarConferencia();
      todas[info.numero] = {
        status, comandas,
        obs: shadow.querySelector("textarea").value,
        total,
        reserva: info.reserva,
        ts: new Date().toISOString()
      };
      await salvarConferencia(todas);

      // Atualiza UI
      const footer = uhEl.querySelector(".mapauh-popover-footer");
      if (footer) await atualizarBadge(footer, uhEl);
      atualizarEstatisticasSidebar();
      notificarResumo(todas);

      fechar();
    });
  }

  /* ------------------------------------------------------------
     Modal de Lançamento de Comandas
     Overlay no documento principal (SEM Shadow DOM) para reutilizar
     o form nativo do Desbravador — assim o usuário não sai do Mapa de UHs.
     ------------------------------------------------------------ */
  const LANCAMENTO_CSS = `
    .ext-lanc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);
      z-index:1045;display:flex;align-items:center;justify-content:center}
    .ext-lanc-panel{background:#fff;width:min(1240px,96vw);max-height:94vh;
      display:flex;flex-direction:column;border-radius:6px;overflow:hidden;
      box-shadow:0 12px 44px rgba(0,0,0,.35)}
    .ext-lanc-header{display:flex;justify-content:space-between;align-items:center;
      padding:12px 18px;border-bottom:1px solid #e9ecef;background:#fff;flex:0 0 auto}
    .ext-lanc-header h3{margin:0;font-size:16px;color:#393939;font-weight:600}
    .ext-lanc-close{border:0;background:transparent;font-size:24px;line-height:1;
      cursor:pointer;color:#868e96}
    .ext-lanc-body{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;background:#fff;padding:0}
    .ext-lanc-loading{padding:40px;text-align:center;color:#868e96}
    .ext-lanc-error{margin:12px 18px;padding:10px 14px;background:#fff5f5;
      border:1px solid #f5c6cb;color:#721c24;border-radius:4px;font-size:13px}
    .ext-lanc-toast{position:fixed;bottom:24px;right:24px;background:#40C057;color:#fff;
      padding:10px 16px;border-radius:6px;z-index:9999;box-shadow:0 2px 10px rgba(0,0,0,.25);
      font-size:14px}
    .ext-lanc-toast.erro{background:#CA0806}
    .ext-lanc-context{display:flex;flex-wrap:wrap;gap:4px 22px;padding:9px 18px;
      background:#f8f9fa;border-bottom:1px solid #e9ecef;font-size:12px;color:#2c3e50}
    .ext-lanc-context .ext-lanc-ctx-item{white-space:nowrap;max-width:420px;overflow:hidden;
      text-overflow:ellipsis}
    .ext-lanc-context b{color:#868e96;font-weight:600;text-transform:uppercase;font-size:10px;
      letter-spacing:.4px;margin-right:5px}
    .ext-lanc-aviso{margin:0;padding:9px 18px;background:#fff3bf;border-bottom:1px solid #ffe08a;
      color:#8a6d1b;font-size:12px;font-weight:600}
  `;

  let _lancCssInjetado = false;
  function garantirCssLancamento() {
    if (_lancCssInjetado || document.getElementById("ext-lanc-css")) return;
    const st = document.createElement("style");
    st.id = "ext-lanc-css";
    st.textContent = LANCAMENTO_CSS;
    document.head.appendChild(st);
    _lancCssInjetado = true;
  }

  /* ------------------------------------------------------------
     PONTE isolated world -> main world.
     O `detail` de um CustomEvent NÃO é fiável entre worlds: um objeto criado
     no isolated world pode ser ilegível (ou lançar exceção) quando o main
     world o lê — foi o que fez o modal de lançamento deixar de aparecer no
     navegador real, apesar de funcionar no harness (que corre tudo no MESMO
     world). Por isso o payload viaja em JSON num ATRIBUTO do DOM (o DOM é
     partilhado pelos dois worlds) e também no `detail` como string, que é um
     primitivo e por isso sempre legível. O evento serve apenas de sinal.
     ------------------------------------------------------------ */
  /* Cada pedido leva um id único (`_req`) no payload: sem isso, dois pedidos
     iguais (ex.: clicar duas vezes em "Lançar comandas" na mesma UH) seriam
     tratados como o mesmo e o segundo era ignorado pelo dedupe do canal. */
  let _ponteSeq = 0;
  function emitirParaMainWorld(nome, payload) {
    let json = "{}";
    try {
      const dados = Object.assign({}, payload || {});
      dados._req = ++_ponteSeq + "@" + Date.now();
      json = JSON.stringify(dados);
    } catch (_) { json = "{}"; }
    try { document.documentElement.setAttribute("data-ext-ponte-" + nome, json); } catch (_) {}
    document.dispatchEvent(new CustomEvent(nome, { detail: json }));
  }

  /* ⚠️ OBSOLETO (não usado, não injetado): o modal de lançamento passou a
     correr em `main-world.js`, declarado no manifest com world:"MAIN" — um
     <script> inline injetado a partir daqui não executa em todos os
     ambientes e deixava o modal por abrir. Fica só até ser removido.
     ------------------------------------------------------------ */
  const LANCAMENTO_MAIN_WORLD_OBSOLETO = [
    "(() => {",
    "  'use strict';",
    "  if (window.__extLancamentoInjetado) return;",
    "  window.__extLancamentoInjetado = true;",
    "  console.log('[CONF/main] bridge de lancamento instalado no main world');",
    "",
    "  /* Payload vindo do content script (isolated world). O `detail` pode ser",
    "     ilegível entre worlds, por isso tentamos: detail em JSON (string) ->",
    "     atributo data-ext-ponte-* no <html> -> detail cru (modo mesmo world). */",
    "  function extPayload(e) {",
    "    try { if (e && typeof e.detail === 'string' && e.detail) return JSON.parse(e.detail); } catch (_) {}",
    "    try { var raw = document.documentElement.getAttribute('data-ext-ponte-ext-lancar'); if (raw) return JSON.parse(raw); } catch (_) {}",
    "    try { return (e && e.detail) || {}; } catch (_) { return {}; }",
    "  }",
    "",
    "  function toast(msg, erro) {",,
    "    var t = document.createElement('div');",
    "    t.className = 'ext-lanc-toast' + (erro ? ' erro' : '');",
    "    t.textContent = msg;",
    "    document.body.appendChild(t);",
    "    setTimeout(function(){ t.remove(); }, 3500);",
    "  }",
    "",
    "  function mostrarErro(overlay, raw) {",
    "    try { if (typeof window.toDesmarcarCamposErroValidacaoComanda === 'function') window.toDesmarcarCamposErroValidacaoComanda(); } catch(e){}",
    "    try { if (typeof window.toMarcarCamposErrosValidacaoComanda === 'function') window.toMarcarCamposErrosValidacaoComanda({ responseText: raw }); } catch(e){}",
    "    var body = overlay.querySelector('.ext-lanc-body');",
    "    if (!body) return;",
    "    var banner = body.querySelector('.ext-lanc-error');",
    "    if (!banner) { banner = document.createElement('div'); banner.className = 'ext-lanc-error'; body.insertBefore(banner, body.firstChild); }",
    "    banner.innerHTML = '<b>Não foi possível salvar o lançamento.</b>';",
    "  }",
    "",
    "  function salvar(overlay) {",
    "    var form = overlay.querySelector('#lancamento-form');",
    "    if (!form) return;",
    "    try { if (typeof window.toAntesDeSalvar === 'function') window.toAntesDeSalvar(); } catch(e){}",
    "    var btn = overlay.querySelector('#lancamento-btnSalvar');",
    "    if (btn) { btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }",
    "    var body = (window.$ && typeof window.$.param === 'function')",
    "      ? window.$(form).serialize()",
    "      : new URLSearchParams(new FormData(form)).toString();",
    "    fetch('/lancamento/salvarLancamentos', {",
    "      method: 'POST',",
    "      credentials: 'include',",
    "      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },",
    "      body: body",
    "    })",
    "      .then(function(r){ return r.text().then(function(t){ return { ok: r.ok, text: t }; }); })",
    "      .then(function(res){",
    "        if (res.ok) { overlay.remove(); toast('Lançamento salvo com sucesso.'); }",
    "        else { mostrarErro(overlay, res.text); }",
    "      })",
    "      .catch(function(){ mostrarErro(overlay, 'Falha de conexão.'); })",
    "      .finally(function(){ if (btn && document.body.contains(btn)) { btn.style.pointerEvents=''; btn.style.opacity=''; } });",
    "  }",
    "",
    "  function aplicarContextoEtravarConta(body, d, conta) {",
    "    var form = body.querySelector('#lancamento-form');",
    "    if (!form) return;",
    "    var item = function (label, val) { return val ? '<span class=\"ext-lanc-ctx-item\"><b>' + label + '</b>' + val + '</span>' : ''; };",
    "    var ctx = document.createElement('div');",
    "    ctx.className = 'ext-lanc-context';",
    "    ctx.innerHTML = item('UH', d.numero) + item('Tipo', d.tipo) + item('Reserva', d.reserva) + item('Saída', d.saida) + item('Hóspede', d.hospede);",
    "    form.parentNode.insertBefore(ctx, form);",
    "    var cab = body.querySelector('#div-lancamento-comanda-cabecalho');",
    "    var row = cab && cab.querySelector('.row');",
    "    if (row) {",
    "      [].slice.call(row.children).forEach(function (ch) {",
    "        if (ch.querySelector && ch.querySelector('#lancamento-tipoLancamento')) ch.style.display = 'none';",
    "        if (ch.id === 'div-lancamento-hospedagem') ch.className = 'col-sm-12';",
    "      });",
    "    }",
    "    var inp = body.querySelector('#lancamento-hospedagem');",
    "    if (inp) { inp.readOnly = true; inp.style.pointerEvents = 'none'; inp.style.background = '#fff'; inp.style.cursor = 'default'; }",
    "    [].slice.call(body.querySelectorAll('.autocomplete[data-autocomplete-ref=\"lancamento-hospedagem\"]')).forEach(function (b) { b.style.display = 'none'; });",
    "    var idInput = body.querySelector('#lancamento-hospedagem_input');",
    "    if (idInput && String(idInput.value) !== String(conta)) {",
    "      var aviso = document.createElement('div');",
    "      aviso.className = 'ext-lanc-aviso';",
    "      aviso.textContent = 'Atenção: a conta do formulário (' + idInput.value + ') difere da UH selecionada (' + conta + ').';",
    "      form.parentNode.insertBefore(aviso, form);",
    "    }",
    "  }",
    "",
    "  function abrir(d) {",
    "    d = d || {};",
    "    var conta = d.conta, numero = d.numero;",
    "    if (!conta) { alert('Não foi possível identificar a conta de hospedagem desta UH.'); return; }",
    "    var overlay = document.createElement('div');",
    "    overlay.className = 'ext-lanc-overlay';",    "    overlay.innerHTML = '<div class=\"ext-lanc-panel\"><header class=\"ext-lanc-header\"><h3>Lançamento de Comandas — UH ' + numero + '</h3><button class=\"ext-lanc-close\" title=\"Fechar\">×</button></header><div class=\"ext-lanc-body\"><div class=\"ext-lanc-loading\">Carregando…</div></div></div>';",
    "    document.body.appendChild(overlay);",
    "    var fechar = function(){ overlay.remove(); };",
    "    overlay.querySelector('.ext-lanc-close').addEventListener('click', fechar);",
    "    overlay.addEventListener('click', function(e){ if (e.target === overlay) fechar(); });",
    "    var body = overlay.querySelector('.ext-lanc-body');",
    "    console.log('[CONF/main] overlay criado; a buscar /lancamento/hospedagem/' + conta);",
    "    fetch('/lancamento/hospedagem/' + conta, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })",
    "      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })",
    "      .then(function(html){",
    "        body.innerHTML = html;",
    "        var mId = html.match(/const\\s+hospedagemId\\s*=\\s*(\\d+)/);",
    "        var mInd = html.match(/const\\s+isIndividualizaLancamento\\s*=\\s*(true|false)/);",
    "        var hospedagemId = mId ? mId[1] : conta;",
    "        var individualiza = mInd ? mInd[1] === 'true' : false;",
    "        try { if (typeof window.toLoadComandas === 'function') window.toLoadComandas(hospedagemId, individualiza); } catch(e){ console.error('[Conferência] Falha ao inicializar lançamento:', e); }",
    "        aplicarContextoEtravarConta(body, d, conta);",
    "        var btnSalvar = body.querySelector('#lancamento-btnSalvar');",
    "        if (btnSalvar && window.$) { window.$(btnSalvar).off('click').on('click', function(e){ e.preventDefault(); e.stopPropagation(); salvar(overlay); }); }",
    "      })",
    "      .catch(function(err){ console.error('[CONF/main] fetch do lancamento falhou:', err); body.innerHTML = '<div class=\"ext-lanc-loading\" style=\"color:#CA0806\">Erro ao carregar o lançamento: ' + err.message + '</div>'; });",
    "  }",
    "",
    "  document.addEventListener('ext-lancar', function(e){",
    "    var d = extPayload(e);",
    "    console.log('[CONF/main] ext-lancar recebido: UH ' + d.numero + ' / conta ' + d.conta);",
    "    abrir(d);",
    "  });",
    "})();"
  ].join("\n");

  /* (o array acima é OBSOLETO e já não é usado nem injetado: a implementação
     canónica do modal de lançamento está em `main-world.js`.) */

  async function abrirModalLancamento(uhEl) {
    if (!extAtiva) return;
    const info = extrairInfoDaUH(uhEl);
    console.log("[CONF] abrirModalLancamento — UH", info.numero, "conta", info.conta, "reserva", info.reserva);
    if (!info.conta) {
      alert("Não foi possível identificar a conta de hospedagem desta UH.");
      return;
    }
    garantirCssLancamento();
    // O modal em si roda no MAIN world (`main-world.js`, world "MAIN"):
    // precisa de toLoadComandas/jQuery/globals do Desbravador. O payload
    // vai em JSON (ver emitirParaMainWorld) — não passar objetos no
    // `detail`, que não são legíveis entre worlds.
    emitirParaMainWorld("ext-lancar", {
      conta: info.conta,
      numero: info.numero,
      reserva: info.reserva,
      hospede: info.hospede,
      saida: info.saida,
      tipo: info.tipo
    });
    // Confirmação do outro lado (o main world marca data-ext-ack-*)
    setTimeout(() => {
      const ack = document.documentElement.getAttribute("data-ext-ack-ext-lancar");
      console.log("[CONF] main world respondeu:", ack ? "OK" : "SEM RESPOSTA");
    }, 1500);
  }

  /* ------------------------------------------------------------
     Navegação entre UHs no Extrato de Conta Hospedagem
     (inspirado no userscript "Desbravador Helper", porém)
     - sem polling (hashchange + MutationObserver)
     - lista de UHs persistida em chrome.storage.local
     - UI nativa integrada ao cabeçalho da página
     ------------------------------------------------------------ */
  const UH_KEY = "desbravador_uhs_v1";
  let uhs = [];

  function estaNoExtrato() {
    return (window.location.hash || "").includes("extratoContaHospedagem");
  }
  function estaNoMapa() {
    return (window.location.hash || "").includes("/mapaUh/");
  }
  function contaAtualExtrato() {
    const m = (window.location.hash || "").match(/extratoContaHospedagem\/(\d+)/);
    return m ? m[1] : null;
  }
  function indexUHAtual() {
    const conta = contaAtualExtrato();
    if (!conta || !uhs.length) return -1;
    return uhs.findIndex(u => u.conta === conta);
  }

  function coletarUHs() {
    if (!(window.location.hash || "").includes("/mapaUh/")) return;
    const lista = [];
    document.querySelectorAll(".uh-main[id^='uh-main-']").forEach(uhEl => {
      const info = extrairInfoDaUH(uhEl);
      if (info.numero && info.conta) {
        lista.push({ numero: info.numero, conta: info.conta, ocupada: estaOcupada(uhEl) });
      }
    });
    if (lista.length) {
      uhs = lista;
      try { chrome.storage.local.set({ [UH_KEY]: lista }); } catch (_) {}
      log("UHs coletadas:", lista.length);
    }
    injetarCheckboxesUH();
    atualizarNavUH();
    atualizarEstatisticasSidebar();
  }

  async function carregarUHsStorage() {
    try {
      const r = await new Promise(res => chrome.storage.local.get([UH_KEY], res));
      if (Array.isArray(r[UH_KEY]) && r[UH_KEY].length && !uhs.length) {
        uhs = r[UH_KEY];
      }
    } catch (_) {}
  }

  /* ------------------------------------------------------------
     Main world: navegação nativa via AjaxController.loadUrl.
     O código corre em `main-world.js` (world: "MAIN") e é acionado
     pelo evento `ext-nav` (JSON via emitirParaMainWorld).
     ------------------------------------------------------------ */
  function irParaConta(conta) {
    if (!conta) return;
    console.log("[CONF] ext-nav enviado para conta", conta);
    emitirParaMainWorld("ext-nav", { conta });
  }
  function uhProxima() {
    const i = indexUHAtual();
    if (i >= 0 && i < uhs.length - 1) irParaConta(uhs[i + 1].conta);
  }
  function uhAnterior() {
    const i = indexUHAtual();
    if (i > 0) irParaConta(uhs[i - 1].conta);
  }

  /* ------------------------------------------------------------
     UI nativa no cabeçalho (.div-titulo-conteudo)
     Barra única: [toggle da extensão] [navegação de UHs]
     ------------------------------------------------------------ */
  function garantirHeaderBar() {
    const header = document.querySelector(".div-titulo-conteudo");
    if (!header) return null;
    let bar = document.getElementById("ext-header-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "ext-header-bar";
      bar.style.cssText = "position:absolute; right:calc(60% + 12px); top:50%;" +
        " transform:translateY(-50%); display:flex; align-items:center;" +
        " gap:8px; z-index:1031; line-height:normal;";
      header.appendChild(bar);
    }
    return bar;
  }

  /* ------------------------------------------------------------
     Toggle mestre da extensão (ativa/desativa toda a UI injetada)

     O "Modo conferência" começa SEMPRE DESATIVADO ao abrir a página —
     o utilizador ativa-o deliberadamente no Mapa de UHs. Por isso o
     estado NÃO é persistido em chrome.storage.
     ------------------------------------------------------------ */
  let extAtiva = false;

  function atualizarBotaoToggle() {
    const btn = document.getElementById("ext-toggle");
    if (!btn) return;
    if (extAtiva) {
      btn.className = "btn btn-xs btn-white btn-info";
      btn.title = "Modo conferência ativo — clique para desativar";
      btn.innerHTML = '<i class="ace-icon fa fa-toggle-on"></i><span>Modo conferência</span>';
    } else {
      btn.className = "btn btn-xs btn-white";
      btn.title = "Modo conferência desativado — clique para ativar";
      btn.innerHTML = '<i class="ace-icon fa fa-toggle-off grey"></i><span class="grey">Modo conferência</span>';
    }
  }

  /* O toggle só é exibido/utilizável no Mapa de UHs */
  function atualizarVisibilidadeToggle() {
    const btn = document.getElementById("ext-toggle");
    if (!btn) return;
    const noMapa = estaNoMapa();
    btn.style.display = noMapa ? "inline-flex" : "none";
    btn.disabled = !noMapa;
  }

  function injetarToggleExtensao() {
    const bar = garantirHeaderBar();
    if (!bar || document.getElementById("ext-toggle")) return;
    const btn = document.createElement("button");
    btn.id = "ext-toggle";
    btn.type = "button";
    btn.style.cssText = "display:inline-flex; align-items:center; gap:5px; white-space:nowrap; order:2;";
    btn.addEventListener("click", alternarExtensao);
    bar.appendChild(btn);
    atualizarBotaoToggle();
    atualizarVisibilidadeToggle();
  }

  /* ------------------------------------------------------------
     Barra lateral "Modo conferência" (somente no Mapa de UHs).
     Pode ser recolhida e reaberta por um botão discreto na borda.
     ------------------------------------------------------------ */
  let sidebarAberto = false;

  /* Data de check-out: valor padrão e navegação por dia */
  function isoLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + dd;
  }
  function hojeISO() { return isoLocal(new Date()); }
  function dataPadraoISO() {
    const a = new Date();
    const h = a.getHours(), mi = a.getMinutes();
    // depois de 01 pm → amanhã; caso contrário (qualquer hora após 00 am) → hoje
    const depoisDe1pm = h > 13 || (h === 13 && mi > 0);
    const d = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    if (depoisDe1pm) d.setDate(d.getDate() + 1);
    return isoLocal(d);
  }
  function atualizarBotoesData() {
    const inp = document.getElementById("ext-sb-data");
    const prev = document.querySelector("#ext-sidebar .ext-sb-date-prev");
    if (!inp || !prev) return;
    prev.disabled = !inp.value || inp.value <= (inp.min || hojeISO());
    prev.style.opacity = prev.disabled ? "0.45" : "";
  }

  /* ------------------------------------------------------------
     Filtro do mapa por data de check-out.
     Ligado pelo checkbox "Apenas check-outs (saída)": no Mapa de UHs
     ficam visíveis apenas as UHs cuja data de saída é a data escolhida.
     ------------------------------------------------------------ */
  function dataBRparaISO(br) {
    const m = String(br || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? (m[3] + "-" + m[2] + "-" + m[1]) : "";
  }
  function isoParaBR(iso) {
    const m = String(iso || "").match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? (m[3] + "/" + m[2] + "/" + m[1]) : "";
  }
  /* Nas UHs que saem no proprio dia o Desbravador escreve "Saída hoje" em vez
     de uma data. Sem tratar isso o filtro escondia justamente essas UHs.
     O estado do card varia (OCUPADA_CHECKOUT, OCUPADA_CHECKIN_CHECKOUT, ...),
     por isso a decisao sai do texto da data e nao do nome do estado. */
  function saidaParaISO(txt) {
    const t = String(txt || "").replace(/^Saída\s*/i, "").trim();
    const iso = dataBRparaISO(t);
    if (iso) return iso;
    return /\bhoje\b/i.test(t) ? hojeISO() : "";
  }
  function filtroCheckoutLigado() {
    return extAtiva && estaNoMapa() &&
           !!document.getElementById("ext-sb-apenas-checkout")?.checked;
  }

  function aplicarFiltroCheckout() {
    const cards = [...document.querySelectorAll(".uh-main")];
    const ligado = filtroCheckoutLigado();
    const alvoISO = document.getElementById("ext-sb-data")?.value || "";
    // Universo do filtro: apenas UHs ocupadas. As livres (LIVRE /
    // LIVRE_CHECKIN) não têm saída para conferir e inflavam o total.
    const ocupadas = cards.filter(c => estaOcupada(c)).length;
    let visiveis = 0;

    cards.forEach(c => {
      if (!ligado) { c.classList.remove("ext-uh-oculta"); visiveis++; return; }
      const casa = !!alvoISO && saidaParaISO(extrairInfoDaUH(c).saida) === alvoISO;
      c.classList.toggle("ext-uh-oculta", !casa);
      if (casa) visiveis++;
    });

    const aviso = document.getElementById("ext-sb-filtro-aviso");
    if (!aviso) return;
    if (!ligado) {
      aviso.style.display = "none";
      aviso.textContent = "";
      return;
    }
    aviso.style.display = "block";
    aviso.innerHTML = "Mostrando <b>" + visiveis + "</b> de " + ocupadas +
                      " UHs ocupadas com saída em <b>" + isoParaBR(alvoISO) + "</b>.";
  }

  function injetarSidebar() {
    if (document.getElementById("ext-sidebar")) return;

    const sb = document.createElement("aside");
    sb.id = "ext-sidebar";
    sb.innerHTML = `
      <div class="ext-sb-head">
        <span class="ext-sb-title"><i class="ace-icon fa fa-check-square-o"></i> Modo conferência</span>
      </div>
      <button type="button" class="ext-sb-close" title="Recolher barra lateral" aria-label="Recolher barra lateral">
        <i class="ace-icon fa fa-chevron-left"></i>
      </button>
      <div class="ext-sb-stats">
        <div class="ext-sb-stat"><span>Selecionadas</span><span class="ext-sb-stat-val" id="ext-sb-stat-sel">0</span></div>
        <div class="ext-sb-stat"><span>Verificadas</span><span class="ext-sb-stat-val ok" id="ext-sb-stat-ver">0</span></div>
        <div class="ext-sb-stat"><span>Não verificadas</span><span class="ext-sb-stat-val pend" id="ext-sb-stat-naover">0</span></div>
      </div>
      <div class="ext-sb-body">
        <p class="ext-sb-desc">
          Confira e lance as comandas da UH direto do Mapa de UHs, sem sair da tela.
          Marque cada comanda conferida, acompanhe diárias e observações, e navegue
          entre as UHs pelo extrato.
        </p>
        <div class="ext-sb-field">
          <label class="ext-sb-switch">
            <input type="checkbox" id="ext-sb-apenas-checkout">
            <span class="ext-sb-switch-ui" aria-hidden="true"></span>
            <span>Apenas check-outs (saída)</span>
          </label>
          <label for="ext-sb-data">Data de check-out (saída)</label>
          <div class="ext-sb-date-row">
            <button type="button" class="btn btn-xs btn-white ext-sb-date-prev" title="Dia anterior">
              <i class="ace-icon fa fa-chevron-left"></i>
            </button>
            <input type="date" id="ext-sb-data" class="form-control input-sm">
            <button type="button" class="btn btn-xs btn-white ext-sb-date-next" title="Próximo dia">
              <i class="ace-icon fa fa-chevron-right"></i>
            </button>
          </div>
        </div>
        <div class="ext-sb-aviso" id="ext-sb-filtro-aviso" style="display:none;"></div>
        <div class="ext-sb-actions">
          <button type="button" id="ext-sb-acao-1" class="btn btn-sm btn-info" title="Resumo da conferência e impressão">
            <i class="ace-icon fa fa-print"></i> Imprimir
          </button>
          <button type="button" id="ext-sb-acao-2" class="btn btn-sm btn-white" title="Desmarcar todas as UHs selecionadas">
            <i class="ace-icon fa fa-eraser"></i> Limpar seleção
          </button>
        </div>
        <div class="ext-sb-pix">
          Se isso foi útil para você, considere me apoiar &lt;3<br>
          Programa feito por <b>Isaac</b><br>
          Chave Pix e contato para suporte: <b>(94) 99663-5669</b>
        </div>
      </div>`;
    document.body.appendChild(sb);

    const shy = document.createElement("button");
    shy.id = "ext-sidebar-toggle";
    shy.type = "button";
    shy.title = "Abrir Modo conferência";
    shy.innerHTML = '<i class="ace-icon fa fa-chevron-left"></i>';
    shy.addEventListener("click", () => { sidebarAberto = true; aplicarSidebar(); });
    document.body.appendChild(shy);

    sb.querySelector(".ext-sb-close").addEventListener("click", () => {
      sidebarAberto = false; aplicarSidebar();
    });

    window.addEventListener("resize", ajustarTopoDaBarra);

    // Campo de data: valor padrão + botões de um dia para frente/trás
    const dataInput = sb.querySelector("#ext-sb-data");
    const dataPrev = sb.querySelector(".ext-sb-date-prev");
    const dataNext = sb.querySelector(".ext-sb-date-next");
    if (dataInput && dataPrev && dataNext) {
      dataInput.min = hojeISO();
      dataInput.value = dataPadraoISO();
      const moverDia = (delta) => {
        dataInput.min = hojeISO();            // mantém o mínimo atualizado (virada do dia)
        const base = dataInput.value || dataInput.min;
        const d = new Date(base + "T00:00:00");
        if (isNaN(d.getTime())) return;
        d.setDate(d.getDate() + delta);
        const iso = isoLocal(d);
        if (iso < dataInput.min) return;      // nunca antes de hoje
        dataInput.value = iso;
        atualizarBotoesData();
        aplicarFiltroCheckout();
      };
      dataPrev.addEventListener("click", () => moverDia(-1));
      dataNext.addEventListener("click", () => moverDia(1));
      dataInput.addEventListener("change", () => {
        if (dataInput.value && dataInput.value < hojeISO()) dataInput.value = hojeISO();
        atualizarBotoesData();
        aplicarFiltroCheckout();
      });
      atualizarBotoesData();
    }

    const chkFiltro = sb.querySelector("#ext-sb-apenas-checkout");
    if (chkFiltro) chkFiltro.addEventListener("change", aplicarFiltroCheckout);

    // Botões de ação da barra lateral
    sb.querySelector("#ext-sb-acao-1").addEventListener("click", abrirPopupInfo);
    sb.querySelector("#ext-sb-acao-2").addEventListener("click", limparSelecaoUH);

    aplicarFiltroCheckout();

    aplicarSidebar();
    atualizarEstatisticasSidebar();
  }

  /* O cabeçalho fixo da aplicação não tem altura constante (já medimos 72px
     numa tela e 104px noutra) e fica ACIMA da barra (z-index 1030 contra os
     1029 da barra). Fixar o valor no CSS fazia o título e o "×" antigo
     sumirem atrás dele. Aqui medimos o que pode tapar o topo da barra. */
  function ajustarTopoDaBarra() {
    const sb = document.getElementById("ext-sidebar");
    if (!sb) return;

    const larguraJanela = window.innerWidth;
    const alturaJanela = window.innerHeight;
    let fundo = 0;

    const visitar = (el, nivel) => {
      if (nivel > 4 || el.nodeType !== 1) return;
      if (el === sb || sb.contains(el)) return;   // a própria barra não conta
      const estilo = getComputedStyle(el);
      if (estilo.position === "fixed" || estilo.position === "sticky") {
        const r = el.getBoundingClientRect();
        const z = parseInt(estilo.zIndex, 10);
        const zEfetivo = isNaN(z) ? 0 : z;
        // tem de ser uma faixa no topo: larga, baixa e a pintar na mesma
        // camada da barra (ou acima). Isso exclui painéis de altura total.
        if (r.top <= 4 && r.height > 20 && r.height <= alturaJanela * 0.4 &&
            r.width >= larguraJanela * 0.5 && zEfetivo >= 1029) {
          fundo = Math.max(fundo, r.bottom);
        }
      }
      for (const filho of el.children) visitar(filho, nivel + 1);
    };

    for (const filho of document.body.children) visitar(filho, 1);
    if (fundo > 0) {
      // rede de segurança: nenhuma medição pode empurrar a barra para meio ecrã
      sb.style.paddingTop = Math.round(Math.min(fundo, alturaJanela * 0.5)) + "px";
    }
  }

  function aplicarSidebar() {
    const sb = document.getElementById("ext-sidebar");
    const shy = document.getElementById("ext-sidebar-toggle");
    if (!sb || !shy) return;
    if (!(extAtiva && estaNoMapa())) {
      sidebarAberto = false;   // fora do mapa (ou extensão desligada) a barra volta recolhida
      sb.classList.remove("aberto");
      shy.style.display = "none";
      return;
    }
    ajustarTopoDaBarra();
    if (sidebarAberto) {
      sb.classList.add("aberto");
      shy.style.display = "none";
      atualizarEstatisticasSidebar();
    } else {
      sb.classList.remove("aberto");
      shy.style.display = "flex";
    }
  }

  /* ------------------------------------------------------------
     Aviso flutuante (toast) da extensão
     ------------------------------------------------------------ */
  function toastExt(msg) {
    document.querySelectorAll(".ext-toast").forEach(e => e.remove());
    const t = document.createElement("div");
    t.className = "ext-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 250);
    }, 2600);
  }

  /* ------------------------------------------------------------
     Botão 2 — limpa a seleção de UHs
     ------------------------------------------------------------ */
  function limparSelecaoUH() {
    if (!extAtiva) return;
    const tinha = uhsSelecionadas.size;
    uhsSelecionadas.clear();
    document.querySelectorAll(".ext-uh-chk").forEach(c => { c.checked = false; });
    document.querySelectorAll(".uh-main.ext-uh-sel").forEach(c => c.classList.remove("ext-uh-sel"));
    atualizarEstatisticasSidebar();
    if (tinha) toastExt(tinha + (tinha === 1 ? " UH desmarcada." : " UHs desmarcadas."));
  }

  /* ------------------------------------------------------------
     Botão 1 — popup de RESULTADO da conferência (Shadow DOM).
     Mostra: quantos quartos estão selecionados, quantos são
     correspondentes à data de check-out escolhida e quantos deles
     já estão conferidos. Botões: "Imprimir selecionados" / "Cancelar".
     A impressão em si ainda não está implementada: o resumo fica
     guardado em `ultimaImpressao` (ponto de extensão).
     ------------------------------------------------------------ */
  let ultimaImpressao = null;

  const INFO_CSS = `
    *{box-sizing:border-box;font-family:Roboto,"Open Sans",sans-serif}
    .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;
      align-items:center;justify-content:center;z-index:2147483647}
    .modal{background:#fff;border-radius:8px;width:min(430px,92vw);max-height:90vh;
      overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.3);font-size:13px;color:#393939}
    .header{display:flex;justify-content:space-between;align-items:center;
      padding:12px 16px;border-bottom:1px solid #e9ecef}
    .header h2{margin:0;font-size:15px;color:#0684c6}
    .close{border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:#868e96}
    .corpo{padding:14px 16px}
    .linhas{border:1px solid #e9ecef;border-radius:6px;overflow:hidden}
    .linha{display:flex;align-items:center;justify-content:space-between;gap:10px;
      padding:10px 12px;border-bottom:1px solid #f1f3f5}
    .linha:last-child{border-bottom:0}
    .linha .rot{font-size:12.5px;color:#495057}
    .linha .rot small{display:block;margin-top:1px;font-size:11px;color:#adb5bd}
    .linha .val{font-size:19px;font-weight:700;color:#0684c6;white-space:nowrap}
    .linha .val .de{font-size:12px;font-weight:400;color:#868e96}
    .linha.ok .val{color:#40C057}
    .linha.pend .val{color:#ef6c00}
    .status{margin-top:10px;padding:8px 10px;background:#eaf4fd;border:1px solid #cfe4f7;
      border-radius:4px;font-size:12px;color:#2b5c86}
    .status.pend{background:#fff8e1;border-color:#ffe9a8;color:#946200}
    .status[hidden]{display:none}
    .rodape{padding:12px 16px;display:flex;gap:8px;justify-content:flex-end;
      border-top:1px solid #e9ecef}
    .prim{padding:8px 14px;border-radius:5px;font-size:13px;cursor:pointer;
      background:#0684c6;color:#fff;border:1px solid #0684c6;font-weight:500}
    .prim:hover{background:#00679d}
    .sec{padding:8px 14px;border-radius:5px;font-size:13px;cursor:pointer;
      background:#f8f9fa;color:#495057;border:1px solid #ced4da;font-weight:500}
    .sec:hover{background:#e9ecef}
  `;

  /* ------------------------------------------------------------
     Números do resumo de conferência (usados pelo popup e pela
     impressão). O universo depende da check-box "Apenas check-outs":
     - marcada  -> UHs ocupadas com Saída = data escolhida
     - desmarcada -> TODAS as UHs ocupadas (totais)
     Nesse universo:
     - selecionados: as marcadas no mapa
     - conferidos: as com conferência salva (status "ok")
     ------------------------------------------------------------ */
  async function calcularResumoConferencia() {
    const cards = [...document.querySelectorAll(".uh-main")]
      .filter(c => (c.getAttribute("state") || "").toUpperCase().includes("OCUPADA"));

    const dataISO = document.getElementById("ext-sb-data")?.value || "";
    const dataBR  = isoParaBR(dataISO);
    const porData = filtroCheckoutLigado();   // só filtra pela data se a check-box estiver marcada

    const universo = [];
    cards.forEach(c => {
      const i = extrairInfoDaUH(c);
      if (!i.numero) return;
      if (porData && saidaParaISO(i.saida) !== dataISO) return;
      universo.push(i);
    });

    const selecionados = universo
      .filter(i => uhsSelecionadas.has(i.numero))
      .map(i => i.numero);

    let conferidos = [];
    try {
      const conf = await carregarConferencia();
      conferidos = universo
        .filter(i => conf[i.numero] && conf[i.numero].status === "ok")
        .map(i => i.numero);
    } catch (_) { /* sem storage: considera nada conferido */ }

    return {
      porData, dataISO, dataBR,
      total: universo.length,
      numeros: universo.map(i => i.numero),
      selecionados,
      conferidos
    };
  }

  /* ------------------------------------------------------------
     IMPRESSÃO DOS EXTRATOS DE CONTA
     Fluxo: busca o extrato das UHs selecionadas -> mantém apenas as
     que TÊM comandas -> monta um documento (1 página por UH) e manda
     para a impressão do navegador. Se não for possível imprimir
     directamente, envia os dados para o app.py local (porta 8001).
     ------------------------------------------------------------ */
  const APP_LOCAL_URL = "http://127.0.0.1:8001";

  /* ------------------------------------------------------------
     SESSÃO — envia os cookies do Desbravador para o app.py local
     (POST /api/session), para o servidor conseguir aceder ao PMS
     sem voltar a pedir login. Sincroniza ao abrir a página, a cada
     10 min, ao ativar a extensão e antes de imprimir pelo app.
     ------------------------------------------------------------ */
  const SESSAO_INTERVALO_MS = 10 * 60 * 1000;
  let _ultimaSincronizacao = 0;
  let _sincronizando = null;

  function sincronizarSessao(opts) {
    const forcar = !!(opts && opts.forcar);
    if (!forcar && Date.now() - _ultimaSincronizacao < SESSAO_INTERVALO_MS) {
      return Promise.resolve({ ok: true, ignorado: true });
    }
    if (_sincronizando) return _sincronizando;      // já a decorrer

    _sincronizando = chrome.runtime
      .sendMessage({ type: "sincronizar-sessao", appUrl: APP_LOCAL_URL })
      .then(r => {
        _ultimaSincronizacao = Date.now();
        if (r && r.ok) {
          console.log("[Conferência] Sessão enviada ao app local (" + r.cookies + " cookies).");
        } else {
          console.warn("[Conferência] Sessão não enviada ao app local:", (r && r.erro) || "sem resposta");
        }
        return r || { ok: false, erro: "sem resposta" };
      })
      .catch(err => {
        console.warn("[Conferência] Falha ao sincronizar sessão:", err);
        return { ok: false, erro: String((err && err.message) || err) };
      })
      .finally(() => { _sincronizando = null; });

    return _sincronizando;
  }

  /* ------------------------------------------------------------
     EXTRATO OFICIAL (PDF gerado pelo próprio Desbravador)
     O botão "Imprimir extrato" do sistema faz
     POST fechamentoConta/extratoConta?rel=true com
     { json: serialização do form #extrato-contas, _cid } e recebe o
     PDF do extrato de conta. Aqui reproduzimos esse pedido para cada
     UH selecionada (só as que TÊM comandas).
     ------------------------------------------------------------ */
  /* ------------------------------------------------------------
     Serialização do form #extrato-contas — SEM jQuery.

     O sistema usa o plugin jquery.serializeJSON; aqui reimplementamos
     o MESMO algoritmo (serializeArray + splitInputNameIntoKeysArray +
     deepSet) em JS puro, para funcionar igual dentro do content script
     (isolated world), onde o jQuery da página não está acessível.
     Validado contra o plugin: saída idêntica.
     ------------------------------------------------------------ */
  function serializeArrayForm(form) {
    const out = [];
    const naoEnviados = { submit: 1, button: 1, image: 1, reset: 1, file: 1 };

    form.querySelectorAll("input, select, textarea").forEach(el => {
      const nome = el.getAttribute("name");
      if (!nome || el.disabled) return;

      const tag = el.tagName.toLowerCase();
      const tipo = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && naoEnviados[tipo]) return;
      if (tag === "input" && (tipo === "checkbox" || tipo === "radio") && !el.checked) return;

      if (tag === "select") {
        [...el.options].forEach(op => {
          if (op.selected && !op.disabled) out.push({ name: nome, value: op.value });
        });
        return;
      }

      let valor = el.value;
      if (typeof valor !== "string") valor = String(valor == null ? "" : valor);
      if (tag === "input" && (tipo === "checkbox" || tipo === "radio") && !el.hasAttribute("value")) {
        valor = "on";
      }
      out.push({ name: nome, value: valor });
    });

    return out;
  }

  /* "a[b][]" -> ["a","b",""]  (igual ao splitInputNameIntoKeysArray) */
  function splitNomeEmChaves(nome) {
    const partes = String(nome).split("[").map(k => k.replace(/\]/g, ""));
    if (partes[0] === "") partes.shift();
    return partes;
  }

  /* Igual ao deepSet do plugin: cria objetos/arrays e agrupa os campos
     do mesmo item quando o nome repete []. */
  function deepSet(obj, chaves, valor) {
    const isObj = v => v === Object(v);
    const isUnd = v => v === undefined;

    const primeira = chaves[0];
    if (chaves.length === 1) {
      if (primeira === "") obj.push(valor);
      else obj[primeira] = valor;
      return;
    }

    const proxima = chaves[1];
    let chave = primeira;
    if (chave === "") {
      const idx = obj.length - 1;
      const ultimo = obj[idx];
      chave = (isObj(ultimo) && (isUnd(ultimo[proxima]) || chaves.length > 2)) ? idx : idx + 1;
    }

    if (proxima === "") {
      if (!(!isUnd(obj[chave]) && Array.isArray(obj[chave]))) obj[chave] = [];
    } else {
      if (!(!isUnd(obj[chave]) && isObj(obj[chave]))) obj[chave] = {};
    }

    deepSet(obj[chave], chaves.slice(1), valor);
  }

  function serializeJSONPuro(form) {
    const obj = {};
    serializeArrayForm(form).forEach(({ name, value }) => {
      const m = name.match(/(.*):([^:]+)$/);     // tipos ":number" (extractTypeAndNameWithNoType)
      deepSet(obj, splitNomeEmChaves(m ? m[1] : name), value);
    });
    return obj;
  }

  /* ------------------------------------------------------------
     Prepara o payload do extrato oficial + regra da CONTA EXTRA
     ------------------------------------------------------------ */
  function serializarExtrato(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const form = doc.querySelector("#extrato-contas");
    if (!form) throw new Error("Form #extrato-contas não encontrado no extrato.");

    // o sistema remove o name dos radios dos resumos antes de serializar
    form.querySelectorAll(".ext-conta-radio").forEach(r => r.removeAttribute("name"));

    const json = serializeJSONPuro(form);

    // extras que o app acrescenta depois de serializar
    json.retencaoImpostos = [];
    json.resumoImpostosIva = [];
    json.multiMoedaExtrato = [];
    const perc = doc.querySelector("#extratoconta-base-calculo-percepcion-input");
    json.valorBaseCalculoPercepcion = perc ? (perc.value || "") : "";

    const resumos = Array.isArray(json.resumosExtrato) ? json.resumosExtrato : [];
    let idxSel = 0;
    for (let i = 0; i < resumos.length; i++) {
      if (String(resumos[i].checked) === "true") { idxSel = i; break; }
    }
    const descDiaria = doc.querySelector("#ext-desconto-diaria-" + idxSel);
    json.descontoNasDiarias = descDiaria ? String(descDiaria.value).toLowerCase() === "true" : false;

    // descrição de cada lançamento (para separar comandas de diárias)
    const descPorId = {};
    doc.querySelectorAll(".extrato-div-comandas[id^='div-lancamento-']").forEach(el => {
      const id = el.dataset.idlancamento || String(el.id || "").replace(/^div-lancamento-/, "");
      descPorId[id] = (el.querySelector(".label-item")?.textContent || "").toUpperCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    });

    // CONTA EXTRA = lançamentos com faturado=false.
    // Só interessa imprimir quando existem COMANDAS (diárias não contam).
    let extraComandas = 0, extraDiarias = 0;
    (json.lancamentosDto || []).forEach(l => {
      const lanc = (l || {}).lancamento || {};
      if (String(lanc.faturado) !== "false") return;
      const d = descPorId[String(lanc.id || "")] || "";
      if (d.includes("DIARIA") || d.includes("HOSPEDAGEM")) extraDiarias++;
      else extraComandas++;
    });

    // o PDF mostra o resumo SELECIONADO: escolhe sempre a CONTA EXTRA
    resumos.forEach(r => { r.checked = (String(r.faturado) === "false") ? "true" : "false"; });

    const cid = doc.querySelector("#extrato-contas-cid");
    return {
      json,
      cid: cid ? (cid.value || "") : "",
      extra: { comandas: extraComandas, diarias: extraDiarias, itens: extraComandas + extraDiarias }
    };
  }

  function uuidExt() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /* Busca o HTML do extrato de conta (mesma chamada que o SPA faz) */
  async function buscarHtmlExtrato(contaId) {
    const r = await fetch(`${URL_EXTRATO}/${contaId}`, {
      credentials: "include",
      headers: {
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    if (!r.ok) throw new Error(`Falha ao buscar extrato (HTTP ${r.status}).`);
    return r.text();
  }

  /* Pede ao Desbravador o PDF oficial do extrato dessa UH.
     Devolve null quando a CONTA EXTRA não tem comandas (só diárias),
     porque nesse caso não se deve imprimir nada. */
  async function gerarPdfExtrato(info) {
    const html = await buscarHtmlExtrato(info.conta || info.reserva);
    const { json, cid, extra } = serializarExtrato(html);

    if (!extra || !extra.comandas) return null;   // só diárias -> não imprime

    const body = new URLSearchParams();
    body.append("json", encodeURIComponent(JSON.stringify(json)));
    body.append("_cid", cid || uuidExt());

    const r = await fetch("/fechamentoConta/extratoConta?rel=true", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: body.toString()
    });
    if (!r.ok) throw new Error("Extrato não gerado (HTTP " + r.status + ").");

    const blob = await r.blob();
    if (!blob.size) throw new Error("O extrato veio vazio.");
    return { blob, comandas: extra.comandas, diarias: extra.diarias };
  }

  /* Gera o PDF oficial do extrato de cada UH indicada que TENHA comandas */
  async function coletarPdfsDasUHs(numeros, aoProgresso) {
    const cards = document.querySelectorAll(".uh-main");
    const porNumero = {};
    cards.forEach(c => {
      const i = extrairInfoDaUH(c);
      if (i.numero) porNumero[i.numero] = i;
    });

    const pdfs = [];
    const problemas = [];
    let n = 0;
    for (const numero of numeros) {
      const info = porNumero[numero];
      if (!info) { problemas.push("UH " + numero + ": não encontrada no mapa"); continue; }
      n++;
      if (aoProgresso) aoProgresso(n, numeros.length, numero);
      try {
        const r = await gerarPdfExtrato(info);
        if (r) {
          pdfs.push({
            numero: info.numero, tipo: info.tipo, hospede: info.hospede,
            blob: r.blob, comandas: r.comandas
          });
        } else {
          problemas.push("UH " + numero + ": conta Extra sem comandas");
        }
      } catch (err) {
        console.warn("[Conferência] Extrato da UH " + numero + " falhou:", err);
        problemas.push("UH " + numero + ": " + ((err && err.message) || err));
      }
    }
    pdfs.problemas = problemas;
    return pdfs;
  }

  /* Impressão pelo navegador: abre o PDF e chama print().
     O visualizador de PDF do Chrome é um frame de outra origem — se o
     print() falhar, abre o PDF numa aba para o utilizador imprimir. */
  function imprimirPdfNoNavegador(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const ifr = document.createElement("iframe");
      ifr.setAttribute("aria-hidden", "true");
      ifr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0";

      ifr.onload = () => setTimeout(() => {
        try {
          ifr.contentWindow.focus();
          ifr.contentWindow.print();          // bloqueia até o diálogo fechar
          setTimeout(() => { ifr.remove(); URL.revokeObjectURL(url); }, 2000);
          resolve("navegador");
        } catch (err) {
          console.warn("[Conferência] print() no visualizador de PDF falhou, abrindo numa aba:", err);
          const aba = window.open(url, "_blank");
          setTimeout(() => ifr.remove(), 500);
          if (aba) resolve("navegador"); else { URL.revokeObjectURL(url); reject(err); }
        }
      }, 700);

      ifr.onerror = () => { ifr.remove(); URL.revokeObjectURL(url); reject(new Error("Não foi possível abrir o PDF do extrato.")); };
      ifr.src = url;
      document.body.appendChild(ifr);
    });
  }

  function blobParaBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
      fr.onerror = () => reject(new Error("Falha ao ler o PDF gerado."));
      fr.readAsDataURL(blob);
    });
  }

  /* Vários extratos: o app.py junta os PDFs num só documento e imprime */
  async function enviarPdfsParaApp(pdfs) {
    await sincronizarSessao({ forcar: true });   // sessão fresca no app local

    const lista = [];
    for (const p of pdfs) lista.push({ numero: p.numero, base64: await blobParaBase64(p.blob) });

    const r = await chrome.runtime.sendMessage({
      type: "imprimir-pdfs",
      appUrl: APP_LOCAL_URL,
      payload: { origem: "crm-conferencia", emitido_em: new Date().toISOString(), pdfs: lista }
    });
    if (!r || !r.ok) throw new Error((r && r.erro) || "App local não respondeu.");
    return "app";
  }

  /* Orquestra a impressão: preferimos o app local — imprime em silêncio e,
     com vários extratos, junta tudo num único trabalho (o navegador abre um
     diálogo por PDF e não consegue juntar documentos).
     Se o app local não responder, cai para a impressão no navegador. */
  async function imprimirExtratos(pdfs, aoStatus) {
    if (!pdfs.length) throw new Error("Nenhum extrato para imprimir.");

    try {
      if (aoStatus) {
        aoStatus(pdfs.length > 1
          ? "Unindo " + pdfs.length + " extratos no app local…"
          : "Enviando para o app local…");
      }
      return await enviarPdfsParaApp(pdfs);
    } catch (err) {
      console.warn("[Conferência] App local indisponível, imprimindo pelo navegador:", err);
      if (aoStatus) aoStatus("Imprimindo pelo navegador…");
      for (const p of pdfs) await imprimirPdfNoNavegador(p.blob);
      return "navegador";
    }
  }

  function abrirPopupInfo() {
    if (!extAtiva) return;
    if (document.getElementById("ext-info-host")) return;   // já aberto

    const dataISO = document.getElementById("ext-sb-data")?.value || "";
    const dataBR  = isoParaBR(dataISO) || "—";
    const porData = filtroCheckoutLigado();
    const rotulo1 = porData ? "Check-outs na data" : "Quartos ocupados";
    const sub1    = porData ? dataBR : "todos os quartos ocupados";

    const host = document.createElement("div");
    host.id = "ext-info-host";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>${INFO_CSS}</style>
      <div class="backdrop">
        <div class="modal">
          <header class="header">
            <h2>Resumo da conferência</h2>
            <button class="close" title="Fechar">×</button>
          </header>
          <div class="corpo">
            <div class="linhas">
              <div class="linha">
                <span class="rot"><span id="ext-info-rot1">${rotulo1}</span><small id="ext-info-data-br">${sub1}</small></span>
                <span class="val" id="ext-info-total">…</span>
              </div>
              <div class="linha" id="ext-info-l-sel">
                <span class="rot">Selecionados</span>
                <span class="val" id="ext-info-sel">…</span>
              </div>
              <div class="linha" id="ext-info-l-naoconf">
                <span class="rot">Não conferidos</span>
                <span class="val" id="ext-info-naoconf">…</span>
              </div>
            </div>
            <div class="status" id="ext-info-status" hidden></div>
          </div>
          <footer class="rodape">
            <button class="sec" id="ext-info-cancelar">Cancelar</button>
            <button class="prim" id="ext-info-confirmar">Imprimir selecionados</button>
          </footer>
        </div>
      </div>`;

    const fechar = () => host.remove();
    let resumo = null;

    shadow.querySelector(".close").addEventListener("click", fechar);
    shadow.getElementById("ext-info-cancelar").addEventListener("click", fechar);
    shadow.querySelector(".backdrop").addEventListener("click", e => {
      if (e.target.classList.contains("backdrop")) fechar();
    });
    shadow.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.stopPropagation(); fechar(); }
    });

    // ----- Preenche os números -----
    calcularResumoConferencia().then(r => {
      resumo = r;
      const q = id => shadow.getElementById(id);
      const nSel  = r.selecionados.length;
      const nNao  = Math.max(0, r.total - r.conferidos.length);

      q("ext-info-rot1").textContent = r.porData ? "Check-outs na data" : "Quartos ocupados";
      q("ext-info-data-br").textContent = r.porData ? (r.dataBR || "—") : "todos os quartos ocupados";
      q("ext-info-total").textContent = r.total;
      q("ext-info-sel").innerHTML   = nSel + ' <span class="de">de ' + r.total + '</span>';
      q("ext-info-naoconf").innerHTML = nNao + ' <span class="de">de ' + r.total + '</span>';

      // cores só fazem sentido quando há quartos no universo
      if (r.total) {
        q("ext-info-l-sel").classList.add(nSel === r.total ? "ok" : "pend");
        // "não conferidos" fica verde quando não sobra nenhum
        q("ext-info-l-naoconf").classList.add(nNao === 0 ? "ok" : "pend");
      }
    }).catch(() => {
      shadow.getElementById("ext-info-sel").textContent     = String(uhsSelecionadas.size);
      shadow.getElementById("ext-info-naoconf").textContent = "?";
    });

    // ----- Imprimir selecionados -----
    shadow.getElementById("ext-info-confirmar").addEventListener("click", async () => {
      const btnConf = shadow.getElementById("ext-info-confirmar");
      const status  = shadow.getElementById("ext-info-status");
      if (btnConf.disabled) return;

      if (!resumo) resumo = await calcularResumoConferencia().catch(() => null);
      if (!resumo) { toastExt("Não foi possível ler o resumo da conferência."); return; }
      if (!resumo.total) {
        toastExt(resumo.porData ? "Nenhum check-out na data selecionada." : "Nenhum quarto ocupado no mapa.");
        return;
      }
      if (!resumo.selecionados.length) { toastExt("Nenhum quarto selecionado."); return; }

      btnConf.disabled = true;
      status.hidden = false;
      status.className = "status";

      try {
        // 1) gera o PDF OFICIAL do extrato (só UHs que têm comandas)
        status.textContent = "Gerando extratos… 0/" + resumo.selecionados.length;
        const pdfs = await coletarPdfsDasUHs(resumo.selecionados, (i, t, numero) => {
          status.textContent = "Gerando extratos… " + i + "/" + t + " (UH " + numero + ")";
        });

        if (!pdfs.length) {
          status.className = "status pend";
          status.textContent = "Sem comandas na conta Extra dos quartos selecionados." +
            (pdfs.problemas && pdfs.problemas.length ? " (" + pdfs.problemas.join(" · ") + ")" : "");
          btnConf.disabled = false;
          return;
        }

        // 2) imprime (1 extrato: navegador; vários: app.py junta e imprime)
        status.textContent = "Enviando " + pdfs.length + " extrato(s) para impressão…";
        const via = await imprimirExtratos(pdfs, msg => { status.textContent = msg; });

        ultimaImpressao = {
          quando: new Date().toISOString(),
          filtradoPorData: resumo.porData,
          data: resumo.dataISO,
          dataBR: resumo.dataBR,
          totalUniverso: resumo.total,
          universo: resumo.numeros.slice(),
          selecionados: resumo.selecionados.slice(),
          conferidos: resumo.conferidos.slice(),
          naoConferidos: resumo.numeros.filter(n => !resumo.conferidos.includes(n)),
          impressos: pdfs.map(p => p.numero),
          ignoradosSemComanda: resumo.selecionados.filter(n => !pdfs.some(p => p.numero === n)),
          via
        };
        console.log("[Conferência] Impressão confirmada:", ultimaImpressao);
        fechar();
        toastExt("Impressão de " + pdfs.length + " extrato(s) via " +
                 (via === "app" ? "app local" : "navegador") + ".");
      } catch (err) {
        status.className = "status pend";
        status.textContent = "Falha na impressão: " + ((err && err.message) || err);
        btnConf.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------
     Seleção de UHs (checkbox nos cards) + estatísticas na barra
     ------------------------------------------------------------ */
  const uhsSelecionadas = new Set();

  async function atualizarEstatisticasSidebar() {
    const elSel = document.getElementById("ext-sb-stat-sel");
    const elVer = document.getElementById("ext-sb-stat-ver");
    const elNao = document.getElementById("ext-sb-stat-naover");
    if (!elSel || !elVer || !elNao) return;

    // Universo = UHs OCUPADAS (mesmo denominador para as 3 estatísticas)
    const cards = [...document.querySelectorAll(".uh-main")]
      .filter(c => (c.getAttribute("state") || "").toUpperCase().includes("OCUPADA"));
    const numeros = cards.length ? cards.map(c => extrairInfoDaUH(c).numero)
                                 : uhs.map(u => u.numero);
    const total = numeros.length;

    const setOcupadas = new Set(numeros);
    let selecionadas = 0;
    uhsSelecionadas.forEach(n => { if (setOcupadas.has(n)) selecionadas++; });

    let ver = 0;
    try {
      const conf = await carregarConferencia();
      numeros.forEach(n => { const st = conf[n]; if (st && st.status === "ok") ver++; });
    } catch (_) {}

    elSel.textContent = selecionadas + "/" + total;
    elVer.textContent = ver + "/" + total;
    elNao.textContent = Math.max(0, total - ver) + "/" + total;

    // Botão "Limpar seleção" só fica ativo quando há algo selecionado
    const btnLimpar = document.getElementById("ext-sb-acao-2");
    if (btnLimpar) {
      btnLimpar.disabled = selecionadas === 0;
      btnLimpar.style.opacity = btnLimpar.disabled ? "0.5" : "";
      btnLimpar.style.cursor = btnLimpar.disabled ? "not-allowed" : "";
    }
  }

  function criarCheckboxUH(uhEl) {
    if (uhEl.querySelector(".ext-uh-check")) return;
    if (!estaOcupada(uhEl)) return;   // só UHs ocupadas podem ser conferidas
    const host = uhEl.querySelector(".uh-icon") || uhEl.querySelector(".conteudo-draggeable");
    if (!host) return;
    const numero = extrairInfoDaUH(uhEl).numero;
    if (!numero) return;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    const label = document.createElement("label");
    label.className = "ext-uh-check";
    label.title = "Selecionar UH " + numero;
    label.draggable = false;
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "ext-uh-chk";
    chk.dataset.uhNumero = numero;
    chk.checked = uhsSelecionadas.has(numero);
    label.appendChild(chk);
    ["mousedown", "mouseup", "click", "dblclick"].forEach(ev =>
      label.addEventListener(ev, e => e.stopPropagation()));
    host.appendChild(label);
    uhEl.classList.toggle("ext-uh-sel", chk.checked);
  }

  function injetarCheckboxesUH() {
    if (!extAtiva || !estaNoMapa()) return;
    document.querySelectorAll(".uh-main").forEach(uhEl => {
      if (estaOcupada(uhEl)) {
        criarCheckboxUH(uhEl);
      } else {
        // UH deixou de estar ocupada → remove o checkbox e a seleção
        const cb = uhEl.querySelector(".ext-uh-check");
        if (cb) {
          const numero = extrairInfoDaUH(uhEl).numero;
          if (numero) uhsSelecionadas.delete(numero);
          cb.remove();
          uhEl.classList.remove("ext-uh-sel");
          atualizarEstatisticasSidebar();
        }
      }
    });
    // O mapa pode ter sido redesenhado: reaplica o filtro de check-out
    // e recalcula as estatísticas da barra lateral.
    aplicarFiltroCheckout();
    atualizarEstatisticasSidebar();
  }

  function removerCheckboxesUH() {
    document.querySelectorAll(".ext-uh-check").forEach(e => e.remove());
    document.querySelectorAll(".uh-main.ext-uh-sel").forEach(e => e.classList.remove("ext-uh-sel"));
  }

  function configurarSelecaoUH() {
    document.addEventListener("change", (e) => {
      const chk = e.target;
      if (!chk || !chk.classList || !chk.classList.contains("ext-uh-chk")) return;
      const numero = chk.dataset.uhNumero;
      if (chk.checked) uhsSelecionadas.add(numero); else uhsSelecionadas.delete(numero);
      const card = chk.closest(".uh-main");
      if (card) card.classList.toggle("ext-uh-sel", chk.checked);
      atualizarEstatisticasSidebar();
    });
  }

  function alternarExtensao() {
    extAtiva = !extAtiva;
    atualizarBotaoToggle();
    aplicarEstadoExtensao();
    if (extAtiva) sincronizarSessao({ forcar: true });   // sessão fresca no app local
  }

  function aplicarEstadoExtensao() {
    if (!extAtiva) {
      // remove TODA a UI injetada pela extensão
      document.querySelectorAll(".ext-conferir-wrap, .ext-lancar-wrap, .ext-sep").forEach(e => e.remove());
      document.querySelectorAll(".ext-card-badge").forEach(e => e.remove());
      document.getElementById("ext-conferencia-host")?.remove();
      document.getElementById("ext-info-host")?.remove();
      document.querySelectorAll(".ext-lanc-overlay").forEach(e => e.remove());
      removerCheckboxesUH();
      // extensão desligada: filtro de check-out sai junto
      const chkFiltroOff = document.getElementById("ext-sb-apenas-checkout");
      if (chkFiltroOff) chkFiltroOff.checked = false;
      aplicarFiltroCheckout();
    } else {
      // reinjeta botões nos popovers já abertos
      document.querySelectorAll(".uh-main").forEach(uhEl => {
        if (uhEl.querySelector(".mapauh-main-popover") && estaOcupada(uhEl)) injetarBotoes(uhEl);
      });
      injetarCheckboxesUH();
    }
    atualizarNavUH();
  }

  function injetarNavUH() {
    const bar = garantirHeaderBar();
    if (!bar || document.getElementById("ext-nav-uh")) return;

    const li = document.createElement("div");
    li.id = "ext-nav-uh";
    li.style.cssText = "display:none; align-items:center; gap:8px; order:1;";
    li.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; height:40px;">
        <div class="btn-group">
          <button type="button" class="btn btn-xs btn-white btn-info ext-nav-prev" title="UH anterior (←)">
            <i class="ace-icon fa fa-chevron-left"></i>
          </button>
          <button type="button" class="btn btn-xs btn-white ext-nav-label"
                  style="cursor:default; min-width:62px;" title="UH atual">UH —</button>
          <button type="button" class="btn btn-xs btn-white btn-info ext-nav-next" title="Próxima UH (→)">
            <i class="ace-icon fa fa-chevron-right"></i>
          </button>
        </div>
        <div style="position:relative;">
          <input type="text" class="form-control input-sm ext-nav-input" placeholder="Ir para UH…"
                 autocomplete="off" style="width:78px; height:26px; font-size:12px; padding-left:24px;">
          <i class="ace-icon fa fa-search" style="position:absolute; left:8px; top:6px; color:#aaa; font-size:12px; pointer-events:none;"></i>
          <div class="ext-nav-dropdown"></div>
        </div>
      </div>`;
    bar.appendChild(li);

    li.querySelector(".ext-nav-prev").addEventListener("click", uhAnterior);
    li.querySelector(".ext-nav-next").addEventListener("click", uhProxima);

    const input = li.querySelector(".ext-nav-input");
    const dd = li.querySelector(".ext-nav-dropdown");
    dd.style.cssText = "display:none; position:absolute; top:30px; right:0; min-width:140px; max-height:260px;" +
      " overflow:auto; background:#fff; border:1px solid #ddd; border-radius:4px;" +
      " box-shadow:0 3px 10px rgba(0,0,0,.15); z-index:1600;";

    const fecharDD = () => { dd.style.display = "none"; };
    const escolher = (u) => { irParaConta(u.conta); input.value = ""; fecharDD(); };

    function renderDD(termo) {
      const v = (termo || "").trim();
      dd.innerHTML = "";
      if (!v) { fecharDD(); return; }
      const matches = uhs.filter(u => u.numero.includes(v)).slice(0, 8);
      if (!matches.length) { fecharDD(); return; }
      matches.forEach(u => {
        const opt = document.createElement("div");
        opt.style.cssText = "padding:5px 10px; cursor:pointer; font-size:12px; white-space:nowrap;";
        opt.innerHTML = `UH <b>${u.numero}</b>`;
        opt.addEventListener("mouseenter", () => opt.style.background = "#f1f5f9");
        opt.addEventListener("mouseleave", () => opt.style.background = "");
        opt.addEventListener("click", () => escolher(u));
        dd.appendChild(opt);
      });
      dd.style.display = "block";
    }

    input.addEventListener("input", () => renderDD(input.value));
    input.addEventListener("focus", () => { if (input.value) renderDD(input.value); });
    input.addEventListener("keydown", (e) => {
      const v = input.value.trim();
      if (e.key === "Enter") {
        if (!v) return;
        const exato = uhs.find(u => u.numero === v) || uhs.find(u => u.numero.includes(v));
        if (exato) escolher(exato);
      } else if (e.key === "Escape") {
        input.value = ""; fecharDD(); input.blur();
      }
    });
    document.addEventListener("click", (e) => { if (!li.contains(e.target)) fecharDD(); });
  }

  function atualizarNavUH() {
    atualizarVisibilidadeToggle();
    aplicarSidebar();
    aplicarFiltroCheckout();
    const li = document.getElementById("ext-nav-uh");
    if (!li) return;
    const mostrar = extAtiva && estaNoExtrato() && uhs.length > 0;
    li.style.display = mostrar ? "flex" : "none";
    if (!mostrar) return;

    const i = indexUHAtual();
    const label = li.querySelector(".ext-nav-label");
    if (label) label.textContent = i >= 0 ? ("UH " + uhs[i].numero) : "UH —";

    const prev = li.querySelector(".ext-nav-prev");
    const next = li.querySelector(".ext-nav-next");
    if (prev) { prev.disabled = i <= 0; prev.style.opacity = prev.disabled ? "0.45" : ""; }
    if (next) { next.disabled = i < 0 || i >= uhs.length - 1; next.style.opacity = next.disabled ? "0.45" : ""; }
  }

  function configurarNavegacaoUH() {
    injetarToggleExtensao();
    injetarSidebar();
    injetarNavUH();
    configurarSelecaoUH();
    carregarUHsStorage().then(atualizarNavUH);
    injetarToggleExtensao();
    atualizarBotaoToggle();
    aplicarEstadoExtensao();

    // Conteúdo SPA trocou → reinjeta/atualiza (childList substitui innerHTML)
    const alvo = document.getElementById("conteudo-ajax")
              || document.getElementById("all-content")
              || document.body;
    const obs = new MutationObserver(() => {
      injetarToggleExtensao();
      injetarSidebar();
      injetarNavUH();
      injetarCheckboxesUH();
      atualizarNavUH();
      if ((window.location.hash || "").includes("/mapaUh/")) coletarUHs();
    });
    obs.observe(alvo, { childList: true });

    // filtros do mapa recriam os cards → re-injeta os checkboxes (debounce)
    let _tCards = null;
    new MutationObserver(() => {
      clearTimeout(_tCards);
      _tCards = setTimeout(injetarCheckboxesUH, 250);
    }).observe(alvo, { childList: true, subtree: true });

    window.addEventListener("hashchange", () => {
      injetarToggleExtensao();
      injetarSidebar();
      injetarNavUH();
      injetarCheckboxesUH();
      atualizarNavUH();
      if ((window.location.hash || "").includes("/mapaUh/")) {
        [600, 1500, 3000].forEach(t => setTimeout(coletarUHs, t));
      }
    });

    // retries iniciais (o SPA pode renderizar depois do content script)
    [600, 1500, 3000].forEach(t => setTimeout(() => {
      injetarToggleExtensao(); injetarSidebar(); injetarNavUH(); coletarUHs(); injetarCheckboxesUH(); atualizarNavUH();
    }, t));

    // sessão para o app.py local: ao abrir a página e depois a cada 10 min
    setTimeout(() => sincronizarSessao(), 2500);
    setInterval(() => sincronizarSessao(), SESSAO_INTERVALO_MS);

    // teclado: ← / → para navegar (quando no extrato e fora de inputs/modais)
    document.addEventListener("keydown", (e) => {
      if (!estaNoExtrato()) return;
      if (document.getElementById("ext-conferencia-host") || document.getElementById("ext-info-host") ||
          document.querySelector(".ext-lanc-overlay")) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight") { e.preventDefault(); uhProxima(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); uhAnterior(); }
    });
  }

  /* ------------------------------------------------------------
     Envia snapshot para o background (badge no ícone da extensão)
     ------------------------------------------------------------ */
  async function notificarResumo(todas) {
    let pend = 0, div = 0;
    Object.values(todas || {}).forEach(c => {
      if (c.status === "pendente") pend++;
      else if (c.status === "divergente") div++;
    });
    try {
      await chrome.runtime.sendMessage({
        type: "conferencia-snapshot",
        dados: { pendentes: pend, divergentes: div }
      });
    } catch (_) { /* background pode não estar pronto ainda */ }
  }

  /* ------------------------------------------------------------
     Observador: monitora popovers abrindo
     ------------------------------------------------------------ */
  function observarPopovers() {
    // 1. Observa mudanças no DOM (SPA)
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        // Popover ficou visível?
        m.target.classList?.contains("mapauh-main-popover");
        // Caso 1: novo popover adicionado
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains("mapauh-main-popover")) {
            const uhEl = node.closest(".uh-main");
            if (uhEl) setTimeout(() => injetarBotoes(uhEl), 0);
          }
          node.querySelectorAll?.(".mapauh-main-popover").forEach(pop => {
            const uhEl = pop.closest(".uh-main");
            if (uhEl) setTimeout(() => injetarBotoes(uhEl), 0);
          });
        }
        // Caso 2: atributo style/class mudou em popover existente
        if (m.type === "attributes" && m.target.classList?.contains("mapauh-main-popover")) {
          const pop = m.target;
          const visivel = getComputedStyle(pop).display !== "none" && pop.offsetParent !== null;
          if (visivel) {
            const uhEl = pop.closest(".uh-main");
            if (uhEl) setTimeout(() => injetarBotoes(uhEl), 0);
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    });

    // 2. Também trata clique direto no ícone (fallback)
    document.addEventListener("click", e => {
      const icon = e.target.closest(".uh-icon");
      if (!icon) return;
      const uhEl = icon.closest(".uh-main");
      if (!uhEl) return;
      // Aguarda o popover nativo abrir (ele é populado via JS do Desbravador)
      setTimeout(() => injetarBotoes(uhEl), 50);
      setTimeout(() => injetarBotoes(uhEl), 250);
    }, true);
  }

  /* ------------------------------------------------------------
     Restaura badges dos cards ao carregar a página
     ------------------------------------------------------------ */
  async function restaurarBadges() {
    if (!extAtiva) return;          // modo conferência desligado: sem badges
    const conf = await carregarConferencia();
    document.querySelectorAll(".uh-main").forEach(uhEl => {
      if (!estaOcupada(uhEl)) return;
      const info = extrairInfoDaUH(uhEl);
      const c = conf[info.numero];
      if (!c) return;
      const total = c.total || 0;
      const ok = Object.values(c.comandas || {}).filter(Boolean).length;
      atualizarBadgeNoCard(uhEl, c.status, total, ok);
    });
  }

  /* ------------------------------------------------------------
     BOOT
     ------------------------------------------------------------ */
  function iniciar() {
    console.log("[Conferência] carregada. UHs no mapa:",
                document.querySelectorAll(".uh-main").length);
    log("Extensão carregada.");
    observarPopovers();
    configurarNavegacaoUH();
    // Espera o SPA renderizar antes de restaurar
    setTimeout(restaurarBadges, 800);
    setTimeout(restaurarBadges, 2500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }

})();