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

  /* Token válido para as chamadas. Renova em silêncio quando perto de
     vencer — quem chama não precisa saber que existe expiração. */
  async token() {
    const s = this.ler();
    if (!s || !s.access_token) return null;
    if (Date.now() < (s.expira_em || 0) - 60000) return s.access_token;

    const r = await fetch(
      `${VEXOS.url}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: VEXOS.chave, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
    if (!r.ok) { this.limpar(); return null; }

    const d = await r.json();
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
      temVexOS: ((of && of.modulos) || []).includes("vexos"),
    };
  } catch (e) {
    irParaLogin();
    return null;
  }
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
