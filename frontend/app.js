/* =====================================================================
   VexOS — configuração e acesso ao banco
   =====================================================================

   Carregado por todas as páginas. Concentra três coisas: as chaves do
   Supabase, o login, e as consultas.

   As páginas falam DIRETO com o Supabase, sem backend próprio. Quem
   protege os dados é o RLS do banco, não código intermediário: mesmo
   que alguém edite o JavaScript no navegador, não alcança dados de
   outra oficina nem escreve sem o módulo contratado.

   PREENCHER: a chave publicável, abaixo.
   ===================================================================== */

/* Versão do VexOS. Subir a cada mudança que valha registrar — aparece
   na janela "Sobre" e ajuda o suporte a saber o que o cliente tem. */
const VEXOS_VERSAO = "1.0";

const VEXOS = {
  /* Endereço do projeto no Supabase. O mesmo que o app desktop usa —
     a conta é a mesma nos dois. */
  url: "https://wouhzgugjyscqarpqtyx.supabase.co",

  /* PREENCHER com a chave publicável (sb_publishable_...).
     Pode ficar no código: é feita para viajar no navegador, e quem
     protege os dados é o RLS. Nunca ponha aqui a secret key. */
  chave: "sb_publishable_BGhB6fL4pGFYhXPAqrUIBw_hG45VMIe",
};


/* ---------------------------------------------------------------------
   Sessão

   O Supabase devolve um token de acesso, que expira, e um de renovação,
   que só serve uma vez — cada renovação devolve o próximo. Guardar o
   novo antes de descartar o antigo é o que evita derrubar a sessão do
   usuário sem motivo aparente.
   --------------------------------------------------------------------- */
