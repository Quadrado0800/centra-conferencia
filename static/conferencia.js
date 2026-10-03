// ============================================================
// ESTADO GLOBAL
// ============================================================
let UHS          = [];
let CONFERENCIA  = {};   // { uh_id: { status, comandas:{id:bool}, obs, total } }
let UH_ABERTA    = null;

const SITUACOES_PADRAO = ["OCUPADA", "CHECKIN", "CHECKOUT"];
const TIPOS            = ["DVM", "AFMEC", "AFML", "PNE", "STD", "STDEC"];
const TIPOS_PADRAO     = ["DVM", "AFMEC", "AFML", "PNE", "STD", "STDEC"];

// Situacoes que representam UH com hospedagem ativa (tem comandas).
const SITUACOES_COM_HOSPEDAGEM = [
  "CHECKIN_OCUPADA_CHECKOUT",
  "OCUPADA_CHECKOUT",
  "CHECKIN_OCUPADA",
  "CHECKIN_CHECKOUT",
  "OCUPADA",
  "CHECKIN",
  "CHECKOUT",
];

function _temHospedagem(u) {
  if (u.reserva_id) return true;
  const s = String(u.situacao || "").toUpperCase();
  return SITUACOES_COM_HOSPEDAGEM.some(sit => s.includes(sit));
}

function _situacaoOculta(u) {
  // Ocultamos a situacao "OCUPADA" pura do filtro (redundante).
  return String(u.situacao || "").toUpperCase() === "OCUPADA";
}

// ============================================================
// UTILITÁRIOS DE DATA
// ============================================================
function _hoje() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function _amanha() {
  const d = _hoje();
  d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Converte "24/09/2026" em Date (meia-noite local).
 * Retorna null se inválido.
 */
function _parseDataBR(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
}

function _mesmoDia(a, b) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

// ============================================================
// CARGA
// ============================================================
async function carregar() {
  const grade = document.getElementById("grade-uhs");

  if (!window.CONECTADO) {
    grade.innerHTML = `<div class="vazio">⚠️ Sessão não conectada. Envie os cookies pela extensão.</div>`;
    return;
  }

  grade.innerHTML = `<div class="vazio">Carregando UHs…</div>`;

  try {
    const [rc, ru] = await Promise.all([
      fetch("/api/conferencia").then(r => r.json()),
      fetch("/api/mapa-uhs").then(r => r.json()),
    ]);

    CONFERENCIA = rc.dados || {};

    if (!ru.ok) {
      grade.innerHTML = `<div class="vazio">Erro: ${ru.error}</div>`;
      return;
    }

    UHS = (ru.uhs || []).map(u => ({
      ...u,
      _saidaDate: _parseDataBR(u.saida),
    }));

    if (ru.dataCaixa) {
      document.querySelector(".data-caixa").innerHTML =
        `Data do caixa: <b>${ru.dataCaixa}</b>`;
    }

    renderFiltros();
    renderGrade();
    atualizarResumo();
  } catch (e) {
    grade.innerHTML = `<div class="vazio">Falha: ${e.message}</div>`;
  }
}

// ============================================================
// FILTROS
// ============================================================
// Mapeia cada variacao para um grupo canonico exibido no filtro.
// OCUPADA agrega todas as variacoes com ocupacao (o usuario ve so "OCUPADA").
const GRUPO_SITUACAO = {
  OCUPADA:                  "OCUPADA",
  CHECKIN_OCUPADA:          "OCUPADA",
  OCUPADA_CHECKOUT:         "OCUPADA",
  CHECKIN_OCUPADA_CHECKOUT: "OCUPADA",
  CHECKIN:                  "CHECKIN",
  CHECKOUT:                 "CHECKOUT",
  CHECKIN_CHECKOUT:         "CHECKOUT",
  CHECK_OUT:                "CHECKOUT",
  LIVRE:                    "LIVRE",
  LIMPEZA:                  "LIMPEZA",
  MANUTENCAO:               "MANUTENCAO",
};

function _grupoSituacao(u) {
  const s = String(u.situacao || "").toUpperCase();
  return GRUPO_SITUACAO[s] || s;
}

function renderFiltros() {
  // Situacao — dinamica, baseada nas UHs carregadas.
  // Mostramos apenas grupos que fazem sentido para conferencia:
  // CHECKIN e CHECKOUT. UHs puramente OCUPADA nao aparecem (redundantes).
  const GRUPOS_VISIVEIS = new Set(["CHECKIN", "CHECKOUT"]);
  const grupos = new Set();
  (UHS || []).forEach(u => {
    try {
      if (!_temHospedagem(u)) return;
      const g = _grupoSituacao(u);
      if (GRUPOS_VISIVEIS.has(g)) grupos.add(g);
    } catch (err) {
      console.warn("[renderFiltros] UH ignorada:", u, err);
    }
  });
  const gruposOrdenados = [...grupos].sort();

  document.getElementById("filtro-situacao").innerHTML = gruposOrdenados.length
    ? gruposOrdenados.map(s => `
        <label class="filtro-item">
          <input type="checkbox" class="f-situacao" value="${s}" checked>
          <span class="dot" style="border-color:${corSituacao(s)}"></span> ${s}
        </label>`).join("")
    : `<div style="font-size:12px;color:#adb5bd">—</div>`;

  // Tipo
  const tiposPresentes = [...new Set(UHS.map(u => u.tipo).filter(Boolean))].sort();
  document.getElementById("filtro-tipo").innerHTML = tiposPresentes.map(t => `
    <label class="filtro-item">
      <input type="checkbox" class="f-tipo" value="${t}" checked>
      <span class="dot" style="border-color:${window.CORES_TIPO[t] || '#adb5bd'}"></span> ${t}
    </label>`).join("");

  // Andar
  const andares = [...new Set(UHS.map(u => u.andar))].sort((a, b) => a - b);
  document.getElementById("filtro-andar").innerHTML = andares.map(a => `
    <label class="filtro-item">
      <input type="checkbox" class="f-andar" value="${a}" checked> Andar ${a}
    </label>`).join("");

  // Eventos
  document.querySelectorAll(
    ".f-situacao, .f-tipo, .f-andar, #filtro-pendentes, #filtro-divergentes, #filtro-conferidas, #filtro-saida-modo"
  ).forEach(el => el.addEventListener("change", renderGrade));

  // Select de saída: mostra/esconde o input de data
  const selSaida = document.getElementById("filtro-saida-modo");
  const inpData  = document.getElementById("filtro-saida-data");
  selSaida.addEventListener("change", () => {
    inpData.style.display = (selSaida.value === "data") ? "block" : "none";
    if (selSaida.value === "data" && !inpData.value) {
      const am = _amanha();
      inpData.value = am.toISOString().slice(0, 10);
    }
    renderGrade();
  });
  inpData.addEventListener("change", renderGrade);

  // Botões
  document.getElementById("btn-limpar-filtros").onclick = () => {
    document.querySelectorAll(".f-situacao, .f-tipo, .f-andar").forEach(c => c.checked = true);
    document.getElementById("filtro-pendentes").checked   = false;
    document.getElementById("filtro-divergentes").checked = false;
    document.getElementById("filtro-conferidas").checked  = false;
    selSaida.value = "todas";
    inpData.style.display = "none";
    renderGrade();
  };

  document.getElementById("btn-zerar-conf").onclick = async () => {
    if (!confirm("Zerar TODA a conferência salva?")) return;
    await fetch("/api/conferencia/limpar", { method: "POST" });
    CONFERENCIA = {};
    renderGrade();
    atualizarResumo();
  };

  document.getElementById("btn-atualizar").onclick = carregar;
}

function corSituacao(s) {
  return ({
    CHECKIN:                  "#e96b6b",
    CHECKIN_OCUPADA:          "#e96b6b",
    CHECKOUT:                 "#f6af4a",
    CHECK_OUT:                "#f6af4a",
    OCUPADA_CHECKOUT:         "#f6af4a",
    CHECKIN_CHECKOUT:         "#f6af4a",
    CHECKIN_OCUPADA_CHECKOUT: "#f6af4a",
    LIMPEZA:                  "#f6af4a",
    LIVRE:                    "#7ecd73",
    MANUTENCAO:               "#70a3c6",
    OCUPADA:                  "#e96b6b",
  })[s] || "#adb5bd";
}

function getFiltros() {
  const modo = document.getElementById("filtro-saida-modo").value;
  const inp  = document.getElementById("filtro-saida-data");

  let saidaAlvo = null;
  if (modo === "hoje")   saidaAlvo = _hoje();
  if (modo === "amanha") saidaAlvo = _amanha();
  if (modo === "data" && inp.value) {
    const [y, m, d] = inp.value.split("-").map(Number);
    saidaAlvo = new Date(y, m - 1, d);
  }

  return {
    situacoes:    [...document.querySelectorAll(".f-situacao:checked")].map(c => c.value),
    tipos:        [...document.querySelectorAll(".f-tipo:checked")].map(c => c.value),
    andares:      [...document.querySelectorAll(".f-andar:checked")].map(c => +c.value),
    soPendentes:  document.getElementById("filtro-pendentes").checked,
    soDivergentes:document.getElementById("filtro-divergentes").checked,
    soConferidas: document.getElementById("filtro-conferidas").checked,
    saidaAlvo,
  };
}

// ============================================================
// GRADE
// ============================================================
function renderGrade() {
  const f = getFiltros();
  const grade = document.getElementById("grade-uhs");

  const lista = (UHS || []).filter(u => {
    // Só mostramos UHs com hospedagem ativa (ocupadas).
    // Quartos LIVRE, LIMPEZA e MANUTENCAO ficam ocultos do mapa.
    if (typeof _temHospedagem === "function" && !_temHospedagem(u)) return false;

    // Situacao: o usuario ve apenas grupos canonicos (OCUPADA etc.).
    // Qualquer variacao (CHECKIN_OCUPADA_CHECKOUT, etc.) casa com seu grupo.
    if (f.situacoes.length) {
      const grupo = _grupoSituacao(u);
      if (grupo !== "OCUPADA" && !f.situacoes.includes(grupo)) return false;
    }
    if (!f.tipos.includes(u.tipo)) return false;
    if (!f.andares.includes(u.andar)) return false;

    // Filtro por data de saída
    if (f.saidaAlvo) {
      if (!u._saidaDate) return false;
      if (!_mesmoDia(u._saidaDate, f.saidaAlvo)) return false;
    }

    const conf   = CONFERENCIA[u.id];
    const status = conf?.status || "pendente";

    if (f.soPendentes   && status !== "pendente")   return false;
    if (f.soDivergentes && status !== "divergente") return false;
    if (f.soConferidas  && status !== "ok")         return false;
    return true;
  });

  if (!lista.length) {
    grade.innerHTML = `<div class="vazio">Nenhuma UH corresponde aos filtros.</div>`;
    return;
  }

  grade.innerHTML = lista.map(cardUh).join("");

  // ⚠️ Anexa os handlers DEPOIS de inserir no DOM
  grade.querySelectorAll("[data-abrir]").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      abrirModal(btn.dataset.abrir);
    });
  });
}