const Sessao = {
  _chave: "vexos.sessao",

  ler() {
    try { return JSON.parse(localStorage.getItem(this._chave)) || null; }
    catch (e) { return null; }
  },

  gravar(s) {
    try { localStorage.setItem(this._chave, JSON.stringify(s)); }
    catch (e) { /* modo privado do navegador: segue sem lembrar */ }
  },

  limpar() {
    try { localStorage.removeItem(this._chave); } catch (e) {}
  },

  /* Renovação em curso. Toda página interna dispara várias chamadas ao
     abrir (perfil, veículo, cliente, itens, histórico), e todas passam
     por token(). Se o token estiver vencido, sem esta trava cada uma
     mandaria seu próprio refresh COM O MESMO refresh_token — que é de
     uso único. A primeira funcionaria; as outras receberiam erro e
     chamariam limpar(), derrubando a sessão sem motivo aparente. Guardar
     a promessa em curso faz as demais esperarem a MESMA renovação. */
  _renovando: null,

  /* Token válido para as chamadas. Renova em silêncio quando perto de
     vencer — quem chama não precisa saber que existe expiração. */
  async token() {
    const s = this.ler();
    if (!s || !s.access_token) return null;
    if (Date.now() < (s.expira_em || 0) - 60000) return s.access_token;

    /* Já tem um refresh a caminho: espera ele, não abre outro. */
    if (this._renovando) return this._renovando;

    this._renovando = this._renovar(s)
      .finally(() => { this._renovando = null; });
    return this._renovando;
  },

  /* O refresh em si, isolado para a trava acima poder memorizá-lo.
     Devolve o novo access_token, ou null se a renovação falhou. */
  async _renovar(s) {
    let r;
    try {
      r = await fetch(
        `${VEXOS.url}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { apikey: VEXOS.chave, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: s.refresh_token }),
        });
    } catch (e) {
      /* Rede caiu no meio: NÃO limpa a sessão. Sem internet o refresh
         falha, mas o refresh_token continua válido — apagar aqui
         deslogaria quem só está momentaneamente offline. */
      return null;
    }
    if (!r.ok) { this.limpar(); return null; }

    let d;
    try { d = await r.json(); } catch (e) { return null; }
    if (!d.access_token) { this.limpar(); return null; }

    this.gravar({
      email: s.email,
      access_token: d.access_token,
      refresh_token: d.refresh_token || s.refresh_token,
      expira_em: Date.now() + (d.expires_in || 3600) * 1000,
    });
    return d.access_token;
  },
};


/* ---------------------------------------------------------------------
   Conversa com o banco
   --------------------------------------------------------------------- */
const Banco = {
  /* Chamada autenticada. Devolve os dados ou lança um erro com
     mensagem já pronta para a tela. */
  async pedir(caminho, opcoes = {}) {
    const token = await Sessao.token();
    if (!token) { irParaLogin(); throw new Error("Sessão expirada."); }

    const r = await fetch(VEXOS.url + caminho, {
      method: opcoes.metodo || "GET",
      headers: {
        apikey: VEXOS.chave,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        /* representation faz o banco devolver a linha gravada — sem
           isso, um insert responde vazio e a tela não sabe o id. */
        ...(opcoes.metodo && opcoes.metodo !== "GET"
            ? { Prefer: "return=representation" } : {}),
        ...(opcoes.headers || {}),
      },
      body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
    });

    if (r.status === 401) { Sessao.limpar(); irParaLogin(); throw new Error("Sessão expirada."); }

    if (!r.ok) {
      let detalhe = "";
      try { detalhe = (await r.json()).message || ""; } catch (e) {}
      /* 403 aqui quase sempre é o RLS recusando: ou o módulo não está
         contratado, ou a assinatura venceu. Dizer "erro 403" não ajuda
         ninguém. */
      if (r.status === 403 || /row-level security/i.test(detalhe)) {
        throw new Error("Sem permissão. Verifique se o módulo VexOS está "
                      + "ativo na sua assinatura.");
      }
      throw new Error(detalhe || `O servidor respondeu ${r.status}.`);
    }

    if (r.status === 204) return null;
    const texto = await r.text();
    return texto ? JSON.parse(texto) : null;
  },

  listar(tabela, consulta = "") {
    return this.pedir(`/rest/v1/${tabela}${consulta ? "?" + consulta : ""}`);
  },

  async criar(tabela, dados) {
    const r = await this.pedir(`/rest/v1/${tabela}`,
                               { metodo: "POST", corpo: dados });
    return Array.isArray(r) ? r[0] : r;
  },

  async atualizar(tabela, id, dados) {
    const r = await this.pedir(`/rest/v1/${tabela}?id=eq.${id}`,
                               { metodo: "PATCH", corpo: dados });
    return Array.isArray(r) ? r[0] : r;
  },

  apagar(tabela, id) {
    return this.pedir(`/rest/v1/${tabela}?id=eq.${id}`, { metodo: "DELETE" });
  },

  chamar(funcao, args = {}) {
    return this.pedir(`/rest/v1/rpc/${funcao}`,
                      { metodo: "POST", corpo: args });
  },
};


/* ---------------------------------------------------------------------
   Login
   --------------------------------------------------------------------- */
async function entrar(email, senha) {
  /* A chave não foi preenchida: o erro seria de credencial, e a pessoa
     passaria horas testando senha. */
  if (!VEXOS.chave || VEXOS.chave.startsWith("COLE_AQUI")) {
    throw new Error("O sistema não está configurado: falta a chave do "
                  + "Supabase no app.js. Fale com o suporte.");
  }

  let r, d;
  try {
    r = await fetch(`${VEXOS.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: VEXOS.chave, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password: senha }),
    });
  } catch (e) {
    throw new Error("Não foi possível falar com o servidor. Verifique sua "
                  + "conexão.");
  }

  try { d = await r.json(); } catch (e) { d = {}; }

  if (!r.ok || !d.access_token) {
    /* Cada recusa tem um motivo diferente, e tratar todas como "senha
       errada" faz a pessoa procurar no lugar errado. O Supabase manda
       o motivo em error_code ou na mensagem — repassamos traduzido. */
    const codigo = (d.error_code || d.error || "").toString();
    const texto  = (d.msg || d.error_description || d.message || "").toString();

    if (r.status === 401 && /invalid api key|no api key/i.test(texto)) {
      throw new Error("A chave configurada não é válida para este projeto "
                    + "do Supabase.");
    }
    if (/email_not_confirmed|not confirmed/i.test(codigo + texto)) {
      throw new Error("Este e-mail ainda não foi confirmado. No painel do "
                    + "Supabase, marque o usuário como confirmado.");
    }
    if (/invalid_credentials|invalid login/i.test(codigo + texto)) {
      throw new Error("E-mail ou senha incorretos.");
    }
    if (r.status === 429 || /rate|too many/i.test(codigo + texto)) {
      throw new Error("Muitas tentativas seguidas. Espere um minuto e "
                    + "tente de novo.");
    }
    if (r.status >= 500) {
      throw new Error("O servidor de autenticação respondeu com erro "
                    + r.status + ". Tente novamente em instantes.");
    }
    /* Não reconhecido: mostra o que veio, em vez de inventar um
       diagnóstico. É melhor uma mensagem estranha e verdadeira do que
       uma clara e errada. */
    throw new Error(texto
      ? `Não foi possível entrar (${r.status}): ${texto}`
      : `Não foi possível entrar. O servidor respondeu ${r.status}.`);
  }

  Sessao.gravar({
    email: email.trim().toLowerCase(),
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expira_em: Date.now() + (d.expires_in || 3600) * 1000,
  });
}