function cardUh(u) {
  const conf   = CONFERENCIA[u.id] || {};
  const status = conf.status || "pendente";
  const cor    = u.cor || window.CORES_TIPO[u.tipo] || "#adb5bd";

  const total      = conf.total ?? 0;
  const conferidas = conf.comandas ? Object.values(conf.comandas).filter(Boolean).length : 0;

  const classe = status === "ok" ? "conferida"
               : status === "divergente" ? "divergente"
               : "pendente";

  const semHospedagem = !_temHospedagem(u);

  return `
    <div class="caixa ${classe}" data-uh="${u.id}">
      <div class="caixa-header" style="background:${cor}">
        <span class="num">${u.numero}</span>
        <span class="tipo">${u.tipo}</span>
      </div>
      <span class="badge-status">${badgeStatus(status, conferidas, total)}</span>
      <div class="caixa-body">
        <div class="hospede" title="${u.hospede || '—'}">${u.hospede || '—'}</div>
        <div class="linha"><span>Reserva:</span> <b>${u.reserva || '—'}</b></div>
        <div class="linha"><span>Saída:</span>   <b>${u.saida || '—'}</b></div>
        <div class="linha"><span>Comandas:</span><b>${conferidas}/${total || '?'}</b></div>
      </div>
      <div class="caixa-footer">
        <button data-abrir="${u.id}" ${semHospedagem ? 'disabled title="Sem hospedagem ativa"' : ''}>
          ${semHospedagem ? 'Sem hospedagem' : 'Conferir comandas'}
        </button>
      </div>
    </div>`;
}