function sair() {
  Sessao.limpar();
  irParaLogin();
}

function irParaLogin() {
  if (!location.pathname.endsWith("index.html") && location.pathname !== "/") {
    location.href = "index.html";
  }
}

/* Chamado no topo de toda página interna. Devolve os dados da oficina
   ou manda para o login. */
async function exigirSessao() {
  const s = Sessao.ler();
  if (!s || !s.refresh_token) { irParaLogin(); return null; }

  try {
    const perfis = await Banco.listar("perfis",
      "select=nome,papel,oficina_id,oficinas(nome,status,validade,modulos)");
    const p = perfis && perfis[0];
    if (!p) {
      alert("Sua conta não está vinculada a nenhuma oficina. Fale com o suporte.");
      sair();
      return null;
    }
    const of = Array.isArray(p.oficinas) ? p.oficinas[0] : p.oficinas;
    return {
      email: s.email, nome: p.nome, papel: p.papel,
      oficina_id: p.oficina_id,
      oficina: (of && of.nome) || "",
      modulos: (of && of.modulos) || [],
      validade: (of && of.validade) || "",
      status: (of && of.status) || "",
      temVexOS: ((of && of.modulos) || []).includes("vexos"),
    };
  } catch (e) {
    irParaLogin();
    return null;
  }
}


/* ---------------------------------------------------------------------
   Menu de conta no topo

   Uma função só, usada por todas as páginas: repetir esse HTML em cada
   uma faria a próxima mudança ter que ser feita seis vezes.
   --------------------------------------------------------------------- */
const PAPEL = {
  admin: "Administrador", dono: "Dono",
  tecnico: "Técnico", atendente: "Atendente",
};

function montarMenuConta(ctx) {
  const alvo = document.getElementById("conta");
  if (!alvo || !ctx) return;

  const nome = ctx.oficina || ctx.email || "";
  const inicial = (nome.trim()[0] || "?").toUpperCase();

  alvo.innerHTML = `
    <button class="conta-botao" id="conta-botao" aria-haspopup="true"
            aria-expanded="false">
      <span class="conta-inicial">${esc(inicial)}</span>
      <span class="conta-nome">${esc(nome)}</span>
      <svg class="conta-seta" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="conta-menu" id="conta-menu" role="menu">
      <div class="conta-cabeca">
        <b>${esc(ctx.nome || nome)}</b>
        <span>${esc(ctx.email || "")}</span>
        ${ctx.papel ? `<span class="conta-papel">${esc(PAPEL[ctx.papel] || ctx.papel)}</span>` : ""}
      </div>
      <button class="conta-item" role="menuitem" id="conta-vextron">
        <svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8"/><path d="M9 2.5v2.5M15 2.5v2.5M9 19v2.5M15 19v2.5M2.5 9h2.5M2.5 15h2.5M19 9h2.5M19 15h2.5"/></svg>
        Sobre o VexOS
      </button>
      <button class="conta-item" role="menuitem" id="conta-suporte">
        <svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-3.3A8.4 8.4 0 1 1 21 11.5z"/></svg>
        Suporte
      </button>
      <button class="conta-item sair" role="menuitem" id="conta-sair">
        <svg viewBox="0 0 24 24"><path d="M15 17l5-5-5-5M20 12H9M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5"/></svg>
        Sair
      </button>
    </div>`;

  const botao = document.getElementById("conta-botao");
  const menu = document.getElementById("conta-menu");

  function alternar(abrir) {
    const vai = abrir === undefined ? !menu.classList.contains("aberto") : abrir;
    menu.classList.toggle("aberto", vai);
    botao.classList.toggle("aberto", vai);
    botao.setAttribute("aria-expanded", vai ? "true" : "false");
  }

  botao.addEventListener("click", e => { e.stopPropagation(); alternar(); });

  /* Fecha ao clicar fora e no Esc: menu que só fecha no próprio botão
     fica preso na frente do conteúdo. */
  document.addEventListener("click", e => {
    if (!menu.contains(e.target)) alternar(false);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") alternar(false);
  });

  document.getElementById("conta-sair").addEventListener("click", sair);
  document.getElementById("conta-suporte").addEventListener("click", () => {
    window.open("https://wa.me/553584111984?text=" +
      encodeURIComponent("Olá, preciso de ajuda com o VexOS"), "_blank");
  });
  document.getElementById("conta-vextron").addEventListener("click", () => {
    alternar(false);
    mostrarSobre(ctx);
  });
}


/* ---------------------------------------------------------------------
   Janela "Sobre"

   O item antigo abria a página de vendas do Vextron — que não diz nada
   sobre o VexOS nem sobre a assinatura de quem já está dentro. Esta
   janela responde o que o cliente logado quer saber: o que é, até
   quando a assinatura vale, e como pedir ajuda.
   --------------------------------------------------------------------- */
function mostrarSobre(ctx) {
  const anterior = document.getElementById("modal-sobre");
  if (anterior) anterior.remove();

  /* Validade em dias: "vence em 8 dias" diz mais que uma data que a
     pessoa teria que comparar com hoje de cabeça. */
  let validadeTexto = "";
  if (ctx && ctx.validade) {
    const fim = new Date(ctx.validade);
    const dias = Math.ceil((fim - new Date()) / 86400000);
    const data = fim.toLocaleDateString("pt-BR");
    if (dias < 0)        validadeTexto = `Vencida em ${data}`;
    else if (dias === 0) validadeTexto = `Vence hoje (${data})`;
    else if (dias <= 15) validadeTexto = `Vence em ${dias} dia(s) · ${data}`;
    else                 validadeTexto = `Ativa até ${data}`;
  }

  const fundo = document.createElement("div");
  fundo.className = "modal-fundo";
  fundo.id = "modal-sobre";
  fundo.innerHTML = `
    <div class="modal" style="width:min(440px,100%); text-align:center;">
      <div class="sobre-marca">
        <span class="sobre-barra"></span>
        <span class="sobre-nome">Vex<b>OS</b></span>
      </div>
      <div class="sobre-versao">Versão ${esc(VEXOS_VERSAO)}</div>

      <p class="sobre-texto">
        Controle de ordens de serviço integrado ao Motronix Vextron.
        Registre o que foi feito em cada veículo e consulte o histórico
        por placa — inclusive as análises de ECU feitas no aplicativo.
      </p>

      <div class="sobre-ficha">
        <div><span>Oficina</span><b>${esc(ctx.oficina || "—")}</b></div>
        <div><span>Você</span><b>${esc(ctx.nome || ctx.email || "—")}</b></div>
        ${validadeTexto ? `<div><span>Assinatura</span><b>${esc(validadeTexto)}</b></div>` : ""}
      </div>

      <div class="modal-acoes" style="justify-content:center;">
        <button class="btn-linha btn" id="sobre-suporte">Falar com o suporte</button>
        <button class="btn" id="sobre-fechar">Fechar</button>
      </div>
    </div>`;
  document.body.appendChild(fundo);

  const fechar = () => fundo.remove();
  document.getElementById("sobre-fechar").addEventListener("click", fechar);
  fundo.addEventListener("click", e => { if (e.target === fundo) fechar(); });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { fechar(); document.removeEventListener("keydown", esc); }
  });
  document.getElementById("sobre-suporte").addEventListener("click", () => {
    window.open("https://wa.me/553584111984?text=" +
      encodeURIComponent("Olá, preciso de ajuda com o VexOS"), "_blank");
  });
}


/* ---------------------------------------------------------------------
   Utilidades da interface
   --------------------------------------------------------------------- */

/* Escapa antes de jogar em innerHTML. Nome de cliente com < ou &
   quebraria a página — e um campo de texto é por onde entra script
   indesejado. */
function esc(t) {
  return String(t === null || t === undefined ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dataBR(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR") + " " +
         d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function soData(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("pt-BR");
}

function dinheiro(v) {
  if (v === null || v === undefined || v === "") return "";
  return Number(v).toLocaleString("pt-BR",
    { style: "currency", currency: "BRL" });
}

/* Placas brasileiras nos dois formatos: ABC1234 e ABC1D23. Guardamos
   sempre sem hífen e em maiúscula, senão a mesma placa entra duas vezes
   e o histórico do carro fica partido em dois registros. */
function normalizarPlaca(p) {
  return String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7);
}

function formatarPlaca(p) {
  const s = normalizarPlaca(p);
  return s.length === 7 ? s.slice(0, 3) + "-" + s.slice(3) : s;
}

const STATUS_OS = {
  aberta:     { texto: "Aberta",       cor: "aberta" },
  andamento:  { texto: "Em andamento", cor: "andamento" },
  concluida:  { texto: "Concluída",    cor: "concluida" },
  cancelada:  { texto: "Cancelada",    cor: "cancelada" },
};

function aviso(elemento, mensagem, tipo) {
  if (!elemento) return;
  elemento.className = "aviso " + (tipo || "");
  elemento.textContent = mensagem;
  elemento.style.display = mensagem ? "block" : "none";
}