function badgeStatus(status, ok, total) {
  if (status === "ok")         return `✅ ${ok}/${total}`;
  if (status === "divergente") return `⚠️ divergente`;
  return `⏳ ${ok}/${total || '?'}`;
}

// ============================================================
// MODAL
// ============================================================
async function abrirModal(uhId) {
  // uhId pode vir como string do dataset; normaliza para o mesmo tipo de UHS[].id
  const uh = UHS.find(u => String(u.id) === String(uhId));
  if (!uh) return;

  UH_ABERTA = uh;

  const modal = document.getElementById("modal");
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");

  document.getElementById("modal-titulo").textContent   = `UH ${uh.numero} - ${uh.tipo}`;
  document.getElementById("modal-hospede").textContent  = uh.hospede || "—";
  document.getElementById("modal-reserva").textContent  = uh.reserva || "—";
  document.getElementById("modal-saida").textContent    = uh.saida || "—";
  document.getElementById("modal-ocupacao").textContent = uh.modoOcupacao || "—";

  const tbody = document.getElementById("tbody-comandas");
  tbody.innerHTML = "";

  // Sem hospedagem → sem extrato
  if (!uh.reserva_id) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#adb5bd;padding:24px">
      UH sem hospedagem ativa — não há extrato a conferir.
      ${uh.observacao ? `<br><span style="font-size:12px">Obs.: ${uh.observacao}</span>` : ''}
    </td></tr>`;
    document.getElementById("tbody-diarias").innerHTML =
      `<tr><td colspan="4" style="text-align:center;color:#adb5bd;padding:24px">—</td></tr>`;
    return;
  }

  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#868e96;padding:24px">Carregando comandas…</td></tr>`;

  try {
    const r = await fetch(`/api/uh/${uh.reserva_id}/${uh.numero}/extrato`);
    const j = await r.json();

    if (!j.ok) throw new Error(j.error || "Falha ao buscar extrato");

    uh.comandas = j.comandas || [];
    uh.diarias  = j.diarias  || [];
    uh.ocupacao = j.ocupacao || uh.modoOcupacao;

    document.getElementById("modal-ocupacao").textContent = uh.ocupacao || "—";

    renderComandas();
    renderDiarias();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#d32f2f;padding:16px">
      Erro: ${e.message}</td></tr>`;
  }
}

function renderComandas() {
  const uh   = UH_ABERTA;
  const conf = CONFERENCIA[uh.id]?.comandas || {};
  const tbody = document.getElementById("tbody-comandas");

  if (!uh.comandas || !uh.comandas.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#adb5bd;padding:24px">
      Nenhuma comanda lançada nesta UH.</td></tr>`;
    return;
  }

  tbody.innerHTML = uh.comandas.map(c => `
    <tr data-cid="${c.id}">
      <td><input type="checkbox" class="chk-comanda" data-cid="${c.id}" ${conf[c.id] ? "checked" : ""}></td>
      <td>${c.comanda || "—"}</td>
      <td>${c.descricao}${c.cortesia ? ' <span class="tag-cortesia">CORTESIA</span>' : ''}</td>
      <td>${c.qtd}</td>
      <td><span class="pdv-badge">${c.pdv || "—"}</span></td>
      <td>R$ ${Number(c.valor).toFixed(2)}</td>
      <td>${c.data}</td>
      <td class="cel-status"></td>
    </tr>`).join("");

  tbody.querySelectorAll(".chk-comanda").forEach(chk => {
    chk.addEventListener("change", () => atualizarLinhaTr(chk.closest("tr")));
  });
  tbody.querySelectorAll("tr").forEach(atualizarLinhaTr);
}

function renderDiarias() {
  const uh = UH_ABERTA;
  const tbody = document.getElementById("tbody-diarias");

  if (!uh.diarias || !uh.diarias.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#adb5bd;padding:24px">
      Nenhuma diária faturada.</td></tr>`;
    return;
  }

  tbody.innerHTML = uh.diarias.map(d => `
    <tr>
      <td>${d.descricao}</td>
      <td>${d.qtd}</td>
      <td>R$ ${Number(d.valor).toFixed(2)}</td>
      <td>${d.data}</td>
    </tr>`).join("");
}

function atualizarLinhaTr(tr) {
  const chk = tr.querySelector(".chk-comanda");
  if (!chk) return;
  const ok = chk.checked;
  tr.classList.toggle("ok", ok);
  tr.classList.toggle("div", !ok);
  const cel = tr.querySelector(".cel-status");
  if (cel) cel.textContent = ok ? "✅ OK" : "⚠️ pendente";
}

async function salvarConferencia() {
  if (!UH_ABERTA) return;

  const comandas = {};
  document.querySelectorAll(".chk-comanda").forEach(c => comandas[c.dataset.cid] = c.checked);

  const total   = UH_ABERTA.comandas?.length || 0;
  const okCount = Object.values(comandas).filter(Boolean).length;
  const status  = total === 0 ? "ok"
                : okCount === total ? "ok"
                : okCount === 0 ? "pendente" : "divergente";

  const payload = {
    uh_id:    UH_ABERTA.id,
    status,
    comandas,
    obs:      document.getElementById("modal-obs").value,
    total,
  };

  try {
    await fetch("/api/conferencia", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    alert("Falha ao salvar: " + e.message);
    return;
  }

  CONFERENCIA[UH_ABERTA.id] = { ...payload, ts: new Date().toISOString() };

  fecharModal();
  renderGrade();
  atualizarResumo();
}

function fecharModal() {
  const modal = document.getElementById("modal");
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
}

// ============================================================
// RESUMO
// ============================================================
function atualizarResumo() {
  let ok = 0, div = 0, pend = 0, totalComandas = 0;

  UHS.forEach(u => {
    const c = CONFERENCIA[u.id];
    const total = c?.total ?? 0;
    totalComandas += total;

    if (!c || c.status === "pendente")  pend++;
    else if (c.status === "ok")         ok++;
    else if (c.status === "divergente") div++;
  });

  document.getElementById("total-uhs").textContent       = UHS.length;
  document.getElementById("total-comandas").textContent  = totalComandas;
  document.getElementById("total-ok").textContent        = ok;
  document.getElementById("total-div").textContent       = div;
  document.getElementById("total-pend").textContent      = pend;
}

// ============================================================
// BOOTSTRAP
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  // Modal começa escondido
  const modal = document.getElementById("modal");
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");

  // Fechar
  document.getElementById("modal-fechar").addEventListener("click", fecharModal);
  modal.addEventListener("click", (e) => {
    if (e.target.id === "modal") fecharModal();
  });

  // Abas
  document.querySelectorAll(".aba").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".aba").forEach(b => b.classList.remove("ativa"));
      btn.classList.add("ativa");
      const alvo = btn.dataset.aba;
      document.getElementById("painel-comandas").style.display = (alvo === "comandas") ? "" : "none";
      document.getElementById("painel-diarias").style.display  = (alvo === "diarias")  ? "" : "none";
    });
  });

  // Ações do modal
  document.getElementById("btn-marcar-todas").addEventListener("click", () => {
    document.querySelectorAll(".chk-comanda").forEach(c => c.checked = true);
    document.querySelectorAll("#tbody-comandas tr").forEach(atualizarLinhaTr);
  });
  document.getElementById("btn-desmarcar").addEventListener("click", () => {
    document.querySelectorAll(".chk-comanda").forEach(c => c.checked = false);
    document.querySelectorAll("#tbody-comandas tr").forEach(atualizarLinhaTr);
  });
  document.getElementById("btn-salvar").addEventListener("click", salvarConferencia);

  document.getElementById("modal-recarregar").addEventListener("click", () => {
    if (!UH_ABERTA || !UH_ABERTA.reserva_id) return;
    _carregarExtrato(UH_ABERTA, { forcar: true });
  });

  carregar();
});